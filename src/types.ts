/**
 * types.ts — Public type definitions for the agentic-system library.
 *
 * Users import these to define tools, skills, and configure agents.
 */

import type { LLMProvider } from './llmProtocol';
import type { SandboxConfig } from './sandbox';
import type { EmbeddingProvider } from './providers/embeddings';
import type { ProviderName } from './providers/base';
import type { TokenUsage } from './pricing';

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
    /**
     * Permission level for sandbox classification.
     * 'safe' = read-only, 'moderate' = file mods, 'dangerous' = execution, 'critical' = unrestricted.
     */
    permissionLevel?: 'safe' | 'moderate' | 'dangerous' | 'critical';
    /**
     * Per-tool execution timeout in ms. Falls back to the executor default
     * (60s) when omitted. Capped at 10 minutes by the executor.
     */
    timeout?: number;
    /**
     * Whether this tool can be safely executed in parallel with sibling
     * tool calls in the same round. Defaults to `true`. Set to `false`
     * for tools with shared mutable state (e.g. an interactive REPL).
     * Tools with `requiresApproval: true` are always serialized regardless.
     */
    concurrencySafe?: boolean;
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
    // ---- Optional metadata (PR6) -----------------------------------------
    /** Semantic version. Default: '1.0.0'. */
    version?: string;
    /** Free-form tags. Used by SkillRegistry.search and listByTag. */
    tags?: string[];
    /** Logical categories. Used by SkillRegistry.listByCategory. */
    categories?: string[];
    /** Names of skills this skill depends on. Auto-loaded transitively. */
    dependencies?: string[];
    /**
     * Auto-trigger pattern. When the user input matches the string
     * (substring) or RegExp, SkillLifecycleManager.matchTriggers will
     * surface this skill so the loop can auto-load it.
     */
    trigger?: string | RegExp;
    /** Few-shot examples shown alongside the description when relevant. */
    examples?: { description?: string; input: string; output: string }[];
    /** Hook fired when the skill is first loaded into a session. */
    onLoad?: (ctx: SkillContext) => Promise<void> | void;
    /** Hook fired when the skill is unloaded. */
    onUnload?: (ctx: SkillContext) => Promise<void> | void;
}

/** Context passed to skill lifecycle hooks. */
export interface SkillContext {
    sessionId?: string;
    /** Free-form scratch area shared between onLoad / onUnload calls. */
    scratch: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface LLMConfig {
    apiKey: string;
    model?: string;
    /** Custom base URL for API-compatible endpoints (works with all providers). */
    baseUrl?: string;
    timeout?: number;
    /** Provider type. Used by setProvider() shorthand. Default: 'openai'. */
    provider?: ProviderName;
}

export interface StorageConfig {
    backend: 'file' | 'cloud' | 'memory';
    /** Inject a pre-built StorageBackend directly (overrides backend selection). */
    custom?: import('./storage/protocols').StorageBackend;
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
    /**
     * Callback for human-in-the-loop interaction.
     * Called when the agent uses the `ask_user` tool to ask the user a question mid-task.
     * Receives the question string and should return the user's answer.
     */
    humanInputCallback?: (question: string) => Promise<string> | string;
    /** Sandbox configuration for isolating tool execution. */
    sandbox?: SandboxConfig;
    /** MCP server configurations to connect to. */
    mcpServers?: import('./mcpClient').MCPServerConfig[];
    /**
     * Optional embedding provider for vector-based memory retrieval.
     * When not set, memory retrieval uses keyword-based scoring only.
     */
    embeddingProvider?: EmbeddingProvider;
    /**
     * Optional telemetry instance. If omitted, a no-op telemetry is used
     * (zero overhead). Construct with `new Telemetry({ exporter: ... })`
     * and pass in to enable spans, logs, and GenAI semantic attributes.
     */
    telemetry?: import('./telemetry').Telemetry;
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
    /** Token usage for this turn (accumulated across all LLM calls in the turn). */
    usage?: TokenUsage;
    /** Estimated cost in USD for this turn. */
    estimatedCost?: number;
}

export interface StreamChunk {
    /** Content delta (partial text). Present on streaming chunks. */
    delta?: string;
    /** Final reply. Present on the last chunk. */
    reply?: string;
    /** Whether this is the final chunk. */
    done: boolean;
    /** Token usage (present on the final chunk). */
    usage?: TokenUsage;
    /** Estimated cost in USD (present on the final chunk). */
    estimatedCost?: number;
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

// ---------------------------------------------------------------------------
// Autonomous task types
// ---------------------------------------------------------------------------

/** Phase within a single iteration of the autonomous loop. */
export type AutonomousPhase = 'plan' | 'execute' | 'review' | 'evaluate';

/**
 * Configuration for `agent.runTask()` — an autonomous loop that iterates
 * through plan → execute → review → evaluate until quality meets threshold.
 */
export interface AutonomousTaskConfig {
    /** Task description from the user. */
    task: string;
    /** Quality threshold (1–10). Loop exits when self-eval ≥ this. Default: 7. */
    qualityThreshold?: number;
    /** Maximum outer-loop iterations. Default: 10. */
    maxIterations?: number;
    /**
     * Callback invoked after each phase completes.
     * Return `false` to abort the loop early.
     */
    onProgress?: (progress: IterationProgress) => void | boolean | Promise<void | boolean>;
}

/** Progress snapshot emitted after each phase of an iteration. */
export interface IterationProgress {
    /** Current iteration number (1-based). */
    iteration: number;
    /** Phase that just completed. */
    phase: AutonomousPhase;
    /** Quality score (only present after 'evaluate' phase). */
    qualityScore?: number;
    /** Plan text (after 'plan' phase). */
    plan?: string;
    /** Execution output (after 'execute' phase). */
    output?: string;
    /** Review text (after 'review' phase). */
    review?: string;
    /** Evaluation JSON text (after 'evaluate' phase). */
    evaluation?: string;
}

/** Result of `agent.runTask()`. */
export interface AutonomousTaskResult {
    /** Final consolidated output. */
    result: string;
    /** Number of iterations executed. */
    iterations: number;
    /** Final quality score from self-evaluation. */
    qualityScore: number;
    /** Whether the quality threshold was met. */
    thresholdMet: boolean;
    /** History of all iteration progress snapshots. */
    progressHistory: IterationProgress[];
    /** Full conversation history. */
    history: Record<string, any>[];
}
