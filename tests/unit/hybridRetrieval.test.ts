/**
 * Hybrid retrieval tests — exercise the embedding-aware code paths in
 * memoryCore via a fake MemoryStore + a stub EmbeddingProvider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    setMemoryStore,
    setEmbeddingProvider,
    writeEvent,
    retrieve,
} from '../../src/memoryCore';
import type { MemoryStore } from '../../src/memoryCore';
import type { EmbeddingProvider } from '../../src/providers/embeddings';

class InMemoryStore implements MemoryStore {
    items: Record<string, any>[] = [];
    async load() { return this.items; }
    async save(items: Record<string, any>[]) { this.items = items; }
}

/**
 * Stub provider: each input string gets a 4-d vector that puts
 * "alpha"-tagged content close to "alpha" queries and far from "beta".
 */
class StubEmbedder implements EmbeddingProvider {
    readonly model = 'stub-1';
    readonly dimensions = 4;
    async embed(texts: string[]): Promise<number[][]> {
        return texts.map((t) => {
            const lower = t.toLowerCase();
            const alpha = lower.includes('alpha') ? 1 : 0;
            const beta = lower.includes('beta') ? 1 : 0;
            return [alpha, beta, 0.1, 0.1];
        });
    }
}

describe('memoryCore hybrid retrieval', () => {
    let store: InMemoryStore;
    beforeEach(() => {
        store = new InMemoryStore();
        setMemoryStore(store);
        setEmbeddingProvider(null);
    });
    afterEach(() => {
        setMemoryStore(null);
        setEmbeddingProvider(null);
    });

    it('falls back to keyword scoring when no provider is set', async () => {
        await writeEvent('alpha note about cats', 0.5);
        await writeEvent('beta note about dogs', 0.5);
        const out = await retrieve('cats', 5);
        expect(out[0][0]).toContain('cats');
    });

    it('persists an embedding when a provider is set', async () => {
        setEmbeddingProvider(new StubEmbedder());
        await writeEvent('alpha note', 0.5);
        expect(store.items[0].embedding).toEqual([1, 0, 0.1, 0.1]);
        expect(store.items[0].embedding_model).toBe('stub-1');
    });

    it('blends cosine similarity into the score when delta > 0', async () => {
        setEmbeddingProvider(new StubEmbedder());
        await writeEvent('alpha is great for X', 0.5);
        await writeEvent('beta is great for Y', 0.5);
        // Pure-keyword query that doesn't hit either content; embedding
        // alone should rank "alpha" first because the query is "alpha-ish".
        const out = await retrieve('alpha', 2, { autoEnableEmbeddings: true, alpha: 0, beta: 0, gamma: 0, delta: 1 });
        expect(out[0][0]).toContain('alpha');
        expect(out[1][0]).toContain('beta');
    });

    it('autoEnableEmbeddings respects an absent provider gracefully', async () => {
        await writeEvent('alpha note', 0.5);
        const out = await retrieve('alpha', 1, { autoEnableEmbeddings: true });
        expect(out).toHaveLength(1);
    });

    it('keeps backwards-compatible positional alpha/beta/gamma signature', async () => {
        await writeEvent('one', 0.5);
        await writeEvent('two', 0.9);
        // Pass importance-heavy weights positionally.
        const out = await retrieve('xyz', 2, 0.0, 1.0, 0.0);
        // higher-importance item should rank first
        expect(out[0][2].importance).toBe(0.9);
    });
});
