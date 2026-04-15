/**
 * agentInstance.ts — Runtime agent returned by AgentBuilder.build().
 *
 * Provides: chat(), stream(), createSession(), restoreSession().
 * All internal modules are wired through dependency injection — no globals.
 */

import { v4 as uuidv4 } from 'uuid';
import {
    AgentConfig,
    ToolDefinition,
    SkillDefinition,
    ChatResult,
    StreamChunk,
    AgentSession,
    AutonomousTaskConfig,
    AutonomousTaskResult,
} from './types';
import { AutonomousLoop } from './autonomousLoop';
import { LLMProvider, LLMResponse, ToolCall } from './llmProtocol';
import { SessionManager, Session } from './sessionCore';
import { LifecycleManager, getBudget, selectHistory, assembleSystem, sanitizeUserInput, foldObservation, contextEnabled as envContextEnabled } from './contextCore';
import { ContextBuilder } from './contextBuilder';
import { retrieve, consolidateTurn, writeInsight, setMemoryStore, MEMORY_ENABLED } from './memoryCore';
import { createFileBackend } from './storage/fileBackend';
import { StorageBackend } from './storage/protocols';
import { toTokenUsage, mergeTokenUsage, estimateCost, type TokenUsage } from './pricing';
import { Sandbox } from './sandbox';
import { MCPManager, MCPServerConfig } from './mcpClient';
import { ToolExecutor, ToolCallRequest } from './toolExecutor';
import { Telemetry } from './telemetry';
import { MetricsCollector } from './metrics';
import { AgentHarness } from './harness';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert ToolDefinition[] → OpenAI function-calling tool format */
function toolDefsToOpenAI(tools: ToolDefinition[]): Record<string, any>[] {
    return tools.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: {
                type: 'object',
                properties: Object.fromEntries(
                    Object.entries(t.parameters ?? {}).map(([k, v]) => [k, v]),
                ),
                required: t.required ?? [],
            },
        },
    }));
}

/** Convert SkillDefinition[] → inline skill descriptions */
function skillDescriptions(skills: SkillDefinition[]): string {
    if (!skills.length) return '';
    return (
        '\n\n**Available skills** (use the `Skill` tool to load one):\n' +
        skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    );
}

/** Build the Skill meta-tool for user-defined skills */
function buildSkillTool(skills: SkillDefinition[]): ToolDefinition | null {
    if (!skills.length) return null;
    const loadedSkills = new Set<string>();
    return {
        name: 'Skill',
        description:
            'Load a skill for specialized knowledge.\nAvailable:\n' +
            skills.map((s) => `- ${s.name}: ${s.description}`).join('\n'),
        parameters: { skill: { type: 'string', description: 'Skill name to load' } },
        required: ['skill'],
        execute: (args) => {
            const name = args.skill;
            if (loadedSkills.has(name)) {
                return `(Skill '${name}' already loaded. Use the knowledge above.)`;
            }
            const skill = skills.find((s) => s.name === name);
            if (!skill) {
                return `Error: Unknown skill '${name}'. Available: ${skills.map((s) => s.name).join(', ')}`;
            }
            loadedSkills.add(name);
            return `<skill-loaded name="${name}">\n# Skill: ${skill.name}\n\n${skill.body}\n</skill-loaded>\n\nUse the knowledge above to complete the user's task. Do NOT call Skill again.`;
        },
    };
}

