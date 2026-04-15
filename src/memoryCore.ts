/**
 * memoryCore.ts - Long-term memory store (episodic + semantic, retrieval, forgetting).
 *
 * Implements:
 * - Episodic: concrete events
 * - Semantic: distilled insights
 * - Retrieval: score = α·Recency + β·Importance + γ·Relevance
 * - Forgetting: garbage collection by TTL and max_items
 * - Sensitive data detection and sanitization
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { WORKDIR } from './config';
import type { EmbeddingProvider } from './providers/embeddings';
import { cosineSimilarity } from './providers/embeddings';

// ---------------------------------------------------------------------------
// MemoryStore interface (optional injection)
// ---------------------------------------------------------------------------

export interface MemoryStore {
    load(): Promise<Record<string, any>[]>;
    save(items: Record<string, any>[]): Promise<void>;
}

let _memoryStore: MemoryStore | null = null;

export function setMemoryStore(store: MemoryStore | null): void {
    _memoryStore = store;
}

// Disable via AGENT_MEMORY=0
export const MEMORY_ENABLED =
    !['0', 'false'].includes((process.env.AGENT_MEMORY ?? '1').trim());

const MEMORY_DIR = process.env.AGENT_MEMORY_DIR ?? path.join(WORKDIR, 'data', 'memory');
const MEMORY_FILE = path.join(MEMORY_DIR, 'memories.json');
const PREFERENCES_FILE =
    process.env.AGENT_PREFERENCES_FILE ?? path.join(MEMORY_DIR, 'preferences.json');
const PATTERNS_FILE =
    process.env.AGENT_PATTERNS_FILE ?? path.join(MEMORY_DIR, 'patterns.json');

export const MAX_HISTORY_TURNS = 30;
export const MAX_MEMORY_ITEMS = 500;
export const MAX_MEMORY_AGE_DAYS = 90;

// Retrieval weights — keyword-only profile (defaults).
export const ALPHA_RECENCY = 0.25;
export const BETA_IMPORTANCE = 0.35;
export const GAMMA_RELEVANCE = 0.40;
/** Default vector-similarity weight when an EmbeddingProvider is supplied. */
export const DELTA_EMBEDDING = 0.0;

// ---------------------------------------------------------------------------
// Embedding provider (process-wide registration; opt-in)
// ---------------------------------------------------------------------------

let _embeddingProvider: EmbeddingProvider | null = null;

/**
 * Register the global embedding provider. When set, `writeEvent` /
 * `writeInsight` will populate `embedding` on each new memory and
 * `retrieve` will blend cosine similarity into the score.
 *
 * Pass `null` to disable.
 */
