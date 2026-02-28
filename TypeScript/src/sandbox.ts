/**
 * sandbox.ts — Multi-layered security sandbox inspired by Claude Code's architecture.
 *
 * Features:
 * - 4-tier permission system: safe → moderate → dangerous → critical
 * - Auto-allow list for safe commands (npm test, git status, ls, etc.)
 * - Command risk analysis with categorized patterns
 * - dangerouslyDisableSandbox escape hatch
 * - Permission decision tracking with audit log
 * - Filesystem access control
 * - Resource limits (timeout, output truncation)
 */

import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Permission Levels
// ---------------------------------------------------------------------------

export type PermissionLevel = 'safe' | 'moderate' | 'dangerous' | 'critical';
export type RiskLevel = 'safe' | 'low' | 'moderate' | 'high' | 'critical';
export type DecisionBehavior = 'allow' | 'ask' | 'deny';

// ---------------------------------------------------------------------------
// Command Analysis
// ---------------------------------------------------------------------------

export interface CommandAnalysis {
    isDangerous: boolean;
    riskLevel: RiskLevel;
    matchedPatterns: string[];
    requiresConfirmation: boolean;
    message?: string;
}

// ---------------------------------------------------------------------------
// Permission Decision
// ---------------------------------------------------------------------------

export interface DecisionWarning {
    level: RiskLevel;
    title: string;
    message: string;
}

export interface DecisionReason {
    type: 'rule' | 'auto-allow' | 'user-config' | 'sandbox-disabled';
    reason?: string;
    patterns?: string[];
    riskLevel?: RiskLevel;
    toolLevel?: PermissionLevel;
    userPermission?: PermissionLevel;
}

export class PermissionDecision {
    readonly behavior: DecisionBehavior;
    readonly message: string;
    readonly decisionReason: DecisionReason;
    readonly warning?: DecisionWarning;

    constructor(opts: {
        behavior: DecisionBehavior;
        message?: string;
        decisionReason?: DecisionReason;
        warning?: DecisionWarning;
    }) {
        this.behavior = opts.behavior;
        this.message = opts.message ?? '';
        this.decisionReason = opts.decisionReason ?? { type: 'rule' };
        this.warning = opts.warning;
    }

    static allow(message = ''): PermissionDecision {
        return new PermissionDecision({ behavior: 'allow', message });
    }

    static ask(opts: {
        message?: string;
        decisionReason?: DecisionReason;
        warning?: DecisionWarning;
    } = {}): PermissionDecision {
        return new PermissionDecision({
            behavior: 'ask',
            message: opts.message ?? 'Operation requires confirmation',
            decisionReason: opts.decisionReason,
            warning: opts.warning,
        });
    }

    static deny(opts: {
        message?: string;
        decisionReason?: DecisionReason;
    } = {}): PermissionDecision {
        return new PermissionDecision({
            behavior: 'deny',
            message: opts.message ?? 'Operation not permitted',
            decisionReason: opts.decisionReason,
        });
    }

    toJSON(): Record<string, any> {
        return {
            behavior: this.behavior,
            message: this.message,
            decisionReason: this.decisionReason,
            warning: this.warning,
        };
    }
}

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------

export interface AuditEntry {
    tool: string;
    command?: string;
    decision: DecisionBehavior;
    reason: DecisionReason;
    riskLevel?: RiskLevel;
    matchedPatterns?: string[];
    timestamp: string;
    durationMs: number;
}

export class AuditLog {
    private _entries: AuditEntry[] = [];
    private _maxEntries: number;

    constructor(maxEntries = 10_000) {
        this._maxEntries = maxEntries;
    }

    record(entry: AuditEntry): void {
        this._entries.push(entry);
        if (this._entries.length > this._maxEntries) {
            this._entries = this._entries.slice(-Math.floor(this._maxEntries / 2));
        }
    }