// Built-in tools (only included when includeBuiltinTools is true)
function getBuiltinToolDefs(): ToolDefinition[] {
    // Lazy import to avoid circular deps and allow tree-shaking
    const {
        runBash,
        runRead,
        runGrep,
        runWrite,
        runEdit,
        runTodo,
        runSearchKnowledgeBase,
        runReadEmail,
        runWebSearch,
        runWebFetch,
    } = require('./toolsCore');

    return [
        {
            name: 'bash',
            description: 'Run a shell command.',
            parameters: { command: { type: 'string' } },
            required: ['command'],
            execute: (args) => runBash(args.command),
        },
        {
            name: 'read_file',
            description: 'Read file with pagination (offset/limit).',
            parameters: {
                path: { type: 'string' },
                offset: { type: 'integer', description: '0-based start line' },
                limit: { type: 'integer', description: 'Max lines' },
            },
            required: ['path'],
            execute: (args) => runRead(args.path, args.offset ?? 0, args.limit),
        },
        {
            name: 'grep',
            description: 'Search for pattern in file.',
            parameters: {
                path: { type: 'string' },
                pattern: { type: 'string' },
                context_before: { type: 'integer' },
                context_after: { type: 'integer' },
            },
            required: ['path', 'pattern'],
            execute: (args) =>
                runGrep(args.path, args.pattern, args.context_before ?? 0, args.context_after ?? 0),
        },
        {
            name: 'write_file',
            description: 'Write content to file (creates backup).',
            parameters: {
                path: { type: 'string' },
                content: { type: 'string' },
            },
            required: ['path', 'content'],
            requiresApproval: true,
            execute: (args) => runWrite(args.path, args.content),
        },
        {
            name: 'edit_file',
            description: 'Replace text in file.',
            parameters: {
                path: { type: 'string' },
                old_text: { type: 'string' },
                new_text: { type: 'string' },
            },
            required: ['path', 'old_text', 'new_text'],
            requiresApproval: true,
            execute: (args) => runEdit(args.path, args.old_text, args.new_text),
        },
        {
            name: 'TodoWrite',
            description: 'Update task list.',
            parameters: {
                items: {
                    type: 'array',
                    description: 'Array of {content, status, activeForm}',
                },
            },
            required: ['items'],
            execute: (args) => runTodo(args.items),
        },
        {
            name: 'WebSearch',
            description:
                'Search the web for current information. Returns formatted search results with titles, URLs, and snippets.',
            parameters: {
                query: { type: 'string', description: 'The search query' },
                allowed_domains: {
                    type: 'array',
                    description: 'Only include results from these domains',
                },
                blocked_domains: {
                    type: 'array',
                    description: 'Exclude results from these domains',
                },
            },
            required: ['query'],
            permissionLevel: 'dangerous',
            execute: async (args) =>
                runWebSearch(args.query ?? '', args.allowed_domains, args.blocked_domains),
        },
        {
            name: 'WebFetch',
            description:
                'Fetch content from a URL and return as plain text. HTML is stripped to text automatically.',
            parameters: {
                url: { type: 'string', description: 'The URL to fetch' },
                prompt: {
                    type: 'string',
                    description: 'Instructions for processing the fetched content',
                },
            },
            required: ['url', 'prompt'],
            permissionLevel: 'dangerous',
            execute: async (args) => runWebFetch(args.url ?? '', args.prompt ?? ''),
        },
    ];
}

interface ToolCallMsg {
    id: string;
    type: string;
    function: { name: string; arguments: string };
}

function toolCallsToMsgShape(toolCalls: ToolCall[]): ToolCallMsg[] {
    return toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
            name: tc.name,
            arguments: tc.arguments ? JSON.stringify(tc.arguments) : '{}',
        },
    }));
}

// ---------------------------------------------------------------------------
// AgentInstance
// ---------------------------------------------------------------------------

export class AgentInstance {
    private _llm: LLMProvider;
    private _systemPrompt: string;
    private _tools: ToolDefinition[];
    private _skills: SkillDefinition[];
    private _openaiTools: Record<string, any>[];
    private _toolMap: Map<string, ToolDefinition>;
    private _sessionMgr: SessionManager;
    private _maxToolRounds: number;
    private _memoryEnabled: boolean;
    private _streamingEnabled: boolean;
    private _contextEnabled: boolean;
    private _approvalCallback?: (
        name: string,
        args: Record<string, any>,
    ) => Promise<boolean> | boolean;
    private _humanInputCallback?: (question: string) => Promise<string> | string;
    private _harness!: AgentHarness;