export function setEmbeddingProvider(provider: EmbeddingProvider | null): void {
    _embeddingProvider = provider;
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
    return _embeddingProvider;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

async function loadMemories(): Promise<Record<string, any>[]> {
    if (_memoryStore) return _memoryStore.load();
    ensureDir(MEMORY_DIR);
    if (!fs.existsSync(MEMORY_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

async function saveMemories(items: Record<string, any>[]): Promise<void> {
    const sanitized = sanitizeForStorage(items);
    if (_memoryStore) {
        await _memoryStore.save(sanitized);
        return;
    }
    ensureDir(MEMORY_DIR);
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(sanitized, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Privacy: sensitive data detection and sanitization
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS: [RegExp, string][] = [
    [/\b(api[_-]?key|apikey)\s*[:=]\s*[\w\-]+/gi, '***'],
    [/\b(password|passwd|pwd)\s*[:=]\s*\S+/gi, '***'],
    [/\b(token|secret|auth)\s*[:=]\s*[\w\-.]+/gi, '***'],
    [/\b(credit[_\s]?card|card\s*#?)\s*[:=]?\s*\d[\d\s\-]+/gi, '***'],
];

export function detectSensitiveData(text: string): boolean {
    if (!text || typeof text !== 'string') return false;
    const lower = text.toLowerCase();
    return [
        'api_key', 'api-key', 'password', 'token', 'secret', 'credential', 'private_key',
    ].some((p) => lower.includes(p));
}

export function sanitizeForStorage(data: any): any {
    if (typeof data === 'object' && data !== null) {
        if (Array.isArray(data)) return data.map(sanitizeForStorage);
        const result: Record<string, any> = {};
        for (const [k, v] of Object.entries(data)) {
            result[k] = sanitizeForStorage(v);
        }
        return result;
    }
    if (typeof data === 'string') {
        let out = data;
        for (const [pat, repl] of SENSITIVE_PATTERNS) {
            out = out.replace(pat, repl);
        }
        return out;
    }
    return data;
}

// ---------------------------------------------------------------------------
// User preferences, project knowledge, patterns
// ---------------------------------------------------------------------------

export function loadUserPreferences(): Record<string, any> {
    const prefPath = path.isAbsolute(PREFERENCES_FILE)
        ? PREFERENCES_FILE
        : path.join(MEMORY_DIR, path.basename(PREFERENCES_FILE));
    if (!fs.existsSync(prefPath)) {
        return {
            model: process.env.MODEL_ID ?? 'gpt-4o',
            permissions: {},
            features: [],
        };
    }
    try {
        return JSON.parse(fs.readFileSync(prefPath, 'utf-8'));
    } catch {
        return { model: process.env.MODEL_ID ?? 'gpt-4o', permissions: {}, features: [] };
    }
}

export function loadProjectKnowledge(): string | null {
    const claudeMd = path.join(WORKDIR, 'CLAUDE.md');
    if (!fs.existsSync(claudeMd)) return null;
    try {
        return fs.readFileSync(claudeMd, 'utf-8').trim();
    } catch {
        return null;
    }
}

function loadPatternsRaw(): Record<string, any>[] {
    const pPath = path.isAbsolute(PATTERNS_FILE)
        ? PATTERNS_FILE
        : path.join(MEMORY_DIR, path.basename(PATTERNS_FILE));
    if (!fs.existsSync(pPath)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(pPath, 'utf-8'));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function savePatternsRaw(items: Record<string, any>[]): void {
    const pPath = path.isAbsolute(PATTERNS_FILE)
        ? PATTERNS_FILE
        : path.join(MEMORY_DIR, path.basename(PATTERNS_FILE));
    ensureDir(MEMORY_DIR);
    fs.writeFileSync(
        pPath,
        JSON.stringify(sanitizeForStorage(items), null, 2),
        'utf-8',
    );
}

export function recordPattern(pattern: Record<string, any>): void {
    const now = Date.now() / 1000;
    const patterns = loadPatternsRaw();
    const name = pattern.name ?? pattern.type ?? '';
    const existing = patterns.find(
        (p) =>
            p.name === name ||
            (p.type === pattern.type && p.context === pattern.context),
    );
    if (existing) {
        existing.frequency = (existing.frequency ?? 0) + 1;
        existing.last_used = now;
        for (const [k, v] of Object.entries(pattern)) {
            if (k !== 'frequency' && k !== 'last_used') existing[k] = v;
        }
    } else {
        patterns.push({
            ...pattern,
            frequency: pattern.frequency ?? 1,
            last_used: pattern.last_used ?? now,
        });
    }
    patterns.sort((a, b) => -(a.frequency ?? 0) + (b.frequency ?? 0) || -(a.last_used ?? 0) + (b.last_used ?? 0));
    savePatternsRaw(patterns.slice(0, 500));
}

export function getRelevantPatterns(
    query: string,
    limit: number = 5,
): Record<string, any>[] {
    if (!query?.trim()) return [];
    const words = new Set(normalizeText(query));
    const patterns = loadPatternsRaw();
    const scored: [number, Record<string, any>][] = [];
    for (const p of patterns) {
        const ctx =
            (p.context ?? '') + ' ' + (p.name ?? '') + ' ' + (p.type ?? '');
        const ctxWords = new Set(normalizeText(ctx));
        let overlap = 0;
        for (const w of words) if (ctxWords.has(w)) overlap++;
        scored.push([overlap / Math.max(1, words.size), p]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map(([, p]) => p);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function normalizeText(text: string): string[] {
    return (text ?? '').trim().toLowerCase().match(/\w{2,}/g) ?? [];
}

function relevanceScore(query: string, content: string): number {
    const qWords = new Set(normalizeText(query));
    const cWords = new Set(normalizeText(content));
    if (qWords.size === 0) return 0;
    let overlap = 0;
    for (const w of qWords) if (cWords.has(w)) overlap++;
    return Math.min(1.0, overlap / qWords.size + (0.1 * overlap) / Math.max(1, cWords.size));
}

function recencyScore(createdTs: number, now: number): number {
    const daysAgo = (now - createdTs) / 86400;
    return Math.pow(0.99, daysAgo);
}

// ---------------------------------------------------------------------------
// Core memory operations
// ---------------------------------------------------------------------------

async function tryEmbed(text: string): Promise<{ embedding: number[]; model: string } | null> {
    const provider = _embeddingProvider;
    if (!provider) return null;
    try {
        const out = await provider.embed([text]);
        if (!out.length) return null;
        return { embedding: out[0], model: provider.model };
    } catch {
        // Embedding is opt-in convenience; never block writes on failure.
        return null;
    }
}

export async function writeEvent(content: string, importance: number = 0.5): Promise<void> {
    const items = await loadMemories();
    const now = Date.now() / 1000;
    const text = (content || '').trim().slice(0, 2000);
    const emb = await tryEmbed(text);
    items.push({
        id: uuidv4(),
        type: 'episodic',
        content: text,
        importance: Math.max(0, Math.min(1, importance)),
        created_at: now,
        last_accessed: now,
        ...(emb ? { embedding: emb.embedding, embedding_model: emb.model } : {}),
    });
    await saveMemories(items);
}

export async function writeInsight(content: string, importance: number = 0.6): Promise<void> {
    const items = await loadMemories();
    const now = Date.now() / 1000;
    const text = (content || '').trim().slice(0, 2000);
    const emb = await tryEmbed(text);
    items.push({
        id: uuidv4(),
        type: 'semantic',
        content: text,
        importance: Math.max(0, Math.min(1, importance)),
        created_at: now,
        last_accessed: now,
        ...(emb ? { embedding: emb.embedding, embedding_model: emb.model } : {}),
    });
    await saveMemories(items);
}

/**
 * Retrieval config. Pass `delta > 0` and have `setEmbeddingProvider()`
 * configured (and items with stored embeddings) to enable hybrid
 * vector + keyword retrieval. Defaults preserve the legacy keyword-only
 * scoring exactly.
 */
export interface RetrievalConfig {
    alpha?: number;
    beta?: number;
    gamma?: number;
    delta?: number;
    /** When true, override `delta` to 0.40 if a provider is registered. */
    autoEnableEmbeddings?: boolean;
}

export async function retrieve(
    query: string,
    k: number = 5,
    configOrAlpha: RetrievalConfig | number = {},
    legacyBeta?: number,
    legacyGamma?: number,
): Promise<[string, number, Record<string, any>][]> {
    if (!MEMORY_ENABLED) return [];

    // Backwards-compat shim: callers used to pass (query, k, alpha, beta, gamma).
    let cfg: RetrievalConfig;
    if (typeof configOrAlpha === 'number') {
        cfg = {
            alpha: configOrAlpha,
            beta: legacyBeta ?? BETA_IMPORTANCE,
            gamma: legacyGamma ?? GAMMA_RELEVANCE,
        };
    } else {
        cfg = configOrAlpha;
    }

    const alpha = cfg.alpha ?? ALPHA_RECENCY;
    const beta = cfg.beta ?? BETA_IMPORTANCE;
    const gamma = cfg.gamma ?? GAMMA_RELEVANCE;
    let delta = cfg.delta ?? DELTA_EMBEDDING;
    if (cfg.autoEnableEmbeddings && _embeddingProvider) delta = Math.max(delta, 0.40);

    const items = await loadMemories();
    if (!items.length) return [];

    // Query embedding, only if vector weight matters and we have a provider.
    let queryEmbedding: number[] | null = null;
    if (delta > 0 && _embeddingProvider) {
        try {
            const out = await _embeddingProvider.embed([query]);
            queryEmbedding = out[0] ?? null;
        } catch {
            queryEmbedding = null;
        }
    }

    const now = Date.now() / 1000;
    const scored: [number, Record<string, any>][] = [];
    for (const m of items) {
        const rec = recencyScore(m.created_at, now);
        const imp = m.importance ?? 0.5;
        const rel = relevanceScore(query, m.content ?? '');
        let emb = 0;
        if (queryEmbedding && Array.isArray(m.embedding) && m.embedding.length === queryEmbedding.length) {
            emb = cosineSimilarity(queryEmbedding, m.embedding);
        }
        const score = alpha * rec + beta * imp + gamma * rel + delta * emb;
        scored.push([score, m]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, k).map(([score, m]) => [m.content, score, m]);
}

export async function garbageCollect(
    maxItems: number = MAX_MEMORY_ITEMS,
    maxAgeDays: number = MAX_MEMORY_AGE_DAYS,
): Promise<number> {
    const items = await loadMemories();
    const now = Date.now() / 1000;
    const cutoffTs = now - maxAgeDays * 86400;
    let kept = items.filter(
        (m) => m.created_at >= cutoffTs || (m.importance ?? 0) >= 0.7,
    );
    kept.sort(
        (a, b) => -(a.importance ?? 0) + (b.importance ?? 0) || -a.created_at + b.created_at,
    );
    kept = kept.slice(0, maxItems);
    const removed = items.length - kept.length;
    await saveMemories(kept);
    return removed;
}

export async function consolidateTurn(
    userMessage: string,
    assistantSummary: string,
    toolCallsSummary?: { name: string; success: boolean }[],
): Promise<void> {
    if (!MEMORY_ENABLED) return;
    if (!userMessage && !assistantSummary) return;
    const content = `User: ${userMessage.slice(0, 200)}. Assistant: ${assistantSummary.slice(0, 300)}.`;
    await writeEvent(content, 0.4);
    recordPattern({
        type: 'turn',
        name: 'conversation_turn',
        context: userMessage.slice(0, 150),
    });
    if (toolCallsSummary) {
        for (const tc of toolCallsSummary) {
            if (tc.success) {
                recordPattern({
                    type: 'tool_use',
                    name: tc.name ?? 'tool',
                    context: userMessage.slice(0, 100),
                });
            }
        }
    }
    const items = await loadMemories();
    if (items.length > MAX_MEMORY_ITEMS) {
        await garbageCollect(MAX_MEMORY_ITEMS, MAX_MEMORY_AGE_DAYS);
    }
}
