import { describe, it, expect } from 'vitest';
import {
    getModelPricing,
    estimateCost,
    toTokenUsage,
    mergeTokenUsage,
    type TokenUsage,
} from '../../src/pricing';

// ---------------------------------------------------------------------------
// getModelPricing
// ---------------------------------------------------------------------------

describe('getModelPricing', () => {
    it('finds pricing for gpt-4o', () => {
        const p = getModelPricing('gpt-4o');
        expect(p).not.toBeNull();
        expect(p!.input).toBeGreaterThan(0);
        expect(p!.output).toBeGreaterThan(0);
    });

    it('finds pricing for claude-sonnet-4 with full name', () => {
        const p = getModelPricing('claude-sonnet-4-20250514');
        expect(p).not.toBeNull();
        expect(p!.cacheRead).toBeGreaterThan(0);
    });

    it('finds pricing for gemini-2.0-flash', () => {
        const p = getModelPricing('gemini-2.0-flash');
        expect(p).not.toBeNull();
    });

    it('returns null for unknown model', () => {
        expect(getModelPricing('totally-unknown-model-xyz')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// toTokenUsage
// ---------------------------------------------------------------------------

describe('toTokenUsage', () => {
    it('converts OpenAI format', () => {
        const usage = toTokenUsage({ prompt_tokens: 100, completion_tokens: 50 });
        expect(usage.inputTokens).toBe(100);
        expect(usage.outputTokens).toBe(50);
        expect(usage.totalTokens).toBe(150);
    });

    it('converts Anthropic format', () => {
        const usage = toTokenUsage({
            input_tokens: 200,
            output_tokens: 80,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 30,
        });
        expect(usage.inputTokens).toBe(200);
        expect(usage.outputTokens).toBe(80);
        expect(usage.cacheReadTokens).toBe(50);
        expect(usage.cacheCreationTokens).toBe(30);
        expect(usage.totalTokens).toBe(310);
    });
});

// ---------------------------------------------------------------------------
// mergeTokenUsage
// ---------------------------------------------------------------------------

describe('mergeTokenUsage', () => {
    it('accumulates usage from multiple calls', () => {
        const a: TokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
        const b: TokenUsage = { inputTokens: 200, outputTokens: 80, totalTokens: 280 };
        const merged = mergeTokenUsage(a, b);
        expect(merged.inputTokens).toBe(300);
        expect(merged.outputTokens).toBe(130);
        expect(merged.totalTokens).toBe(430);
    });

    it('handles cache tokens', () => {
        const a: TokenUsage = {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            cacheReadTokens: 20,
        };
        const b: TokenUsage = {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            cacheReadTokens: 30,
        };
        const merged = mergeTokenUsage(a, b);
        expect(merged.cacheReadTokens).toBe(50);
    });
});

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

describe('estimateCost', () => {
    it('calculates cost for gpt-4o', () => {
        const usage: TokenUsage = {
            inputTokens: 1_000_000,
            outputTokens: 500_000,
            totalTokens: 1_500_000,
        };
        const cost = estimateCost(usage, 'gpt-4o');
        // gpt-4o: $2.50/M input + $10/M output = $2.50 + $5.00 = $7.50
        expect(cost).toBeCloseTo(7.50, 1);
    });

    it('accounts for cache read discount', () => {
        const usage: TokenUsage = {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            totalTokens: 1_100_000,
            cacheReadTokens: 500_000,
        };
        const cost = estimateCost(usage, 'claude-sonnet-4-20250514');
        // Regular input: 500k @ $3/M = $1.50
        // Cache read: 500k @ $0.30/M = $0.15
        // Output: 100k @ $15/M = $1.50
        // Total: ~$3.15
        expect(cost).toBeCloseTo(3.15, 1);
    });

    it('returns 0 for unknown model', () => {
        const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
        expect(estimateCost(usage, 'unknown-model-xyz')).toBe(0);
    });
});