    // Convenience accessors that delegate to the harness. Kept private so
    // callers either go through the public API or grab the harness directly.
    private get _sandbox(): Sandbox { return this._harness.sandbox; }
    private get _telemetry(): Telemetry { return this._harness.telemetry; }
    private get _metrics(): MetricsCollector { return this._harness.metrics; }
    private get _toolExecutor(): ToolExecutor { return this._harness.toolExecutor; }
    private get _mcpManager(): MCPManager | null { return this._harness.mcpManager; }
    private _storageInitialized: boolean = false;
    private _storageInitPromise: Promise<void> | null = null;
    private _storageConfig?: AgentConfig['storage'];

    constructor(config: AgentConfig) {
        this._llm = config.llm!;
        this._maxToolRounds = config.maxToolRounds ?? 20;
        this._memoryEnabled = config.enableMemory ?? false;
        this._streamingEnabled = config.enableStreaming ?? false;
        this._contextEnabled = config.enableContext ?? true;
        this._approvalCallback = config.approvalCallback;
        this._humanInputCallback = config.humanInputCallback;

        // Assemble tools
        this._tools = [];
        if (config.includeBuiltinTools !== false) {
            this._tools.push(...getBuiltinToolDefs());
        }
        if (config.tools?.length) {
            this._tools.push(...config.tools);
        }

        // Skills
        this._skills = config.skills ?? [];
        const skillTool = buildSkillTool(this._skills);
        if (skillTool) this._tools.push(skillTool);

        // Human-in-the-loop tool
        this._tools.push(this._buildAskUserTool());

        // Build the harness (composition root for sandbox / executor / telemetry / metrics / mcp).
        this._harness = new AgentHarness({
            llm: this._llm,
            tools: this._tools,
            sandbox: config.sandbox,
            telemetry: config.telemetry,
            mcpServers: config.mcpServers ?? [],
        });

        // Tool lookup and OpenAI format (mirror the harness registry for the LLM payload).
        this._toolMap = this._harness.toolRegistry.asMap();
        this._openaiTools = toolDefsToOpenAI(this._tools);

        // System prompt
        this._systemPrompt =
            config.systemPrompt ??
            'You are a helpful assistant. Use the provided tools when needed.';
        if (this._skills.length) {
            this._systemPrompt += skillDescriptions(this._skills);
        }

        // Storage & session manager (cloud backend init is deferred since it's async)
        this._storageConfig = config.storage;
        let storage: StorageBackend | undefined;
        if (config.storage) {
            if (config.storage.custom) {
                storage = config.storage.custom;
            } else if (config.storage.backend === 'file') {
                storage = createFileBackend({ sessionDir: config.storage.dir });
            }
            // cloud backend is initialized lazily via initStorage()
        }
        this._sessionMgr = new SessionManager({
            store: storage?.sessionStore ?? undefined,
        });
        if (storage?.memoryStore && this._memoryEnabled) {
            setMemoryStore(storage.memoryStore);
        }
        this._storageInitialized = config.storage?.backend !== 'cloud';
    }

    /**
     * Initialize cloud storage backend. Called lazily on first chat/stream,
     * or can be called explicitly for eager initialization.
     */
    async initStorage(): Promise<void> {
        if (this._storageInitialized) return;
        if (this._storageInitPromise) return this._storageInitPromise;

        this._storageInitPromise = (async () => {
            try {
                if (this._storageConfig?.backend === 'cloud') {
                    const { createCloudBackend } = await import('./storage/cloudBackend');
                    const storage = await createCloudBackend();
                    this._sessionMgr = new SessionManager({
                        store: storage.sessionStore,
                    });
                    if (storage.memoryStore && this._memoryEnabled) {
                        setMemoryStore(storage.memoryStore);
                    }
                }
            } catch (e: any) {
                console.error('[AgentInstance] Cloud storage init failed:', e.message ?? e);
            }
            this._storageInitialized = true;
        })();

        return this._storageInitPromise;
    }

