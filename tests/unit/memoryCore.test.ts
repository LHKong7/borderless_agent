import { describe, it, expect } from 'vitest';
import {
    detectSensitiveData,
    sanitizeForStorage,
    ALPHA_RECENCY,
    BETA_IMPORTANCE,
    GAMMA_RELEVANCE,
} from '../../src/memoryCore';

// ---------------------------------------------------------------------------
// Sensitive data detection
// ---------------------------------------------------------------------------

describe('detectSensitiveData', () => {
    it('detects api_key', () => {
        expect(detectSensitiveData('my api_key is abc123')).toBe(true);
    });

    it('detects password', () => {
        expect(detectSensitiveData('password=secret')).toBe(true);
    });

    it('detects token', () => {
        expect(detectSensitiveData('auth token: abc')).toBe(true);
    });

    it('returns false for normal text', () => {
        expect(detectSensitiveData('The weather is nice today')).toBe(false);
    });

    it('handles empty/null input', () => {
        expect(detectSensitiveData('')).toBe(false);
        expect(detectSensitiveData(null as any)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

describe('sanitizeForStorage', () => {
    it('redacts api key patterns', () => {
        const input = 'api_key=sk-abc123xyz';
        const result = sanitizeForStorage(input);
        expect(result).toBe('***');
        expect(result).not.toContain('sk-abc123xyz');
    });

    it('redacts password patterns', () => {
        const result = sanitizeForStorage('password=mysecret123');
        expect(result).toBe('***');
    });

    it('redacts token patterns', () => {
        const result = sanitizeForStorage('token=ghp_abcdef12345');
        expect(result).toBe('***');
    });

    it('leaves normal text unchanged', () => {
        const text = 'The quick brown fox';
        expect(sanitizeForStorage(text)).toBe(text);
    });

    it('sanitizes nested objects', () => {
        const data = {
            name: 'test',
            config: { apikey: 'api_key=sk-secret' },
        };
        const result = sanitizeForStorage(data);
        expect(result.config.apikey).toBe('***');
    });

    it('sanitizes arrays', () => {
        const data = ['normal', 'password=secret'];
        const result = sanitizeForStorage(data);
        expect(result[0]).toBe('normal');
        expect(result[1]).toBe('***');
    });

    it('preserves non-string/non-object values', () => {
        expect(sanitizeForStorage(42)).toBe(42);
        expect(sanitizeForStorage(true)).toBe(true);
        expect(sanitizeForStorage(null)).toBe(null);
    });
});

// ---------------------------------------------------------------------------
// Retrieval weights
// ---------------------------------------------------------------------------

describe('retrieval weights', () => {
    it('weights sum to 1', () => {
        expect(ALPHA_RECENCY + BETA_IMPORTANCE + GAMMA_RELEVANCE).toBeCloseTo(1.0);
    });

    it('relevance has highest weight', () => {
        expect(GAMMA_RELEVANCE).toBeGreaterThan(ALPHA_RECENCY);
        expect(GAMMA_RELEVANCE).toBeGreaterThan(BETA_IMPORTANCE);
    });
});
