/**
 * providers/base.ts — Shared utilities for LLM providers.
 *
 * Context window lookup table, retry helper, and usage normalization.
 */

import {
    RateLimitError,
    AuthenticationError,
    LLMError,
} from '../errors';

// ---------------------------------------------------------------------------
// Context window sizes (tokens) by model prefix
// ---------------------------------------------------------------------------

const CONTEXT_WINDOWS: [RegExp, number][] = [
    // OpenAI
    [/gpt-4o/, 128_000],
    [/gpt-4-turbo/, 128_000],
    [/gpt-4-0125/, 128_000],
    [/gpt-4-1106/, 128_000],
    [/gpt-4$/, 8_192],
    [/gpt-3\.5-turbo-16k/, 16_384],
    [/gpt-3\.5-turbo/, 16_384],
    [/o1-mini/, 128_000],
    [/o1-preview/, 128_000],
    [/o1/, 200_000],
    [/o3/, 200_000],
    [/o4-mini/, 200_000],

    // Anthropic
    [/claude-opus-4/, 200_000],
    [/claude-sonnet-4/, 200_000],
    [/claude-3-7-sonnet/, 200_000],
    [/claude-3-5-sonnet/, 200_000],
    [/claude-3-5-haiku/, 200_000],
    [/claude-3-opus/, 200_000],
    [/claude-3-sonnet/, 200_000],
    [/claude-3-haiku/, 200_000],

    // Google
    [/gemini-2\.5/, 1_000_000],
    [/gemini-2\.0-flash/, 1_000_000],
    [/gemini-1\.5-pro/, 2_000_000],
    [/gemini-1\.5-flash/, 1_000_000],
    [/gemini-pro/, 32_000],
];

/**
 * Look up context window size for a model string.
 * Falls back to `defaultSize` (128k) if no match.
 */
export function getContextWindowForModel(model: string, defaultSize: number = 128_000): number {
    const lower = model.toLowerCase();
    // Special tag for 1M context
    if (lower.includes('[1m]')) return 1_000_000;
    for (const [regex, size] of CONTEXT_WINDOWS) {
        if (regex.test(lower)) return size;
    }
    return defaultSize;
}

// ---------------------------------------------------------------------------
// Retry utility
// ---------------------------------------------------------------------------

export interface RetryOptions {
    /**
     * Total number of attempts (initial + retries). Default 3.
     * `maxAttempts` is an alias; if both are provided, `maxAttempts` wins.
     * Note: historically named `maxRetries`, but it has always counted total
     * attempts. The name is preserved for backward compatibility.
     */
    maxRetries?: number;
    maxAttempts?: number;
    baseDelayMs?: number;
    retryableStatuses?: number[];
}

const DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    baseDelayMs: 1000,
    retryableStatuses: [429, 500, 502, 503] as number[],
};

/**
 * Wrap an async operation with retry + exponential backoff.
 * Converts known HTTP error codes into typed errors.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    opts?: RetryOptions,
): Promise<T> {
    const baseDelayMs = opts?.baseDelayMs ?? DEFAULT_RETRY_OPTIONS.baseDelayMs;
    const retryableStatuses = opts?.retryableStatuses ?? DEFAULT_RETRY_OPTIONS.retryableStatuses;
    const maxAttempts = opts?.maxAttempts ?? opts?.maxRetries ?? DEFAULT_RETRY_OPTIONS.maxAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (e: any) {
            const status = e?.status ?? e?.response?.status ?? e?.statusCode;

            // Convert to typed errors
            if (status === 401 || status === 403) {
                throw new AuthenticationError(e.message ?? 'Authentication failed');
            }

            const retryable = retryableStatuses.includes(status);
            const hasMore = attempt < maxAttempts;
            if (hasMore && retryable) {
                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                if (status === 429) {
                    const retryAfter = parseFloat(e?.headers?.['retry-after'] ?? '0') * 1000 || delay;
                    await new Promise((r) => setTimeout(r, retryAfter));
                } else {
                    await new Promise((r) => setTimeout(r, delay));
                }
                continue;
            }

            if (status === 429) {
                throw new RateLimitError(e.message ?? 'Rate limited', 0);
            }

            if (retryable) {
                throw new LLMError(`LLM call failed after ${maxAttempts} attempts: ${e.message ?? e}`, 'LLM_RETRY_EXHAUSTED');
            }

            throw e;
        }
    }
    // Unreachable: loop body either returns or throws.
    throw new LLMError('LLM call failed after retries', 'LLM_RETRY_EXHAUSTED');
}

// ---------------------------------------------------------------------------
// Usage normalization
// ---------------------------------------------------------------------------

/**
 * Normalize usage from various provider formats into a consistent shape.
 */
export function normalizeUsage(usage: any): Record<string, number> {
    if (!usage) return {};
    return {
        input_tokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
        cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    };
}

// ---------------------------------------------------------------------------
// Provider type
// ---------------------------------------------------------------------------

export type ProviderName = 'openai' | 'anthropic' | 'google';
