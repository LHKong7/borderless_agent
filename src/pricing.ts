/**
 * pricing.ts — Model pricing lookup table for cost estimation.
 *
 * Prices in USD per million tokens. Updated as of 2025-05.
 * Users can override via builder.setModelPricing().
 */

export interface ModelPricing {
    /** USD per 1M input tokens. */
    input: number;
    /** USD per 1M output tokens. */
    output: number;
    /** USD per 1M cached read input tokens (if supported). */
    cacheRead?: number;
    /** USD per 1M cache creation input tokens (if supported). */
    cacheCreation?: number;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
}

// ---------------------------------------------------------------------------
// Default pricing table (USD per 1M tokens)
// ---------------------------------------------------------------------------

const DEFAULT_PRICING: Record<string, ModelPricing> = {
    // OpenAI
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4-turbo': { input: 10.00, output: 30.00 },
    'gpt-4': { input: 30.00, output: 60.00 },
    'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
    'o1': { input: 15.00, output: 60.00 },
    'o1-mini': { input: 3.00, output: 12.00 },
    'o3': { input: 10.00, output: 40.00 },
    'o3-mini': { input: 1.10, output: 4.40 },
    'o4-mini': { input: 1.10, output: 4.40 },

    // Anthropic
    'claude-opus-4': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreation: 18.75 },
    'claude-sonnet-4': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
    'claude-3-5-sonnet': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
    'claude-3-5-haiku': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheCreation: 1.00 },
    'claude-3-opus': { input: 15.00, output: 75.00 },
    'claude-3-sonnet': { input: 3.00, output: 15.00 },
    'claude-3-haiku': { input: 0.25, output: 1.25 },

    // Google
    'gemini-2.5-pro': { input: 1.25, output: 10.00 },
    'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    'gemini-2.0-flash': { input: 0.10, output: 0.40 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00 },
    'gemini-1.5-flash': { input: 0.075, output: 0.30 },
};

let _customPricing: Record<string, ModelPricing> = {};

/**
 * Set custom model pricing (merged with defaults, overrides take precedence).
 */
export function setModelPricing(pricing: Record<string, ModelPricing>): void {
    _customPricing = { ..._customPricing, ...pricing };
}

/**
 * Look up pricing for a model. Matches by prefix (longest match wins).
 */
export function getModelPricing(model: string): ModelPricing | null {
    const merged = { ...DEFAULT_PRICING, ..._customPricing };
    const lower = model.toLowerCase();

    // Exact match first
    if (merged[lower]) return merged[lower];

    // Prefix match (longest first)
    let bestMatch: string | null = null;
    for (const key of Object.keys(merged)) {
        if (lower.startsWith(key) || lower.includes(key)) {
            if (!bestMatch || key.length > bestMatch.length) {
                bestMatch = key;
            }
        }
    }

    return bestMatch ? merged[bestMatch] : null;
}

/**
 * Calculate estimated cost in USD from token usage and model.
 */
export function estimateCost(usage: TokenUsage, model: string): number {
    const pricing = getModelPricing(model);
    if (!pricing) return 0;

    const perM = 1_000_000;
    let cost = 0;

    // Input cost (subtract cached tokens from regular input)
    const regularInput = usage.inputTokens - (usage.cacheReadTokens ?? 0);
    cost += (regularInput / perM) * pricing.input;

    // Cache read cost
    if (usage.cacheReadTokens && pricing.cacheRead) {
        cost += (usage.cacheReadTokens / perM) * pricing.cacheRead;
    }

    // Cache creation cost
    if (usage.cacheCreationTokens && pricing.cacheCreation) {
        cost += (usage.cacheCreationTokens / perM) * pricing.cacheCreation;
    }

    // Output cost
    cost += (usage.outputTokens / perM) * pricing.output;

    return Math.max(0, cost);
}

/**
 * Convert raw LLM usage (Record<string, number>) to TokenUsage.
 */
export function toTokenUsage(raw: Record<string, number>): TokenUsage {
    const input = raw.input_tokens ?? raw.prompt_tokens ?? 0;
    const output = raw.output_tokens ?? raw.completion_tokens ?? 0;
    const cacheRead = raw.cache_read_input_tokens ?? 0;
    const cacheCreation = raw.cache_creation_input_tokens ?? 0;
    return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output + cacheCreation,
        cacheReadTokens: cacheRead || undefined,
        cacheCreationTokens: cacheCreation || undefined,
    };
}

/**
 * Merge two TokenUsage objects (accumulate).
 */
export function mergeTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        totalTokens: a.totalTokens + b.totalTokens,
        cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) || undefined,
        cacheCreationTokens: (a.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0) || undefined,
    };
}
