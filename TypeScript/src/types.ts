/**
 * types.ts — Public type definitions for the agentic-system library.
 *
 * Users import these to define tools, skills, and configure agents.
 */

import type { LLMProvider } from './llmProtocol';

// ---------------------------------------------------------------------------
// Tool definition (user-facing)
// ---------------------------------------------------------------------------

/**
 * A tool the agent can call. Users provide `execute` — the runtime handler.
 *
 * @example
 * ```ts
 * const searchTool: ToolDefinition = {
 *   name: 'search_docs',
 *   description: 'Search project documentation',
 *   parameters: {
 *     query: { type: 'string', description: 'Search query' },
 *   },
 *   required: ['query'],
 *   execute: async (args) => {
 *     const results = await mySearch(args.query);
 *     return JSON.stringify(results);
 *   },
 * };
 * ```
 */
export interface ToolDefinition {
    /** Unique tool name (used by the LLM to invoke it). */
    name: string;
    /** Human-readable description shown to the LLM. */
    description: string;
    /**
     * JSON-Schema-style parameter map.
     * Keys are param names, values describe the type.
     */
    parameters?: Record<string, { type: string; description?: string; enum?: string[] }>;
    /** Names of required parameters. */
    required?: string[];
    /**
     * Runtime handler. Receives parsed arguments, returns a string result
     * that is fed back to the LLM as the tool observation.
     */
    execute: (args: Record<string, any>) => Promise<string> | string;
    /**
     * If true, the tool is mutating and requires user approval before
     * execution (only relevant when approval callbacks are set).
     */
    requiresApproval?: boolean;
}

// ---------------------------------------------------------------------------
// Skill definition (user-facing)
// ---------------------------------------------------------------------------

/**
 * A skill that can be loaded by the agent on demand via the Skill tool.
 *
 * @example
 * ```ts
 * const pythonSkill: SkillDefinition = {
 *   name: 'python-expert',
 *   description: 'Expert knowledge about Python best practices',
 *   body: '## Python style guide\n- Use type hints...',
 * };
 * ```
 */
export interface SkillDefinition {
    name: string;
    description: string;
    /** Markdown body injected into context when the skill is loaded. */
    body: string;
}

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface LLMConfig {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    timeout?: number;
}

export interface StorageConfig {
    backend: 'file' | 'cloud' | 'memory';
    /** For file backend: root directory for all data. */
    dir?: string;
    /** For cloud backend: S3 bucket name. */
    bucket?: string;
    /** For cloud backend: S3 endpoint URL. */
    endpoint?: string;
    /** For cloud backend: AWS region. */
    region?: string;
}

export interface AgentConfig {
    /** LLM provider instance (takes precedence over llmConfig). */
    llm?: LLMProvider;
    /** LLM connection config (used if llm is not provided). */
    llmConfig?: LLMConfig;
    /** Base system prompt. */
    systemPrompt?: string;
    /** User-defined tools. */
    tools?: ToolDefinition[];
    /** User-defined skills. */
    skills?: SkillDefinition[];
    /** Include built-in tools (bash, read_file, etc.). Default: true. */
    includeBuiltinTools?: boolean;
    /** Storage config. */
    storage?: StorageConfig;
    /** Enable long-term memory. Default: false. */
    enableMemory?: boolean;
    /** Enable streaming by default. Default: false. */
    enableStreaming?: boolean;
    /** Enable context management (history trimming, budgeting). Default: true. */
    enableContext?: boolean;
    /** Max tool rounds per turn. Default: 20. */
    maxToolRounds?: number;
    /** Callback for executor approval. Return true to approve. */
    approvalCallback?: (toolName: string, args: Record<string, any>) => Promise<boolean> | boolean;
}

// ---------------------------------------------------------------------------
// Chat result types
// ---------------------------------------------------------------------------

export interface ChatResult {
    /** Final assistant text. */
    reply: string;
    /** Full updated message history. */
    history: Record<string, any>[];
    /** Whether tools were called during this turn. */
    hadToolCalls: boolean;
    /** Session ID (if session is active). */
    sessionId?: string;
}

export interface StreamChunk {
    /** Content delta (partial text). Present on streaming chunks. */
    delta?: string;
    /** Final reply. Present on the last chunk. */
    reply?: string;
    /** Whether this is the final chunk. */
    done: boolean;
}

// ---------------------------------------------------------------------------
// Session handle
// ---------------------------------------------------------------------------

export interface AgentSession {
    /** Session identifier. */
    readonly id: string;
    /** Send a message within this session (preserves history). */
    chat(message: string): Promise<ChatResult>;
    /** Stream a message within this session. */
    stream(message: string): AsyncGenerator<StreamChunk>;
    /** Get the current conversation history. */
    getHistory(): Record<string, any>[];
    /** Persist the session to storage. */
    save(): Promise<void>;
}
