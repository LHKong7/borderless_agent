/**
 * providers/index.ts — Barrel export for all LLM providers.
 */

// Core providers
export { OpenAIProvider } from './openai';
export { AnthropicProvider } from './anthropic';
export { GoogleProvider } from './google';

// Shared utilities
export {
    getContextWindowForModel,
    withRetry,
    normalizeUsage,
    type ProviderName,
    type RetryOptions,
} from './base';

// Embeddings (optional)
export {
    type EmbeddingProvider,
    OpenAIEmbeddingProvider,
    cosineSimilarity,
} from './embeddings';