    getLog(filters?: {
        tool?: string;
        startDate?: Date;
        endDate?: Date;
        behavior?: DecisionBehavior;
    }): AuditEntry[] {
        let log = this._entries;
        if (filters?.tool) log = log.filter((e) => e.tool === filters.tool);
        if (filters?.behavior) log = log.filter((e) => e.decision === filters.behavior);
        if (filters?.startDate) {
            const t = filters.startDate.getTime();
            log = log.filter((e) => new Date(e.timestamp).getTime() >= t);
        }
        if (filters?.endDate) {
            const t = filters.endDate.getTime();
            log = log.filter((e) => new Date(e.timestamp).getTime() <= t);
        }
        return log;
    }

    get summary() {
        return {
            total: this._entries.length,
            allowed: this._entries.filter((e) => e.decision === 'allow').length,
            asked: this._entries.filter((e) => e.decision === 'ask').length,
            denied: this._entries.filter((e) => e.decision === 'deny').length,
        };
    }

    clear(): void {
        this._entries = [];
    }
}

// ---------------------------------------------------------------------------
// SandboxConfig
// ---------------------------------------------------------------------------

export interface SandboxConfig {
    /** Master switch. Default: true. */
    enabled?: boolean;

    /** If true, bypass ALL sandbox protections. Always requires user confirmation. */
    dangerouslyDisableSandbox?: boolean;

    // --- Filesystem ---
    allowedPaths?: string[];
    deniedPaths?: string[];
    allowReadOutsideSandbox?: boolean;

    // --- Permissions ---
    /** Default permission level for unknown tools. Default: 'moderate'. */
    defaultPermission?: PermissionLevel;
    /** Per-tool permission overrides. */
    toolPermissions?: Record<string, PermissionLevel>;

    // --- Command filtering ---
    blockedCommands?: string[];
    blockedPatterns?: (RegExp | string)[];
    allowedCommands?: string[];

    // --- Resource limits ---
    maxExecutionMs?: number;
    maxOutputChars?: number;
    /** Hard timeout ceiling (cannot be exceeded even by config). Default: 600000 (10min). */
    maxTimeoutCeiling?: number;

    // --- Network / environment ---
    allowNetwork?: boolean;
    allowEnvPassthrough?: boolean;
    allowedEnvVars?: string[];

    // --- Callbacks ---
    onViolation?: 'error' | 'warn' | 'silent';
}

// ---------------------------------------------------------------------------
// Dangerous Pattern Definitions (Categorized)
// ---------------------------------------------------------------------------