    /**
     * Initialize MCP server connections. Called lazily on first chat/stream,
     * or can be called explicitly for eager initialization.
     *
     * The harness owns the MCPManager; we still need to merge the discovered
     * MCP tool descriptors into the LLM-facing `_openaiTools` payload here,
     * since that's the surface the agent loop hands to the provider.
     */
    async initMCP(): Promise<void> {
        if (!this._harness.mcpConfigs.length) return;
        const wasConnected = this._harness.mcpManager !== null;
        await this._harness.initMCP();
        const mgr = this._harness.mcpManager;
        if (mgr && !wasConnected) {
            for (const mcpTool of mgr.getToolDefinitions()) {
                this._openaiTools.push({
                    type: 'function',
                    function: {
                        name: mcpTool.name,
                        description: mcpTool.description,
                        parameters: mcpTool.input_schema,
                    },
                });
            }
        }
    }

    // ---- Public API ----

    /** Send a single message (no session, stateless). */
    async chat(message: string, history?: Record<string, any>[]): Promise<ChatResult> {
        const hist = history ? [...history] : [];
        const result = await this._runLoop(message, hist);
        return result;
    }

    /** Stream a single message (no session, stateless). */
    async *stream(
        message: string,
        history?: Record<string, any>[],
    ): AsyncGenerator<StreamChunk> {
        const hist = history ? [...history] : [];
        yield* this._runLoopStream(message, hist);
    }

    /** Create a new session (persisted, maintains conversation history). */
    async createSession(): Promise<AgentSession> {
        const session = await this._sessionMgr.createSession({ context: {} });
        return this._wrapSession(session);
    }

    /** Restore a previously saved session by ID. */
    async restoreSession(sessionId: string): Promise<AgentSession | null> {
        const session = await this._sessionMgr.restoreSession(sessionId);
        if (!session) return null;
        return this._wrapSession(session);
    }

    /** List saved session IDs. */
    async listSessions(): Promise<string[]> {
        return this._sessionMgr.listSessionIds();
    }

    /** List saved session summaries. */
    async listSessionSummaries(limit?: number): Promise<Record<string, any>[]> {
        return this._sessionMgr.listSessionsSummary(limit);
    }

    /** Get the underlying LLM provider. */
    get llm(): LLMProvider {
        return this._llm;
    }

    /** Get the list of registered tools. */
    get tools(): ToolDefinition[] {
        return [...this._tools];
    }

    /** Get the telemetry instance (no-op by default). */
    get telemetry(): Telemetry {
        return this._telemetry;
    }

    /** Snapshot of agent metrics: turns, tool calls, errors, tokens, cost. */
    getMetrics() {
        return this._metrics.getMetrics();
    }

    /**
     * Run an autonomous task loop.
     *
     * The agent iterates through plan → execute → review → evaluate phases
     * until self-evaluation meets the quality threshold or max iterations.
     */
    async runTask(config: AutonomousTaskConfig): Promise<AutonomousTaskResult> {
        const loop = new AutonomousLoop(this);
        return loop.run(config);
    }

    /**
     * Gracefully shut down MCP server connections.
     * Call this when the agent is no longer needed to release resources.
     */
    async close(): Promise<void> {
        await this._harness.close();
    }

    /**
     * The underlying composition root. Exposed for advanced use (custom
     * tool execution, observability, sharing telemetry across agents).
     */
    get harness(): AgentHarness {
        return this._harness;
    }

    // ---- Session wrapper ----

    private _wrapSession(session: Session): AgentSession {
        const self = this;
        return {
            get id(): string {
                return session.id;
            },
            async chat(message: string): Promise<ChatResult> {
                const result = await self._runLoop(message, session.history);
                session.history = result.history;
                session.updatedAt = Date.now() / 1000;
                try {
                    await self._sessionMgr.saveSession(session);
                } catch (e: any) {
                    console.error('[AgentInstance] Failed to save session:', e.message ?? e);
                }
                return { ...result, sessionId: session.id };
            },
            async *stream(message: string): AsyncGenerator<StreamChunk> {
                const chunks: string[] = [];
                yield* self._runLoopStream(message, session.history, async (fullResult) => {
                    session.history = fullResult.history;
                    session.updatedAt = Date.now() / 1000;
                    await self._sessionMgr.saveSession(session);
                });
            },
            getHistory(): Record<string, any>[] {
                return [...session.history];
            },
            async save(): Promise<void> {
                await self._sessionMgr.saveSession(session);
            },
        };
    }

