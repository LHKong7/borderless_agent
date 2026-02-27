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
} from './types';
import { LLMProvider, LLMResponse, ToolCall } from './llmProtocol';
import { SessionManager, Session } from './sessionCore';
import { LifecycleManager, getBudget, selectHistory, assembleSystem, sanitizeUserInput, foldObservation, contextEnabled as envContextEnabled } from './contextCore';
import { retrieve, consolidateTurn, writeInsight, MEMORY_ENABLED } from './memoryCore';
import { createFileBackend } from './storage/fileBackend';
import { StorageBackend } from './storage/protocols';

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

    constructor(config: AgentConfig) {
        this._llm = config.llm!;
        this._maxToolRounds = config.maxToolRounds ?? 20;
        this._memoryEnabled = config.enableMemory ?? false;
        this._streamingEnabled = config.enableStreaming ?? false;
        this._contextEnabled = config.enableContext ?? true;
        this._approvalCallback = config.approvalCallback;

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

        // Build lookup and OpenAI format
        this._toolMap = new Map(this._tools.map((t) => [t.name, t]));
        this._openaiTools = toolDefsToOpenAI(this._tools);

        // System prompt
        this._systemPrompt =
            config.systemPrompt ??
            'You are a helpful assistant. Use the provided tools when needed.';
        if (this._skills.length) {
            this._systemPrompt += skillDescriptions(this._skills);
        }

        // Storage & session manager
        let storage: StorageBackend | undefined;
        if (config.storage) {
            if (config.storage.backend === 'file') {
                storage = createFileBackend({ sessionDir: config.storage.dir });
            }
            // cloud and memory backends can be added here
        }
        this._sessionMgr = new SessionManager({
            store: storage?.sessionStore ?? undefined,
        });
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
    createSession(): AgentSession {
        const session = this._sessionMgr.createSession({ context: {} });
        return this._wrapSession(session);
    }

    /** Restore a previously saved session by ID. */
    restoreSession(sessionId: string): AgentSession | null {
        const session = this._sessionMgr.restoreSession(sessionId);
        if (!session) return null;
        return this._wrapSession(session);
    }

    /** List saved session IDs. */
    listSessions(): string[] {
        return this._sessionMgr.listSessionIds();
    }

    /** List saved session summaries. */
    listSessionSummaries(limit?: number): Record<string, any>[] {
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
                self._sessionMgr.saveSession(session);
                return { ...result, sessionId: session.id };
            },
            async *stream(message: string): AsyncGenerator<StreamChunk> {
                const chunks: string[] = [];
                yield* self._runLoopStream(message, session.history, (fullResult) => {
                    session.history = fullResult.history;
                    session.updatedAt = Date.now() / 1000;
                    self._sessionMgr.saveSession(session);
                });
            },
            getHistory(): Record<string, any>[] {
                return [...session.history];
            },
            async save(): Promise<void> {
                self._sessionMgr.saveSession(session);
            },
        };
    }

    // ---- Internal agent loop ----

    private async _executeTool(
        name: string,
        args: Record<string, any>,
    ): Promise<string> {
        const tool = this._toolMap.get(name);
        if (!tool) return `Unknown tool: ${name}`;

        // Approval check
        if (tool.requiresApproval && this._approvalCallback) {
            const approved = await this._approvalCallback(name, args);
            if (!approved) return 'Action not approved by user.';
        }

        try {
            const result = await tool.execute(args);
            return result;
        } catch (e: any) {
            return `Error: ${e.message ?? String(e)}`;
        }
    }

    private _buildSystemForTurn(userInput: string): string {
        if (!this._contextEnabled) return this._systemPrompt;

        let ragLines: string[] | undefined;
        if (this._memoryEnabled) {
            const memories = retrieve(userInput, 5);
            ragLines = memories.map((m) => m[0]).filter(Boolean);
        }

        return assembleSystem({
            baseSystem: this._systemPrompt,
            ragLines: ragLines?.length ? ragLines : undefined,
        });
    }

    private async _runLoop(
        userInput: string,
        history: Record<string, any>[],
    ): Promise<ChatResult> {
        const sanitized = sanitizeUserInput(userInput);
        const message = sanitized.text;
        const system = this._buildSystemForTurn(message);

        // Trim history if context management enabled
        let workingHistory = [...history];
        if (this._contextEnabled) {
            const budget = getBudget();
            workingHistory = selectHistory(workingHistory, message, budget.history);
        }
        workingHistory.push({ role: 'user', content: message });

        const apiMessages: Record<string, any>[] = [
            { role: 'system', content: system },
            ...workingHistory,
        ];

        let toolRounds = 0;
        let hadToolCalls = false;

        while (true) {
            const response = (await this._llm.chat(apiMessages, {
                tools: this._openaiTools,
                maxTokens: 8000,
                stream: false,
            })) as LLMResponse;

            const tcs = response.toolCalls?.length
                ? toolCallsToMsgShape(response.toolCalls)
                : [];
            const content = response.content ?? '';

            if (!tcs.length) {
                workingHistory.push({ role: 'assistant', content: content.trim() });
                if (this._memoryEnabled) {
                    consolidateTurn(message, content.trim());
                }
                // Sync back
                history.length = 0;
                history.push(...workingHistory);
                return {
                    reply: content.trim(),
                    history: workingHistory,
                    hadToolCalls,
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
                return { reply: msg, history: workingHistory, hadToolCalls };
            }

            // Execute tools
            const results: { tool_call_id: string; content: string }[] = [];
            for (const tc of tcs) {
                let args: Record<string, any>;
                try {
                    args = JSON.parse(tc.function.arguments || '{}');
                } catch {
                    args = {};
                }
                let output = await this._executeTool(tc.function.name, args);
                if (this._contextEnabled) {
                    output = foldObservation(output);
                }
                results.push({ tool_call_id: tc.id, content: output });
            }

            // Append to conversation
            apiMessages.push({
                role: 'assistant',
                content: content || '',
                tool_calls: tcs,
            });
            workingHistory.push({
                role: 'assistant',
                content: content || '',
                tool_calls: tcs,
            });
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
        const sanitized = sanitizeUserInput(userInput);
        const message = sanitized.text;
        const system = this._buildSystemForTurn(message);

        let workingHistory = [...history];
        if (this._contextEnabled) {
            const budget = getBudget();
            workingHistory = selectHistory(workingHistory, message, budget.history);
        }
        workingHistory.push({ role: 'user', content: message });

        const apiMessages: Record<string, any>[] = [
            { role: 'system', content: system },
            ...workingHistory,
        ];

        let toolRounds = 0;
        let hadToolCalls = false;

        while (true) {
            const streamGen = this._llm.chat(apiMessages, {
                tools: this._openaiTools,
                maxTokens: 8000,
                stream: true,
            }) as AsyncGenerator<LLMResponse>;

            let lastResponse: LLMResponse | null = null;
            for await (const r of streamGen) {
                if (r.content && !r.toolCalls?.length) {
                    yield { delta: r.content, done: false };
                }
                lastResponse = r;
            }

            const content = lastResponse?.content ?? '';
            const tcs = lastResponse?.toolCalls?.length
                ? toolCallsToMsgShape(lastResponse.toolCalls)
                : [];

            if (!tcs.length) {
                workingHistory.push({ role: 'assistant', content: content.trim() });
                if (this._memoryEnabled) {
                    consolidateTurn(message, content.trim());
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

            // Execute tools (non-streaming phase)
            const results: { tool_call_id: string; content: string }[] = [];
            for (const tc of tcs) {
                let args: Record<string, any>;
                try {
                    args = JSON.parse(tc.function.arguments || '{}');
                } catch {
                    args = {};
                }
                let output = await this._executeTool(tc.function.name, args);
                if (this._contextEnabled) output = foldObservation(output);
                results.push({ tool_call_id: tc.id, content: output });
            }

            apiMessages.push({
                role: 'assistant',
                content: content || '',
                tool_calls: tcs,
            });
            workingHistory.push({
                role: 'assistant',
                content: content || '',
                tool_calls: tcs,
            });
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
}