interface DangerousPattern {
    name: string;
    regex: RegExp;
    severity: RiskLevel;
    category: 'data-loss' | 'privilege-escalation' | 'remote-code-exec' | 'exfiltration' | 'process' | 'system';
    message: string;
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
    // -- Data Loss --
    { name: 'force-remove', regex: /\brm\s+(-rf?|-fr?|-.*f)\b/, severity: 'critical', category: 'data-loss', message: 'Force deletion detected' },
    { name: 'recursive-remove-root', regex: /\brm\s+.*\/\s*$/, severity: 'critical', category: 'data-loss', message: 'Root directory removal detected' },
    { name: 'disk-wipe', regex: /\bdd\s+.*of=\/\w/, severity: 'critical', category: 'data-loss', message: 'Disk wipe operation detected' },
    { name: 'mkfs', regex: /\bmkfs\b/, severity: 'critical', category: 'data-loss', message: 'Filesystem format detected' },
    { name: 'destructive-chmod', regex: /chmod\s+-R\s+777\s+\//, severity: 'high', category: 'data-loss', message: 'Recursive permission change on root' },
    { name: 'destructive-chown', regex: /chown\s+-R\s/, severity: 'moderate', category: 'data-loss', message: 'Recursive ownership change detected' },

    // -- Privilege Escalation --
    { name: 'sudo', regex: /\bsudo\b/, severity: 'high', category: 'privilege-escalation', message: 'Privilege escalation (sudo) detected' },
    { name: 'su', regex: /\bsu\s/, severity: 'high', category: 'privilege-escalation', message: 'Privilege escalation (su) detected' },
    { name: 'doas', regex: /\bdoas\b/, severity: 'high', category: 'privilege-escalation', message: 'Privilege escalation (doas) detected' },

    // -- Remote Code Execution --
    { name: 'curl-pipe-bash', regex: /\bcurl\s.*\|\s*(ba)?sh/, severity: 'critical', category: 'remote-code-exec', message: 'Remote code execution: curl | sh' },
    { name: 'wget-pipe-bash', regex: /\bwget\s.*\|\s*(ba)?sh/, severity: 'critical', category: 'remote-code-exec', message: 'Remote code execution: wget | sh' },
    { name: 'pipe-to-shell', regex: /\|\s*(sh|bash|zsh|fish|pwsh)\s*$/, severity: 'critical', category: 'remote-code-exec', message: 'Pipe to shell detected' },
    { name: 'eval-curl', regex: /eval\s*\$?\(?curl/, severity: 'critical', category: 'remote-code-exec', message: 'Eval of remote content detected' },
    { name: 'dev-tcp', regex: /\/dev\/tcp/, severity: 'critical', category: 'remote-code-exec', message: '/dev/tcp connection detected' },
    { name: 'fork-bomb', regex: /:\(\)\{.*\|.*&\}/, severity: 'critical', category: 'remote-code-exec', message: 'Fork bomb detected' },

    // -- Data Exfiltration --
    { name: 'curl-data', regex: /\bcurl\s+.*--data/, severity: 'high', category: 'exfiltration', message: 'Data exfiltration via curl detected' },
    { name: 'netcat', regex: /\b(nc|ncat|netcat)\s+/, severity: 'high', category: 'exfiltration', message: 'Netcat connection detected' },
    { name: 'telnet', regex: /\btelnet\s+/, severity: 'high', category: 'exfiltration', message: 'Telnet connection detected' },

    // -- Process Manipulation --
    { name: 'kill-force', regex: /\bkill\s+-9\b/, severity: 'moderate', category: 'process', message: 'Force kill detected' },
    { name: 'killall', regex: /\b(pkill|killall)\b/, severity: 'moderate', category: 'process', message: 'Process kill-all detected' },

    // -- System --
    { name: 'shutdown', regex: /\b(shutdown|reboot|halt|poweroff)\b/, severity: 'critical', category: 'system', message: 'System power operation detected' },
    { name: 'init', regex: /\binit\s+[06]\b/, severity: 'critical', category: 'system', message: 'Init level change detected' },
    { name: 'systemctl', regex: /\bsystemctl\b/, severity: 'moderate', category: 'system', message: 'Systemctl usage detected' },
    { name: 'launchctl', regex: /\blaunchctl\b/, severity: 'moderate', category: 'system', message: 'Launchctl usage detected' },
    { name: 'npm-publish', regex: /\bnpm\s+(publish|login|adduser)\b/, severity: 'high', category: 'system', message: 'npm publish/auth detected' },
    { name: 'global-install', regex: /\b(npm\s+(install|i)\s+(-g|--global)|pip\s+install)/, severity: 'moderate', category: 'system', message: 'Global package installation detected' },
];

// ---------------------------------------------------------------------------
// Auto-Allow List (Safe Commands)
// ---------------------------------------------------------------------------

const AUTO_ALLOW_PATTERNS: RegExp[] = [
    // Build & dev tools
    /^npm\s+(test|run|build|lint|check|audit|outdated)\s*$/,
    /^npm\s+run\s+[a-zA-Z0-9_:.-]+$/,
    /^npx\s+tsc(\s+--noEmit)?\s*$/,
    /^(yarn|pnpm)\s+(test|build|lint|dev)\s*$/,

    // Git read-only
    /^git\s+(status|log|diff|branch|show|rev-parse|blame|tag|remote)\s*$/,
    /^git\s+(log|diff|show|blame)\s+/,
    /^git\s+status\s+/,

    // File inspection
    /^ls(\s+[-\w./]*)*$/,
    /^cat\s+[\w\-./\s]+$/,
    /^(head|tail)(\s+[-\d\w]*)?\s*[\w\-./]*$/,
    /^wc(\s+[-\w]*)?\s+[\w\-./]+$/,
    /^file\s+[\w\-./]+$/,
    /^find\s+[\w\-./]+(\s+-name\s+[\w*".]+)?(\s+-type\s+\w)?$/,

    // System information
    /^(pwd|whoami|uname|id|hostname|date|uptime)\s*$/,
    /^(uname|id)\s+[-\w]*$/,
    /^(env|printenv)\s*$/,

    // Version checks
    /^(node|python3?|java|go|rustc|cargo|ruby|php)\s+(--version|-v|-V|version)\s*$/,

    // Development tools
    /^(make|cmake|cargo|go)\s+(build|test|check|run|version)\s*$/,
    /^(eslint|prettier|black|ruff|flake8|mypy)\s+[\w\-./]+$/,
    /^(pytest|jest|vitest|mocha|cargo\s+test)\s*$/,
    /^(pytest|jest|vitest|mocha)\s+[\w\-./]+$/,

    // Directory navigation
    /^(mkdir|rmdir)\s+[\w\-./]+$/,
    /^(touch|stat)\s+[\w\-./]+$/,

    // grep / search (read-only)
    /^(grep|rg|ag|ack)\s+/,
    /^echo\s+/,
];

// ---------------------------------------------------------------------------
// Default denied paths
// ---------------------------------------------------------------------------

const DEFAULT_DENIED_PATHS = [
    '/etc/shadow',
    '/etc/passwd',
    path.join(os.homedir(), '.ssh'),
    path.join(os.homedir(), '.gnupg'),
    path.join(os.homedir(), '.aws', 'credentials'),
    '/var/run/docker.sock',
];

const SAFE_ENV_VARS = new Set([
    'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
    'NODE_ENV', 'TZ', 'EDITOR', 'VISUAL',
]);

// ---------------------------------------------------------------------------
// Tool → PermissionLevel defaults
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_LEVELS: Record<string, PermissionLevel> = {
    // Safe: read-only
    read_file: 'safe',
    grep: 'safe',
    Skill: 'safe',
    TodoWrite: 'safe',

    // Moderate: file modifications
    write_file: 'moderate',
    edit_file: 'moderate',

    // Dangerous: arbitrary execution / network
    bash: 'dangerous',
    WebSearch: 'dangerous',
    WebFetch: 'dangerous',
};

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export class Sandbox {
    private _enabled: boolean;
    private _dangerouslyDisabled: boolean;
    private _allowedPaths: string[];
    private _deniedPaths: string[];
    private _allowReadOutside: boolean;
    private _defaultPermission: PermissionLevel;
    private _toolPermissions: Record<string, PermissionLevel>;
    private _blockedCommands: string[];
    private _blockedPatterns: DangerousPattern[];
    private _customBlockedPatterns: RegExp[];
    private _allowedCommands: string[] | null;
    private _maxExecutionMs: number;
    private _maxOutputChars: number;
    private _maxTimeoutCeiling: number;
    private _allowNetwork: boolean;
    private _allowEnvPassthrough: boolean;
    private _allowedEnvVars: Set<string>;
    private _onViolation: 'error' | 'warn' | 'silent';
    readonly audit: AuditLog;

    constructor(config?: SandboxConfig) {
        this._dangerouslyDisabled = config?.dangerouslyDisableSandbox ?? false;
        this._enabled = this._dangerouslyDisabled ? false : (config?.enabled ?? true);
        this._allowedPaths = (config?.allowedPaths ?? [process.cwd()]).map((p) => path.resolve(p));
        this._deniedPaths = [...DEFAULT_DENIED_PATHS, ...(config?.deniedPaths ?? [])].map((p) => path.resolve(p));
        this._allowReadOutside = config?.allowReadOutsideSandbox ?? false;
        this._defaultPermission = config?.defaultPermission ?? 'moderate';
        this._toolPermissions = { ...DEFAULT_TOOL_LEVELS, ...(config?.toolPermissions ?? {}) };
        this._blockedCommands = config?.blockedCommands ?? [];
        this._blockedPatterns = DANGEROUS_PATTERNS;
        this._customBlockedPatterns = (config?.blockedPatterns ?? []).map((p) => (typeof p === 'string' ? new RegExp(p) : p));
        this._allowedCommands = config?.allowedCommands ?? null;
        this._maxTimeoutCeiling = config?.maxTimeoutCeiling ?? 600_000;
        this._maxExecutionMs = Math.min(config?.maxExecutionMs ?? 120_000, this._maxTimeoutCeiling);
        this._maxOutputChars = config?.maxOutputChars ?? 50_000;
        this._allowNetwork = config?.allowNetwork ?? true;
        this._allowEnvPassthrough = config?.allowEnvPassthrough ?? false;
        this._allowedEnvVars = new Set([...SAFE_ENV_VARS, ...(config?.allowedEnvVars ?? [])]);
        this._onViolation = config?.onViolation ?? 'error';
        this.audit = new AuditLog();
    }

    get enabled(): boolean { return this._enabled; }
    get isDangerouslyDisabled(): boolean { return this._dangerouslyDisabled; }
    get maxExecutionMs(): number { return this._maxExecutionMs; }
    get maxOutputChars(): number { return this._maxOutputChars; }

    // --- Permission check (top-level entry point) ---

    /**
     * Check permission for a tool invocation.
     * Returns a PermissionDecision: allow / ask / deny.
     */
    checkPermission(
        tool: string,
        params: Record<string, any> = {},
    ): PermissionDecision {
        const start = Date.now();

        // 1. If sandbox is dangerously disabled — always ask
        if (this._dangerouslyDisabled) {
            const decision = PermissionDecision.ask({
                message: '⚠️  Sandbox disabled — command will execute with full system access',
                decisionReason: { type: 'sandbox-disabled', reason: 'dangerouslyDisableSandbox' },
                warning: {
                    level: 'critical',
                    title: 'Sandbox Disabled',
                    message: 'This operation bypasses all sandbox protections',
                },
            });
            this._log(tool, params.command, decision, start);
            return decision;
        }

        // 2. If sandbox not enabled — allow everything
        if (!this._enabled) {
            const decision = PermissionDecision.allow('Sandbox not enabled');
            this._log(tool, params.command, decision, start);
            return decision;
        }

        // 3. Get tool permission level
        const toolLevel = this._toolPermissions[tool] ?? this._defaultPermission;

        // 4. Safe tools — auto-allow
        if (toolLevel === 'safe') {
            const decision = PermissionDecision.allow('Safe tool — auto-allowed');
            this._log(tool, params.command, decision, start);
            return decision;
        }

        // 5. Bash tool — deep analysis
        if (tool === 'bash' && params.command) {
            const analysis = this.analyzeCommand(params.command);

            // Auto-allow listed safe commands
            if (!analysis.isDangerous && !analysis.requiresConfirmation) {
                const decision = PermissionDecision.allow('Command approved by auto-allow list');
                this._log(tool, params.command, decision, start, analysis);
                return decision;
            }

            // Dangerous pattern — deny in sandbox
            if (analysis.isDangerous) {
                const decision = PermissionDecision.deny({
                    message: `Dangerous command blocked: ${analysis.matchedPatterns.join(', ')}`,
                    decisionReason: {
                        type: 'rule',
                        reason: 'dangerous-pattern',
                        patterns: analysis.matchedPatterns,
                        riskLevel: analysis.riskLevel,
                    },
                });
                this._log(tool, params.command, decision, start, analysis);
                return decision;
            }

            // Unknown command — ask
            const decision = PermissionDecision.ask({
                message: 'Command requires confirmation in sandbox mode',
                decisionReason: { type: 'rule', reason: 'unknown-command' },
            });
            this._log(tool, params.command, decision, start, analysis);
            return decision;
        }

        // 6. File tools — check path
        if (['read_file', 'grep'].includes(tool) && params.path) {
            const pathCheck = this.checkPath(params.path, 'read');
            if (!pathCheck.allowed) {
                const decision = PermissionDecision.deny({
                    message: pathCheck.reason,
                    decisionReason: { type: 'rule', reason: 'path-denied' },
                });
                this._log(tool, undefined, decision, start);
                return decision;
            }
        }
        if (['write_file', 'edit_file'].includes(tool) && params.path) {
            const pathCheck = this.checkPath(params.path, 'write');
            if (!pathCheck.allowed) {
                const decision = PermissionDecision.deny({
                    message: pathCheck.reason,
                    decisionReason: { type: 'rule', reason: 'path-denied' },
                });
                this._log(tool, undefined, decision, start);
                return decision;
            }
        }

        // 7. Web tools — network permission check
        if (['WebSearch', 'WebFetch'].includes(tool)) {
            if (!this._allowNetwork) {
                const decision = PermissionDecision.deny({
                    message: '[Sandbox] Network access denied for web tools',
                    decisionReason: { type: 'rule', reason: 'network-blocked' },
                });
                this._log(tool, undefined, decision, start);
                return decision;
            }
            // Network allowed — ask for confirmation (dangerous tool)
            const decision = PermissionDecision.ask({
                message: `${tool} requires network access confirmation`,
                decisionReason: { type: 'rule', reason: 'network-tool' },
            });
            this._log(tool, undefined, decision, start);
            return decision;
        }

        // 8. Moderate tools — allow (user configured)
        const decision = PermissionDecision.allow('Permitted by permission level');
        this._log(tool, params.command, decision, start);
        return decision;
    }

    // --- Command analysis ---

    analyzeCommand(command: string): CommandAnalysis {
        const trimmed = command.trim();
        const analysis: CommandAnalysis = {
            isDangerous: false,
            riskLevel: 'safe',
            matchedPatterns: [],
            requiresConfirmation: false,
        };

        // 1. Check auto-allow list first
        if (AUTO_ALLOW_PATTERNS.some((p) => p.test(trimmed))) {
            return analysis; // safe, no confirmation
        }

        // 2. Allowlist mode — only permitted prefixes pass
        if (this._allowedCommands !== null) {
            const matched = this._allowedCommands.some((prefix) => trimmed.startsWith(prefix));
            if (!matched) {
                analysis.isDangerous = true;
                analysis.riskLevel = 'high';
                analysis.matchedPatterns.push('not-in-allowlist');
                analysis.requiresConfirmation = true;
                analysis.message = `Command not in allowlist: "${trimmed.slice(0, 60)}"`;
                return analysis;
            }
        }

        // 3. Check categorized dangerous patterns
        for (const pattern of this._blockedPatterns) {
            if (pattern.regex.test(trimmed)) {
                analysis.isDangerous = true;
                analysis.matchedPatterns.push(pattern.name);
                analysis.message = pattern.message;
                // Take highest severity
                if (RISK_ORDER[pattern.severity] > RISK_ORDER[analysis.riskLevel]) {
                    analysis.riskLevel = pattern.severity;
                }
            }
        }

        // 4. Check custom blocked patterns
        for (const pattern of this._customBlockedPatterns) {
            if (pattern.test(trimmed)) {
                analysis.isDangerous = true;
                analysis.matchedPatterns.push(`custom:${pattern.source}`);
                if (RISK_ORDER['high'] > RISK_ORDER[analysis.riskLevel]) {
                    analysis.riskLevel = 'high';
                }
            }
        }

        // 5. Check substring blocklist
        for (const blocked of this._blockedCommands) {
            if (trimmed.includes(blocked)) {
                analysis.isDangerous = true;
                analysis.matchedPatterns.push(`blocked:"${blocked}"`);
                if (RISK_ORDER['high'] > RISK_ORDER[analysis.riskLevel]) {
                    analysis.riskLevel = 'high';
                }
            }
        }

        // 6. Network check
        if (!this._allowNetwork) {
            const netCommands = ['curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'rsync', 'ftp', 'telnet'];
            const firstWord = trimmed.split(/\s/)[0];
            if (netCommands.includes(firstWord)) {
                analysis.isDangerous = true;
                analysis.matchedPatterns.push('network-blocked');
                analysis.message = `Network access denied: "${firstWord}"`;
                if (RISK_ORDER['high'] > RISK_ORDER[analysis.riskLevel]) {
                    analysis.riskLevel = 'high';
                }
            }
        }

        // If dangerous, requires confirmation
        if (analysis.isDangerous) {
            analysis.requiresConfirmation = true;
        }

        // If not in auto-allow and not dangerous, still requires confirmation
        if (!analysis.isDangerous) {
            analysis.requiresConfirmation = true;
            analysis.riskLevel = 'low';
        }

        return analysis;
    }

    // --- Filesystem guard ---

    checkPath(
        target: string,
        mode: 'read' | 'write' = 'read',
    ): { allowed: boolean; reason?: string } {
        if (!this._enabled) return { allowed: true };

        const resolved = path.resolve(target);

        // Denied paths always block
        for (const denied of this._deniedPaths) {
            if (resolved === denied || resolved.startsWith(denied + path.sep)) {
                return { allowed: false, reason: `[Sandbox] Path denied: ${resolved}` };
            }
        }

        // Check allowed paths
        const inAllowed = this._allowedPaths.some(
            (a) => resolved === a || resolved.startsWith(a + path.sep),
        );
        if (inAllowed) return { allowed: true };

        // Read outside can be optionally allowed
        if (mode === 'read' && this._allowReadOutside) return { allowed: true };

        return { allowed: false, reason: `[Sandbox] Path outside sandbox: ${resolved}` };
    }

    // --- Environment ---

    getChildEnv(): Record<string, string> {
        if (!this._enabled || this._allowEnvPassthrough) {
            return { ...process.env } as Record<string, string>;
        }
        const filtered: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (this._allowedEnvVars.has(key) && value !== undefined) {
                filtered[key] = value;
            }
        }
        return filtered;
    }

    // --- Execution wrapper ---

    async wrapExecution<T extends string>(fn: () => Promise<T> | T): Promise<string> {
        if (!this._enabled && !this._dangerouslyDisabled) {
            return await fn();
        }

        return new Promise<string>(async (resolve) => {
            const timeout = this._dangerouslyDisabled
                ? this._maxTimeoutCeiling
                : this._maxExecutionMs;

            const timer = setTimeout(() => {
                resolve(`[Sandbox] Execution timed out after ${timeout}ms`);
            }, timeout);

            try {
                let result = await fn();
                clearTimeout(timer);
                if (result.length > this._maxOutputChars) {
                    result = (result.slice(0, this._maxOutputChars) + '\n...[truncated by sandbox]') as T;
                }
                resolve(result);
            } catch (e: any) {
                clearTimeout(timer);
                resolve(`[Sandbox] Error: ${e.message ?? String(e)}`);
            }
        });
    }

    // --- Timeout validation ---

    validateTimeout(timeout: number): number {
        if (timeout < 1000) return this._maxExecutionMs;
        if (timeout > this._maxTimeoutCeiling) {
            return this._maxTimeoutCeiling;
        }
        return timeout;
    }

    // --- Internals ---

    private _log(
        tool: string,
        command: string | undefined,
        decision: PermissionDecision,
        startTime: number,
        analysis?: CommandAnalysis,
    ): void {
        this.audit.record({
            tool,
            command,
            decision: decision.behavior,
            reason: decision.decisionReason,
            riskLevel: analysis?.riskLevel,
            matchedPatterns: analysis?.matchedPatterns,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startTime,
        });
    }
}

// ---------------------------------------------------------------------------
// Risk level ordering
// ---------------------------------------------------------------------------

const RISK_ORDER: Record<RiskLevel, number> = {
    safe: 0,
    low: 1,
    moderate: 2,
    high: 3,
    critical: 4,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDefaultSandbox(workdir?: string): Sandbox {
    return new Sandbox({
        enabled: true,
        allowedPaths: [workdir ?? process.cwd()],
        allowReadOutsideSandbox: true,
        maxExecutionMs: 120_000,
        maxOutputChars: 50_000,
        onViolation: 'error',
    });
}