    // ---- Human-in-the-loop ----

    private _buildAskUserTool(): ToolDefinition {
        const self = this;
        return {
            name: 'ask_user',
            description:
                'Ask the user a question and wait for their response. ' +
                'Use this when you need clarification, additional information, ' +
                'confirmation on an important decision, or when the task is ambiguous. ' +
                'Do NOT use this for trivial questions you can resolve yourself.',
            parameters: {
                question: {
                    type: 'string',
                    description: 'The question to ask the user',
                },
            },
            required: ['question'],
            execute: async (args) => {
                const question = args.question ?? '';
                if (!self._humanInputCallback) {
                    return '[Human input not available] No humanInputCallback is configured. Proceed with your best judgment.';
                }
                try {
                    const answer = await self._humanInputCallback(question);
                    return answer || '(User provided no response)';
                } catch (e: any) {
                    return `[Human input error] ${e.message ?? String(e)}`;
                }
            },
        };
    }

    // ---- Internal agent loop ----

    /**
     * Execute a batch of tool calls using the parallel-aware ToolExecutor.
     * Returns observations in the **original order** of `tcs`, ready to be
     * folded back into the conversation history.
     */
    private async _executeToolBatch(
        tcs: ToolCallMsg[],
    ): Promise<{ tool_call_id: string; content: string }[]> {
        const requests: ToolCallRequest[] = [];
        const failures: { tool_call_id: string; content: string }[] = [];
        const indexById = new Map<string, number>();

        // Parse arguments up-front so parse failures don't make it to the executor.
        for (const tc of tcs) {
            let args: Record<string, any>;
            try {
                args = JSON.parse(tc.function.arguments || '{}');
            } catch {
                failures.push({
                    tool_call_id: tc.id,
                    content: `[ARG_PARSE_ERROR] Could not parse arguments for tool "${tc.function.name}". Raw: ${(tc.function.arguments || '').slice(0, 200)}`,
                });
                continue;
            }
            indexById.set(tc.id, requests.length);
            requests.push({ id: tc.id, name: tc.function.name, arguments: args });
        }

        const results = requests.length
            ? await this._toolExecutor.executeAll(requests, {
                  approvalCallback: this._approvalCallback,
                  mcpRouter: this._mcpManager,
              })
            : [];

        // Reassemble in input order.
        const out: { tool_call_id: string; content: string }[] = [];
        for (const tc of tcs) {
            const failure = failures.find((f) => f.tool_call_id === tc.id);
            if (failure) {
                out.push(failure);
                continue;
            }
            const idx = indexById.get(tc.id);
            const r = idx !== undefined ? results[idx] : undefined;
            out.push({
                tool_call_id: tc.id,
                content: r ? r.output : `[Tool error] ${tc.function.name}: missing result`,
            });
        }
        return out;
    }

    private async _buildSystemForTurn(userInput: string): Promise<string> {
        if (!this._contextEnabled) return this._systemPrompt;

        const budget = getBudget();
        // Reserve the per-turn system budget separately so RAG and project
        // knowledge live within their own slice of the input window.
        const systemBudget = budget.system + Math.floor(budget.rag);

        const builder = new ContextBuilder({
            baseSystemPrompt: this._systemPrompt,
            includeProjectKnowledge: true,
            includeMemory: this._memoryEnabled,
            telemetry: this._telemetry,
        });

        try {
            const result = await builder.build(userInput, systemBudget);
            this._telemetry.debug('context', 'system assembled', {
                tokensUsed: result.tokensUsed,
                included: result.included,
                truncated: result.truncated,
                dropped: result.dropped,
            });
            return result.text || this._systemPrompt;
        } catch (e: any) {
            this._telemetry.warn('context', 'context assembly failed; falling back to base system prompt', { error: e?.message ?? String(e) });
            return this._systemPrompt;
        }
    }

