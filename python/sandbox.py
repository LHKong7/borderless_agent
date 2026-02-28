"""
sandbox.py — Multi-layered security sandbox inspired by Claude Code's architecture.

Features:
- 4-tier permission system: safe → moderate → dangerous → critical
- Auto-allow list for safe commands (npm test, git status, ls, etc.)
- Command risk analysis with categorized patterns
- dangerously_disable_sandbox escape hatch
- Permission decision tracking with audit log
- Filesystem access control
- Resource limits (timeout, output truncation)
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set, Tuple, Union


# ---------------------------------------------------------------------------
# Permission Levels
# ---------------------------------------------------------------------------

class PermissionLevel(str, Enum):
    SAFE = 'safe'
    MODERATE = 'moderate'
    DANGEROUS = 'dangerous'
    CRITICAL = 'critical'


class RiskLevel(str, Enum):
    SAFE = 'safe'
    LOW = 'low'
    MODERATE = 'moderate'
    HIGH = 'high'
    CRITICAL = 'critical'


RISK_ORDER = {
    RiskLevel.SAFE: 0,
    RiskLevel.LOW: 1,
    RiskLevel.MODERATE: 2,
    RiskLevel.HIGH: 3,
    RiskLevel.CRITICAL: 4,
}

DecisionBehavior = str  # 'allow' | 'ask' | 'deny'


# ---------------------------------------------------------------------------
# Command Analysis
# ---------------------------------------------------------------------------

@dataclass
class CommandAnalysis:
    is_dangerous: bool = False
    risk_level: RiskLevel = RiskLevel.SAFE
    matched_patterns: List[str] = field(default_factory=list)
    requires_confirmation: bool = False
    message: Optional[str] = None


# ---------------------------------------------------------------------------
# Permission Decision
# ---------------------------------------------------------------------------

@dataclass
class DecisionWarning:
    level: RiskLevel
    title: str
    message: str


@dataclass
class DecisionReason:
    type: str = 'rule'  # 'rule' | 'auto-allow' | 'user-config' | 'sandbox-disabled'
    reason: Optional[str] = None
    patterns: Optional[List[str]] = None
    risk_level: Optional[RiskLevel] = None
    tool_level: Optional[PermissionLevel] = None
    user_permission: Optional[PermissionLevel] = None


class PermissionDecision:
    """Result of a permission check: allow, ask, or deny."""

    __slots__ = ('behavior', 'message', 'decision_reason', 'warning')

    def __init__(
        self,
        behavior: str,
        message: str = '',
        decision_reason: Optional[DecisionReason] = None,
        warning: Optional[DecisionWarning] = None,
    ) -> None:
        self.behavior = behavior
        self.message = message
        self.decision_reason = decision_reason or DecisionReason()
        self.warning = warning

    @classmethod
    def allow(cls, message: str = '') -> 'PermissionDecision':
        return cls(behavior='allow', message=message)

    @classmethod
    def ask(
        cls,
        message: str = 'Operation requires confirmation',
        decision_reason: Optional[DecisionReason] = None,
        warning: Optional[DecisionWarning] = None,
    ) -> 'PermissionDecision':
        return cls(behavior='ask', message=message, decision_reason=decision_reason, warning=warning)

    @classmethod
    def deny(
        cls,
        message: str = 'Operation not permitted',
        decision_reason: Optional[DecisionReason] = None,
    ) -> 'PermissionDecision':
        return cls(behavior='deny', message=message, decision_reason=decision_reason)

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {'behavior': self.behavior, 'message': self.message}
        if self.decision_reason:
            d['decisionReason'] = {'type': self.decision_reason.type, 'reason': self.decision_reason.reason}
        if self.warning:
            d['warning'] = {'level': self.warning.level, 'title': self.warning.title, 'message': self.warning.message}
        return d


# ---------------------------------------------------------------------------
# Audit Log
# ---------------------------------------------------------------------------

@dataclass
class AuditEntry:
    tool: str
    command: Optional[str]
    decision: str  # 'allow' | 'ask' | 'deny'
    reason: DecisionReason
    risk_level: Optional[RiskLevel] = None
    matched_patterns: Optional[List[str]] = None
    timestamp: str = ''
    duration_ms: float = 0.0


class AuditLog:
    """Decision history for security audit."""

    def __init__(self, max_entries: int = 10_000) -> None:
        self._entries: List[AuditEntry] = []
        self._max_entries = max_entries

    def record(self, entry: AuditEntry) -> None:
        self._entries.append(entry)
        if len(self._entries) > self._max_entries:
            self._entries = self._entries[-(self._max_entries // 2):]

    def get_log(
        self,
        tool: Optional[str] = None,
        behavior: Optional[str] = None,
    ) -> List[AuditEntry]:
        log = self._entries
        if tool:
            log = [e for e in log if e.tool == tool]
        if behavior:
            log = [e for e in log if e.decision == behavior]
        return log

    @property
    def summary(self) -> Dict[str, int]:
        return {
            'total': len(self._entries),
            'allowed': sum(1 for e in self._entries if e.decision == 'allow'),
            'asked': sum(1 for e in self._entries if e.decision == 'ask'),
            'denied': sum(1 for e in self._entries if e.decision == 'deny'),
        }

    def clear(self) -> None:
        self._entries.clear()


# ---------------------------------------------------------------------------
# SandboxConfig
# ---------------------------------------------------------------------------

@dataclass
class SandboxConfig:
    """Configuration for the execution sandbox."""

    enabled: bool = True
    dangerously_disable_sandbox: bool = False

    # Filesystem
    allowed_paths: List[str] = field(default_factory=lambda: [os.getcwd()])
    denied_paths: List[str] = field(default_factory=list)
    allow_read_outside_sandbox: bool = False

    # Permissions
    default_permission: str = 'moderate'  # PermissionLevel
    tool_permissions: Dict[str, str] = field(default_factory=dict)

    # Command filtering
    blocked_commands: List[str] = field(default_factory=list)
    blocked_patterns: List[str] = field(default_factory=list)  # regex strings
    allowed_commands: Optional[List[str]] = None  # allowlist mode

    # Resource limits
    max_execution_secs: float = 120.0
    max_output_chars: int = 50_000
    max_timeout_ceiling: float = 600.0

    # Network / environment
    allow_network: bool = True
    allow_env_passthrough: bool = False
    allowed_env_vars: List[str] = field(default_factory=list)

    # Violation handling
    on_violation: str = 'error'  # 'error' | 'warn' | 'silent'


# ---------------------------------------------------------------------------
# Dangerous Pattern Definitions (Categorized)
# ---------------------------------------------------------------------------

@dataclass
class _DangerousPattern:
    name: str
    regex: 're.Pattern[str]'
    severity: RiskLevel
    category: str
    message: str


_DANGEROUS_PATTERNS: List[_DangerousPattern] = [
    # Data Loss
    _DangerousPattern('force-remove', re.compile(r'\brm\s+(-rf?|-fr?|-.*f)\b'), RiskLevel.CRITICAL, 'data-loss', 'Force deletion detected'),
    _DangerousPattern('recursive-remove-root', re.compile(r'\brm\s+.*\/\s*$'), RiskLevel.CRITICAL, 'data-loss', 'Root directory removal detected'),
    _DangerousPattern('disk-wipe', re.compile(r'\bdd\s+.*of=\/\w'), RiskLevel.CRITICAL, 'data-loss', 'Disk wipe operation detected'),
    _DangerousPattern('mkfs', re.compile(r'\bmkfs\b'), RiskLevel.CRITICAL, 'data-loss', 'Filesystem format detected'),
    _DangerousPattern('destructive-chmod', re.compile(r'chmod\s+-R\s+777\s+\/'), RiskLevel.HIGH, 'data-loss', 'Recursive permission change on root'),
    _DangerousPattern('destructive-chown', re.compile(r'chown\s+-R\s'), RiskLevel.MODERATE, 'data-loss', 'Recursive ownership change detected'),

    # Privilege Escalation
    _DangerousPattern('sudo', re.compile(r'\bsudo\b'), RiskLevel.HIGH, 'privilege-escalation', 'Privilege escalation (sudo) detected'),
    _DangerousPattern('su', re.compile(r'\bsu\s'), RiskLevel.HIGH, 'privilege-escalation', 'Privilege escalation (su) detected'),
    _DangerousPattern('doas', re.compile(r'\bdoas\b'), RiskLevel.HIGH, 'privilege-escalation', 'Privilege escalation (doas) detected'),

    # Remote Code Execution
    _DangerousPattern('curl-pipe-bash', re.compile(r'\bcurl\s.*\|\s*(ba)?sh'), RiskLevel.CRITICAL, 'remote-code-exec', 'Remote code execution: curl | sh'),
    _DangerousPattern('wget-pipe-bash', re.compile(r'\bwget\s.*\|\s*(ba)?sh'), RiskLevel.CRITICAL, 'remote-code-exec', 'Remote code execution: wget | sh'),
    _DangerousPattern('pipe-to-shell', re.compile(r'\|\s*(sh|bash|zsh|fish|pwsh)\s*$'), RiskLevel.CRITICAL, 'remote-code-exec', 'Pipe to shell detected'),
    _DangerousPattern('eval-curl', re.compile(r'eval\s*\$?\(?curl'), RiskLevel.CRITICAL, 'remote-code-exec', 'Eval of remote content detected'),
    _DangerousPattern('dev-tcp', re.compile(r'/dev/tcp'), RiskLevel.CRITICAL, 'remote-code-exec', '/dev/tcp connection detected'),
    _DangerousPattern('fork-bomb', re.compile(r':\(\)\{.*\|.*&\}'), RiskLevel.CRITICAL, 'remote-code-exec', 'Fork bomb detected'),

    # Data Exfiltration
    _DangerousPattern('curl-data', re.compile(r'\bcurl\s+.*--data'), RiskLevel.HIGH, 'exfiltration', 'Data exfiltration via curl detected'),
    _DangerousPattern('netcat', re.compile(r'\b(nc|ncat|netcat)\s+'), RiskLevel.HIGH, 'exfiltration', 'Netcat connection detected'),
    _DangerousPattern('telnet', re.compile(r'\btelnet\s+'), RiskLevel.HIGH, 'exfiltration', 'Telnet connection detected'),

    # Process Manipulation
    _DangerousPattern('kill-force', re.compile(r'\bkill\s+-9\b'), RiskLevel.MODERATE, 'process', 'Force kill detected'),
    _DangerousPattern('killall', re.compile(r'\b(pkill|killall)\b'), RiskLevel.MODERATE, 'process', 'Process kill-all detected'),

    # System
    _DangerousPattern('shutdown', re.compile(r'\b(shutdown|reboot|halt|poweroff)\b'), RiskLevel.CRITICAL, 'system', 'System power operation detected'),
    _DangerousPattern('init', re.compile(r'\binit\s+[06]\b'), RiskLevel.CRITICAL, 'system', 'Init level change detected'),
    _DangerousPattern('systemctl', re.compile(r'\bsystemctl\b'), RiskLevel.MODERATE, 'system', 'Systemctl usage detected'),
    _DangerousPattern('launchctl', re.compile(r'\blaunchctl\b'), RiskLevel.MODERATE, 'system', 'Launchctl usage detected'),
    _DangerousPattern('npm-publish', re.compile(r'\bnpm\s+(publish|login|adduser)\b'), RiskLevel.HIGH, 'system', 'npm publish/auth detected'),
    _DangerousPattern('global-install', re.compile(r'\b(npm\s+(install|i)\s+(-g|--global)|pip\s+install)'), RiskLevel.MODERATE, 'system', 'Global package installation detected'),
]


# ---------------------------------------------------------------------------
# Auto-Allow List (Safe Commands)
# ---------------------------------------------------------------------------

_AUTO_ALLOW_PATTERNS: List['re.Pattern[str]'] = [
    # Build & dev tools
    re.compile(r'^npm\s+(test|run|build|lint|check|audit|outdated)\s*$'),
    re.compile(r'^npm\s+run\s+[a-zA-Z0-9_:.\-]+$'),
    re.compile(r'^npx\s+tsc(\s+--noEmit)?\s*$'),
    re.compile(r'^(yarn|pnpm)\s+(test|build|lint|dev)\s*$'),

    # Git read-only
    re.compile(r'^git\s+(status|log|diff|branch|show|rev-parse|blame|tag|remote)\s*$'),
    re.compile(r'^git\s+(log|diff|show|blame)\s+'),
    re.compile(r'^git\s+status\s+'),

    # File inspection
    re.compile(r'^ls(\s+[-\w./]*)*$'),
    re.compile(r'^cat\s+[\w\-./\s]+$'),
    re.compile(r'^(head|tail)(\s+[-\d\w]*)?\s*[\w\-./]*$'),
    re.compile(r'^wc(\s+[-\w]*)?\s+[\w\-./]+$'),
    re.compile(r'^file\s+[\w\-./]+$'),
    re.compile(r'^find\s+[\w\-./]+(\s+-name\s+[\w*".]+)?(\s+-type\s+\w)?$'),

    # System information
    re.compile(r'^(pwd|whoami|uname|id|hostname|date|uptime)\s*$'),
    re.compile(r'^(uname|id)\s+[-\w]*$'),
    re.compile(r'^(env|printenv)\s*$'),

    # Version checks
    re.compile(r'^(node|python3?|java|go|rustc|cargo|ruby|php)\s+(--version|-v|-V|version)\s*$'),

    # Development tools
    re.compile(r'^(make|cmake|cargo|go)\s+(build|test|check|run|version)\s*$'),
    re.compile(r'^(eslint|prettier|black|ruff|flake8|mypy)\s+[\w\-./]+$'),
    re.compile(r'^(pytest|jest|vitest|mocha|cargo\s+test)\s*$'),
    re.compile(r'^(pytest|jest|vitest|mocha)\s+[\w\-./]+$'),

    # Directory navigation
    re.compile(r'^(mkdir|rmdir)\s+[\w\-./]+$'),
    re.compile(r'^(touch|stat)\s+[\w\-./]+$'),

    # grep / search (read-only)
    re.compile(r'^(grep|rg|ag|ack)\s+'),
    re.compile(r'^echo\s+'),
]


# ---------------------------------------------------------------------------
# Default denied paths / safe env vars
# ---------------------------------------------------------------------------

_DEFAULT_DENIED_PATHS = [
    '/etc/shadow',
    '/etc/passwd',
    os.path.expanduser('~/.ssh'),
    os.path.expanduser('~/.gnupg'),
    os.path.expanduser('~/.aws/credentials'),
    '/var/run/docker.sock',
]

_SAFE_ENV_VARS = {
    'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
    'TZ', 'VIRTUAL_ENV', 'PYTHONPATH', 'EDITOR', 'VISUAL',
}

# Tool → default PermissionLevel
_DEFAULT_TOOL_LEVELS: Dict[str, str] = {
    'read_file': 'safe',
    'grep': 'safe',
    'Skill': 'safe',
    'TodoWrite': 'safe',
    'write_file': 'moderate',
    'edit_file': 'moderate',
    'bash': 'dangerous',
    'WebSearch': 'dangerous',
    'WebFetch': 'dangerous',
}


# ---------------------------------------------------------------------------
# Sandbox
# ---------------------------------------------------------------------------

class Sandbox:
    """Multi-layered security sandbox for agent tool execution."""

    def __init__(self, config: Optional[SandboxConfig] = None) -> None:
        cfg = config or SandboxConfig()
        self._dangerously_disabled = cfg.dangerously_disable_sandbox
        self._enabled = False if self._dangerously_disabled else cfg.enabled
        self._allowed_paths = [os.path.realpath(p) for p in cfg.allowed_paths]
        self._denied_paths = [os.path.realpath(p) for p in (_DEFAULT_DENIED_PATHS + cfg.denied_paths)]
        self._allow_read_outside = cfg.allow_read_outside_sandbox
        self._default_permission = cfg.default_permission
        self._tool_permissions: Dict[str, str] = {**_DEFAULT_TOOL_LEVELS, **cfg.tool_permissions}
        self._blocked_commands = cfg.blocked_commands
        self._custom_blocked_patterns = [re.compile(p) for p in cfg.blocked_patterns]
        self._allowed_commands = cfg.allowed_commands
        self._max_timeout_ceiling = cfg.max_timeout_ceiling
        self._max_execution_secs = min(cfg.max_execution_secs, self._max_timeout_ceiling)
        self._max_output_chars = cfg.max_output_chars
        self._allow_network = cfg.allow_network
        self._allow_env_passthrough = cfg.allow_env_passthrough
        self._allowed_env_vars = _SAFE_ENV_VARS | set(cfg.allowed_env_vars)
        self._on_violation = cfg.on_violation
        self.audit = AuditLog()

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def is_dangerously_disabled(self) -> bool:
        return self._dangerously_disabled

    @property
    def max_execution_secs(self) -> float:
        return self._max_execution_secs

    @property
    def max_output_chars(self) -> int:
        return self._max_output_chars

    # --- Permission check (top-level entry point) ---

    def check_permission(
        self,
        tool: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> PermissionDecision:
        """Check permission for a tool invocation. Returns allow / ask / deny."""
        params = params or {}
        start = time.monotonic()

        # 1. Dangerously disabled — always ask
        if self._dangerously_disabled:
            decision = PermissionDecision.ask(
                message='⚠️  Sandbox disabled — command will execute with full system access',
                decision_reason=DecisionReason(type='sandbox-disabled', reason='dangerously_disable_sandbox'),
                warning=DecisionWarning(
                    level=RiskLevel.CRITICAL,
                    title='Sandbox Disabled',
                    message='This operation bypasses all sandbox protections',
                ),
            )
            self._log(tool, params.get('command'), decision, start)
            return decision

        # 2. Sandbox not enabled — allow everything
        if not self._enabled:
            decision = PermissionDecision.allow('Sandbox not enabled')
            self._log(tool, params.get('command'), decision, start)
            return decision

        # 3. Get tool permission level
        tool_level = self._tool_permissions.get(tool, self._default_permission)

        # 4. Safe tools — auto-allow
        if tool_level == 'safe':
            decision = PermissionDecision.allow('Safe tool — auto-allowed')
            self._log(tool, params.get('command'), decision, start)
            return decision

        # 5. Bash tool — deep analysis
        if tool == 'bash' and params.get('command'):
            analysis = self.analyze_command(params['command'])

            if not analysis.is_dangerous and not analysis.requires_confirmation:
                decision = PermissionDecision.allow('Command approved by auto-allow list')
                self._log(tool, params['command'], decision, start, analysis)
                return decision

            if analysis.is_dangerous:
                decision = PermissionDecision.deny(
                    message=f"Dangerous command blocked: {', '.join(analysis.matched_patterns)}",
                    decision_reason=DecisionReason(
                        type='rule', reason='dangerous-pattern',
                        patterns=analysis.matched_patterns,
                        risk_level=analysis.risk_level,
                    ),
                )
                self._log(tool, params['command'], decision, start, analysis)
                return decision

            decision = PermissionDecision.ask(
                message='Command requires confirmation in sandbox mode',
                decision_reason=DecisionReason(type='rule', reason='unknown-command'),
            )
            self._log(tool, params['command'], decision, start, analysis)
            return decision

        # 6. File tools — check path
        if tool in ('read_file', 'grep') and params.get('path'):
            ok, reason = self.check_path(params['path'], 'read')
            if not ok:
                decision = PermissionDecision.deny(
                    message=reason or 'Path blocked',
                    decision_reason=DecisionReason(type='rule', reason='path-denied'),
                )
                self._log(tool, None, decision, start)
                return decision

        if tool in ('write_file', 'edit_file') and params.get('path'):
            ok, reason = self.check_path(params['path'], 'write')
            if not ok:
                decision = PermissionDecision.deny(
                    message=reason or 'Path blocked',
                    decision_reason=DecisionReason(type='rule', reason='path-denied'),
                )
                self._log(tool, None, decision, start)
                return decision

        # 7. Web tools — network permission check
        if tool in ('WebSearch', 'WebFetch'):
            if not self._allow_network:
                decision = PermissionDecision.deny(
                    message='[Sandbox] Network access denied for web tools',
                    decision_reason=DecisionReason(type='rule', reason='network-blocked'),
                )
                self._log(tool, None, decision, start)
                return decision
            # Network allowed — ask for confirmation (dangerous tool)
            decision = PermissionDecision.ask(
                message=f'{tool} requires network access confirmation',
                decision_reason=DecisionReason(type='rule', reason='network-tool'),
            )
            self._log(tool, None, decision, start)
            return decision

        # 8. Allow
        decision = PermissionDecision.allow('Permitted by permission level')
        self._log(tool, params.get('command'), decision, start)
        return decision

    # --- Command analysis ---

    def analyze_command(self, command: str) -> CommandAnalysis:
        """Analyze a bash command for risk level and patterns."""
        trimmed = command.strip()
        analysis = CommandAnalysis()

        # 1. Auto-allow list
        if any(p.search(trimmed) for p in _AUTO_ALLOW_PATTERNS):
            return analysis  # safe, no confirmation

        # 2. Allowlist mode
        if self._allowed_commands is not None:
            if not any(trimmed.startswith(prefix) for prefix in self._allowed_commands):
                analysis.is_dangerous = True
                analysis.risk_level = RiskLevel.HIGH
                analysis.matched_patterns.append('not-in-allowlist')
                analysis.requires_confirmation = True
                analysis.message = f'Command not in allowlist: "{trimmed[:60]}"'
                return analysis

        # 3. Categorized dangerous patterns
        for pattern in _DANGEROUS_PATTERNS:
            if pattern.regex.search(trimmed):
                analysis.is_dangerous = True
                analysis.matched_patterns.append(pattern.name)
                analysis.message = pattern.message
                if RISK_ORDER.get(pattern.severity, 0) > RISK_ORDER.get(analysis.risk_level, 0):
                    analysis.risk_level = pattern.severity

        # 4. Custom blocked patterns
        for pattern in self._custom_blocked_patterns:
            if pattern.search(trimmed):
                analysis.is_dangerous = True
                analysis.matched_patterns.append(f'custom:{pattern.pattern}')
                if RISK_ORDER.get(RiskLevel.HIGH, 0) > RISK_ORDER.get(analysis.risk_level, 0):
                    analysis.risk_level = RiskLevel.HIGH

        # 5. Substring blocklist
        for blocked in self._blocked_commands:
            if blocked in trimmed:
                analysis.is_dangerous = True
                analysis.matched_patterns.append(f'blocked:"{blocked}"')
                if RISK_ORDER.get(RiskLevel.HIGH, 0) > RISK_ORDER.get(analysis.risk_level, 0):
                    analysis.risk_level = RiskLevel.HIGH

        # 6. Network check
        if not self._allow_network:
            net_cmds = {'curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'rsync', 'ftp', 'telnet'}
            first_word = trimmed.split()[0] if trimmed else ''
            if first_word in net_cmds:
                analysis.is_dangerous = True
                analysis.matched_patterns.append('network-blocked')
                analysis.message = f'Network access denied: "{first_word}"'
                if RISK_ORDER.get(RiskLevel.HIGH, 0) > RISK_ORDER.get(analysis.risk_level, 0):
                    analysis.risk_level = RiskLevel.HIGH

        if analysis.is_dangerous:
            analysis.requires_confirmation = True

        # Unknown command (not auto-allowed, not dangerous) → requires confirmation
        if not analysis.is_dangerous:
            analysis.requires_confirmation = True
            analysis.risk_level = RiskLevel.LOW

        return analysis

    # --- Filesystem guard ---

    def check_path(self, target: str, mode: str = 'read') -> Tuple[bool, Optional[str]]:
        """Check if a path is allowed. Returns (allowed, reason)."""
        if not self._enabled:
            return True, None

        resolved = os.path.realpath(target)

        for denied in self._denied_paths:
            if resolved == denied or resolved.startswith(denied + os.sep):
                return False, f'[Sandbox] Path denied: {resolved}'

        in_allowed = any(
            resolved == a or resolved.startswith(a + os.sep)
            for a in self._allowed_paths
        )
        if in_allowed:
            return True, None

        if mode == 'read' and self._allow_read_outside:
            return True, None

        return False, f'[Sandbox] Path outside sandbox: {resolved}'

    # --- Environment ---

    def get_child_env(self) -> Dict[str, str]:
        """Return filtered env for child processes."""
        if not self._enabled or self._allow_env_passthrough:
            return dict(os.environ)
        return {k: v for k, v in os.environ.items() if k in self._allowed_env_vars}

    # --- Execution wrapper ---

    def wrap_execution(self, fn: Callable[[], str]) -> str:
        """Wrap a synchronous tool execution with timeout and output truncation."""
        if not self._enabled and not self._dangerously_disabled:
            return fn()

        timeout = self._max_timeout_ceiling if self._dangerously_disabled else self._max_execution_secs

        result_container: List[Optional[str]] = [None]
        error_container: List[Optional[str]] = [None]

        def _run() -> None:
            try:
                result_container[0] = fn()
            except Exception as e:
                error_container[0] = f'[Sandbox] Error: {e}'

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()
        thread.join(timeout=timeout)

        if thread.is_alive():
            return f'[Sandbox] Execution timed out after {timeout}s'

        if error_container[0]:
            return error_container[0]

        output = result_container[0] or ''
        if len(output) > self._max_output_chars:
            output = output[:self._max_output_chars] + '\n...[truncated by sandbox]'
        return output

    # --- Timeout validation ---

    def validate_timeout(self, timeout: float) -> float:
        if timeout < 1.0:
            return self._max_execution_secs
        if timeout > self._max_timeout_ceiling:
            return self._max_timeout_ceiling
        return timeout

    # --- Internals ---

    def _log(
        self,
        tool: str,
        command: Optional[str],
        decision: PermissionDecision,
        start_time: float,
        analysis: Optional[CommandAnalysis] = None,
    ) -> None:
        self.audit.record(AuditEntry(
            tool=tool,
            command=command,
            decision=decision.behavior,
            reason=decision.decision_reason,
            risk_level=analysis.risk_level if analysis else None,
            matched_patterns=analysis.matched_patterns if analysis else None,
            timestamp=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            duration_ms=(time.monotonic() - start_time) * 1000,
        ))


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def create_default_sandbox(workdir: Optional[str] = None) -> Sandbox:
    """Create a sandbox with sensible defaults."""
    return Sandbox(SandboxConfig(
        enabled=True,
        allowed_paths=[workdir or os.getcwd()],
        allow_read_outside_sandbox=True,
        max_execution_secs=120.0,
        max_output_chars=50_000,
        on_violation='error',
    ))
