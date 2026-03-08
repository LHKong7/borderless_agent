/**
 * index.ts — Public barrel export for the agentic-system library.
 *
 * Usage:
 * ```ts
 * import { AgentBuilder, createFileStorage } from 'agentic-system';
 *
 * const agent = new AgentBuilder()
 *   .setLLM({ apiKey: 'sk-...' })
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

// ---- LLM provider (for advanced users who want to supply their own) ----
export { OpenAIProvider } from './llmProtocol';
export type { LLMProvider, LLMResponse, ToolCall, ChatMessage } from './llmProtocol';

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

// ---- Context helpers (for advanced usage) ----
export {
    estimateTokens,
    getBudget,
    assembleSystem,
    sanitizeUserInput,
    LifecycleManager,
} from './contextCore';