    private async _runLoop(
        userInput: string,
        history: Record<string, any>[],
    ): Promise<ChatResult> {
        return this._telemetry.withSpan('agent.turn', async (turnSpan) => {
            const turnStart = Date.now();
            const result = await this._runLoopInner(userInput, history, turnSpan);
            this._metrics.recordTurn({
                turnNumber: this._metrics.getMetrics().turnCount + 1,
                hadToolCalls: result.hadToolCalls,
                toolCallCount: 0,
                inputTokens: result.usage?.inputTokens ?? 0,
                outputTokens: result.usage?.outputTokens ?? 0,
                durationMs: Date.now() - turnStart,
                estimatedCost: result.estimatedCost,
                timestamp: Date.now(),
            });
            turnSpan.setAttributes({
                'agent.turn.input_tokens': result.usage?.inputTokens ?? 0,
                'agent.turn.output_tokens': result.usage?.outputTokens ?? 0,
                'agent.turn.had_tool_calls': result.hadToolCalls,
            });
            return result;
        });
    }

    private async _runLoopInner(
        userInput: string,
        history: Record<string, any>[],
        _turnSpan: import('./telemetry').Span,
    ): Promise<ChatResult> {
        await this.initStorage();
        await this.initMCP();
        const sanitized = sanitizeUserInput(userInput);
        const message = sanitized.text;
        const system = await this._buildSystemForTurn(message);

        // Trim history if context management enabled
        let workingHistory = [...history];
        if (this._contextEnabled) {
            const budget = getBudget();
            const selected = selectHistory(workingHistory, message, budget.history);
            // #16: guarantee at least last 2 messages if history exists
            workingHistory = selected.length > 0 ? selected
                : workingHistory.length >= 2 ? workingHistory.slice(-2)
                : [...workingHistory];
        }
        workingHistory.push({ role: 'user', content: message });

        const apiMessages: Record<string, any>[] = [
            { role: 'system', content: system },
            ...workingHistory,
        ];

        let toolRounds = 0;
        let hadToolCalls = false;
        let accumulatedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

        while (true) {
            // #1: LLM call with retry
            let response: LLMResponse;
            try {
                response = await this._llmCallWithRetry(apiMessages, false) as LLMResponse;
            } catch (e: any) {
                const errMsg = `I encountered an error communicating with the AI model: ${e.message ?? String(e)}. Please try again.`;
                workingHistory.push({ role: 'assistant', content: errMsg });
                history.length = 0;
                history.push(...workingHistory);
                return { reply: errMsg, history: workingHistory, hadToolCalls, usage: accumulatedUsage };
            }

            // Accumulate token usage
            if (response.usage && Object.keys(response.usage).length > 0) {
                accumulatedUsage = mergeTokenUsage(accumulatedUsage, toTokenUsage(response.usage));
            }

            const tcs = response.toolCalls?.length
                ? toolCallsToMsgShape(response.toolCalls)
                : [];
            const content = response.content ?? '';
            const thinking = response.thinking ?? null;

            if (!tcs.length) {
                const assistantMsg: Record<string, any> = { role: 'assistant', content: content.trim() };
                if (thinking) assistantMsg.thinking = thinking;
                workingHistory.push(assistantMsg);
                // #8: memory consolidation failure handling
                if (this._memoryEnabled) {
                    const cspan = this._telemetry.startSpan('memory.consolidate');
                    try { await consolidateTurn(message, content.trim()); }
                    catch (e: any) {
                        cspan.setStatus('error', e?.message ?? String(e));
                        console.error('[AgentInstance] consolidateTurn failed:', e.message ?? e);
                    }
                    finally { cspan.end(); }
                }
                history.length = 0;
                history.push(...workingHistory);
                const model = response.model ?? '';
                return {
                    reply: content.trim(),
                    history: workingHistory,
                    hadToolCalls,
                    usage: accumulatedUsage,
                    estimatedCost: estimateCost(accumulatedUsage, model),
                };
            }

            hadToolCalls = true;
            toolRounds++;
            if (toolRounds >= this._maxToolRounds) {
                const msg =
                    'Stopped: reached tool-use safety limit. Please simplify your request.';
                workingHistory.push({ role: 'assistant', content: msg });
                history.length = 0;
                history.push(...workingHistory);
                return { reply: msg, history: workingHistory, hadToolCalls, usage: accumulatedUsage };
            }

            // Execute tools (parallel-safe ones in parallel via ToolExecutor)
            const results = await this._executeToolBatch(tcs);
            if (this._contextEnabled) {
                for (const r of results) r.content = foldObservation(r.content);
            }

            // Append to conversation (preserve thinking if present)
            const assistantToolMsg: Record<string, any> = {
                role: 'assistant',
                content: content || '',
                tool_calls: tcs,
            };
            if (thinking) assistantToolMsg.thinking = thinking;
            apiMessages.push(assistantToolMsg);
            workingHistory.push({ ...assistantToolMsg });
            for (const r of results) {
                apiMessages.push({
                    role: 'tool',
                    tool_call_id: r.tool_call_id,
                    content: r.content,
                });
                workingHistory.push({
                    role: 'tool',
                    tool_call_id: r.tool_call_id,
                    content: r.content,
                });
            }
        }
    }

