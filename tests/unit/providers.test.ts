import { describe, it, expect } from 'vitest';
import {
    getContextWindowForModel,
    withRetry,
    normalizeUsage,
} from '../../src/providers/base';
import { cosineSimilarity } from '../../src/providers/embeddings';

// ---------------------------------------------------------------------------
// getContextWindowForModel
// ---------------------------------------------------------------------------

describe('getContextWindowForModel', () => {
    it('returns 128k for gpt-4o', () => {
        expect(getContextWindowForModel('gpt-4o')).toBe(128_000);
    });

    it('returns 200k for claude-sonnet-4', () => {
        expect(getContextWindowForModel('claude-sonnet-4-20250514')).toBe(200_000);
    });

    it('returns 200k for claude-opus-4', () => {
        expect(getContextWindowForModel('claude-opus-4-20250514')).toBe(200_000);
    });

    it('returns 1M for gemini-2.0-flash', () => {
        expect(getContextWindowForModel('gemini-2.0-flash')).toBe(1_000_000);
    });

    it('returns 1M for models with [1m] tag', () => {
        expect(getContextWindowForModel('claude-sonnet-4[1m]')).toBe(1_000_000);
    });

    it('returns default for unknown model', () => {
        expect(getContextWindowForModel('unknown-model')).toBe(128_000);
    });

    it('accepts custom default', () => {
        expect(getContextWindowForModel('unknown-model', 50_000)).toBe(50_000);
    });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe('withRetry', () => {
    it('returns result on first success', async () => {
        const result = await withRetry(() => Promise.resolve('ok'));
        expect(result).toBe('ok');
    });

    it('retries on retryable status', async () => {
        let attempts = 0;
        const result = await withRetry(
            () => {
                attempts++;
                if (attempts < 2) {
                    const err: any = new Error('server error');
                    err.status = 500;
                    throw err;
                }
                return Promise.resolve('recovered');
            },
            { maxRetries: 3, baseDelayMs: 10 },
        );
        expect(result).toBe('recovered');
        expect(attempts).toBe(2);
    });

    it('throws AuthenticationError on 401', async () => {
        const { AuthenticationError } = await import('../../src/errors');
        await expect(
            withRetry(
                () => {
                    const err: any = new Error('unauthorized');
                    err.status = 401;
                    throw err;
                },
                { maxRetries: 3, baseDelayMs: 10 },
            ),
        ).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('throws RateLimitError after exhausting retries on 429', async () => {
        const { RateLimitError } = await import('../../src/errors');
        await expect(
            withRetry(
                () => {
                    const err: any = new Error('rate limit');
                    err.status = 429;
                    throw err;
                },
                { maxRetries: 2, baseDelayMs: 10 },
            ),
        ).rejects.toBeInstanceOf(RateLimitError);
    });

    it('does not retry non-retryable errors', async () => {
        let attempts = 0;
        await expect(
            withRetry(
                () => {
                    attempts++;
                    const err: any = new Error('bad request');
                    err.status = 400;
                    throw err;
                },
                { maxRetries: 3, baseDelayMs: 10 },
            ),
        ).rejects.toThrow('bad request');
        expect(attempts).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// normalizeUsage
// ---------------------------------------------------------------------------

describe('normalizeUsage', () => {
    it('normalizes OpenAI format', () => {
        const usage = normalizeUsage({
            prompt_tokens: 100,
            completion_tokens: 50,
        });
        expect(usage.input_tokens).toBe(100);
        expect(usage.output_tokens).toBe(50);
    });

    it('normalizes Anthropic format', () => {
        const usage = normalizeUsage({
            input_tokens: 200,
            output_tokens: 80,
            cache_read_input_tokens: 50,
        });
        expect(usage.input_tokens).toBe(200);
        expect(usage.output_tokens).toBe(80);
        expect(usage.cache_read_input_tokens).toBe(50);
    });

    it('handles null/undefined', () => {
        expect(normalizeUsage(null)).toEqual({});
        expect(normalizeUsage(undefined)).toEqual({});
    });
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
        const v = [1, 2, 3];
        expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
    });

    it('returns 0 for orthogonal vectors', () => {
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    });

    it('returns -1 for opposite vectors', () => {
        expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
    });

    it('returns 0 for empty vectors', () => {
        expect(cosineSimilarity([], [])).toBe(0);
    });

    it('returns 0 for mismatched lengths', () => {
        expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });
});
