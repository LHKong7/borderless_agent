/**
 * index.ts — Public barrel export for the borderless-agent library.
 *
 * Usage:
 * ```ts
 * import { AgentBuilder } from 'borderless-agent';
 *
 * const agent = new AgentBuilder()
 *   .setProvider('openai', { apiKey: 'sk-...' })
 *   .setSystemPrompt('You are helpful.')
 *   .addTool({ name: 'hello', description: 'Say hi', execute: () => 'Hi!' })
 *   .build();
 *
 * const result = await agent.chat('Hello');
 * ```
 */

// ---- Builder & Instance ----
export { AgentBuilder } from './agentBuilder';
export { AgentInstance } from './agentInstance';

// ---- Public types ----
export type {
    ToolDefinition,
    SkillDefinition,
    AgentConfig,
    LLMConfig,
    StorageConfig,
    ChatResult,
    StreamChunk,
    AgentSession,
    AutonomousTaskConfig,
    AutonomousTaskResult,
    IterationProgress,
    AutonomousPhase,
} from './types';

// ---- LLM providers ----
export { OpenAIProvider } from './providers/openai';
export { AnthropicProvider } from './providers/anthropic';
export { GoogleProvider } from './providers/google';
export type { LLMProvider, LLMResponse, ToolCall, ChatMessage } from './llmProtocol';
export type { ProviderName, RetryOptions } from './providers/base';
export { getContextWindowForModel, withRetry } from './providers/base';

// ---- Embeddings (optional) ----
export { OpenAIEmbeddingProvider, cosineSimilarity } from './providers/embeddings';
export type { EmbeddingProvider } from './providers/embeddings';

// ---- Pricing & Token Usage ----
export {
    type TokenUsage,
    type ModelPricing,
    getModelPricing,
    setModelPricing,
    estimateCost,
    toTokenUsage,
    mergeTokenUsage,
} from './pricing';

// ---- Storage helpers ----
export { createFileBackend as createFileStorage } from './storage/fileBackend';
export { createCloudBackend as createCloudStorage } from './storage/cloudBackend';
export { StorageBackend } from './storage/protocols';
export type { SessionStore, MemoryStore, SkillStore, ContextStore } from './storage/protocols';

// ---- MCP ----
export { MCPManager } from './mcpClient';
export type { MCPServerConfig } from './mcpClient';

// ---- Session manager (for direct access) ----
export { SessionManager, Session } from './sessionCore';

// ---- Telemetry & metrics ----
export { Telemetry, ConsoleExporter, MemoryExporter } from './telemetry';
export type {
    Span,
    SpanData,
    SpanStatus,
    LogEntry,
    LogLevel,
    TelemetryExporter,
    TelemetryConfig,
} from './telemetry';
export { MetricsCollector } from './metrics';
export type {
    TurnMetrics,
    ToolMetrics,
    AgentMetricsSnapshot,
} from './metrics';

// ---- Context assembly ----
export { ContextBuilder, SourceRegistry } from './contextBuilder';
export type {
    ContextSource,
    SourceCategory,
    AssembleResult,
    ContextBuilderOptions,
    BuildContextResult,
} from './contextBuilder';

// ---- Composition root ----
export { AgentHarness, ToolRegistry } from './harness';
export type { HarnessConfig } from './harness';

// ---- Tool execution ----
export { ToolExecutor } from './toolExecutor';
export type {
    ToolCallRequest,
    ToolCallResult,
    ExecutionPlan,
    ToolExecutorContext,
    ToolExecutorOptions,
} from './toolExecutor';

// ---- Errors ----
export {
    AgentError,
    LLMError,
    RateLimitError,
    AuthenticationError,
    ContextOverflowError,
    ToolError,
    ToolTimeoutError,
    ToolExecutionError,
    ValidationError,
    ConfigurationError,
} from './errors';

// ---- Context helpers (for advanced usage) ----
export {
    estimateTokens,
    getBudget,
    assembleSystem,
    sanitizeUserInput,
    LifecycleManager,
} from './contextCore';