    private async *_runLoopStream(
        userInput: string,
        history: Record<string, any>[],
        onComplete?: (result: ChatResult) => void,
    ): AsyncGenerator<StreamChunk> {
        await this.initStorage();
        await this.initMCP();
        const sanitized = sanitizeUserInput(userInput);
        const message = sanitized.text;
        const system = await this._buildSystemForTurn(message);

        let workingHistory = [...history];
        if (this._contextEnabled) {
            const budget = getBudget();
            const selected = selectHistory(workingHistory, message, budget.history);
            workingHistory = selected.length > 0 ? selected
                : workingHistory.length >= 2 ? workingHistory.slice(-2)
                : [...workingHistory];
        }
        workingHistory.push({ role: 'user', content: message });

        const apiMessages: Record<string, any>[] = [
            { role: 'system', content: system },
            ...workingHistory,
        ];

        let toolRounds = 0;
        let hadToolCalls = false;

        while (true) {
            let streamGen: AsyncGenerator<LLMResponse>;
            try {
                streamGen = await this._llmCallWithRetry(apiMessages, true) as AsyncGenerator<LLMResponse>;
            } catch (e: any) {
                const errMsg = `I encountered an error communicating with the AI model: ${e.message ?? String(e)}. Please try again.`;
                workingHistory.push({ role: 'assistant', content: errMsg });
                history.length = 0;
                history.push(...workingHistory);
                if (onComplete) onComplete({ reply: errMsg, history: workingHistory, hadToolCalls });
                yield { reply: errMsg, done: true };
                return;
            }

            let lastResponse: LLMResponse | null = null;
            try {
                for await (const r of streamGen) {
                    if (r.content && !r.toolCalls?.length) {
                        yield { delta: r.content, done: false };
                    }
                    lastResponse = r;
                }
            } catch (e: any) {
                const errMsg = `Stream interrupted: ${e.message ?? String(e)}`;
                workingHistory.push({ role: 'assistant', content: errMsg });
                history.length = 0;
                history.push(...workingHistory);
                if (onComplete) onComplete({ reply: errMsg, history: workingHistory, hadToolCalls });
                yield { reply: errMsg, done: true };
                return;
            }

            const content = lastResponse?.content ?? '';
            const thinking = lastResponse?.thinking ?? null;
            const tcs = lastResponse?.toolCalls?.length
                ? toolCallsToMsgShape(lastResponse.toolCalls)
                : [];

            if (!tcs.length) {
                const assistantMsg: Record<string, any> = { role: 'assistant', content: content.trim() };
                if (thinking) assistantMsg.thinking = thinking;
                workingHistory.push(assistantMsg);
                if (this._memoryEnabled) {
                    const cspan = this._telemetry.startSpan('memory.consolidate');
                    try { await consolidateTurn(message, content.trim()); }
                    catch (e: any) {
                        cspan.setStatus('error', e?.message ?? String(e));
                        console.error('[AgentInstance] consolidateTurn failed:', e.message ?? e);
                    }
                    finally { cspan.end(); }
                }
                history.length = 0;
                history.push(...workingHistory);
                const result: ChatResult = {
                    reply: content.trim(),
                    history: workingHistory,
                    hadToolCalls,
                };
                if (onComplete) onComplete(result);
                yield { reply: content.trim(), done: true };
                return;
            }

            hadToolCalls = true;
            toolRounds++;
            if (toolRounds >= this._maxToolRounds) {
                const msg = 'Stopped: reached tool-use safety limit.';
                workingHistory.push({ role: 'assistant', content: msg });
                history.length = 0;
                history.push(...workingHistory);
                if (onComplete) {
                    onComplete({ reply: msg, history: workingHistory, hadToolCalls });
                }
                yield { reply: msg, done: true };
                return;
            }

            // Execute tools (non-streaming phase, parallel-safe ones in parallel)
            const results = await this._executeToolBatch(tcs);
            if (this._contextEnabled) {
                for (const r of results) r.content = foldObservation(r.content);
            }

            const assistantToolMsg: Record<string, any> = {
                role: 'assistant',
                content: content || '',
                tool_calls: tcs,
            };
            if (thinking) assistantToolMsg.thinking = thinking;
            apiMessages.push(assistantToolMsg);
            workingHistory.push({ ...assistantToolMsg });
            for (const r of results) {
                apiMessages.push({
                    role: 'tool',
                    tool_call_id: r.tool_call_id,
                    content: r.content,
                });
                workingHistory.push({
                    role: 'tool',
                    tool_call_id: r.tool_call_id,
                    content: r.content,
                });
            }
        }
    }

    // #1: LLM call with exponential backoff retry
    private async _llmCallWithRetry(
        apiMessages: Record<string, any>[],
        stream: boolean,
        maxRetries: number = 3,
    ): Promise<LLMResponse | AsyncGenerator<LLMResponse>> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const span = this._telemetry.startSpan('llm.chat', {
                attributes: {
                    'gen_ai.operation.name': 'chat',
                    'llm.attempt': attempt,
                    'llm.stream': stream,
                    'llm.message_count': apiMessages.length,
                },
            });
            const startedAt = Date.now();
            try {
                const result = this._llm.chat(apiMessages, {
                    tools: this._openaiTools,
                    maxTokens: 8000,
                    stream,
                });
                // For non-streaming we can record usage once the promise settles.
                if (!stream) {
                    const resp = await (result as Promise<LLMResponse>);
                    if (resp.usage) {
                        this.telemetry.recordChat(
                            span,
                            resp.model ?? '',
                            {
                                input: (resp.usage as any).input_tokens ?? (resp.usage as any).inputTokens,
                                output: (resp.usage as any).output_tokens ?? (resp.usage as any).outputTokens,
                            },
                            Date.now() - startedAt,
                        );
                    }
                    span.end();
                    return resp;
                }
                // Streaming: end span when generator is exhausted (best-effort).
                span.setAttribute('llm.duration_ms_initiated', Date.now() - startedAt);
                span.end();
                return result as AsyncGenerator<LLMResponse>;
            } catch (e: any) {
                const status = e?.status ?? e?.response?.status;
                const retryable = [429, 500, 502, 503].includes(status);
                span.setStatus('error', e?.message ?? String(e));
                span.setAttribute('error.code', String(status ?? 'unknown'));
                span.end();
                this._metrics.recordError(`LLM_${status ?? 'ERROR'}`);
                if (attempt < maxRetries && retryable) {
                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
                    continue;
                }
                throw e;
            }
        }
        throw new Error('LLM call failed after retries');
    }
}
