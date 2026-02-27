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

// ---------------------------------------------------------------------------
// MemoryStore interface (optional injection)
// ---------------------------------------------------------------------------

export interface MemoryStore {
    load(): Record<string, any>[];
    save(items: Record<string, any>[]): void;
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

// Retrieval weights
export const ALPHA_RECENCY = 0.25;
export const BETA_IMPORTANCE = 0.35;
export const GAMMA_RELEVANCE = 0.40;

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

function loadMemories(): Record<string, any>[] {
    if (_memoryStore) return _memoryStore.load();
    ensureDir(MEMORY_DIR);
    if (!fs.existsSync(MEMORY_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

function saveMemories(items: Record<string, any>[]): void {
    const sanitized = sanitizeForStorage(items);
    if (_memoryStore) {
        _memoryStore.save(sanitized);
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

export function writeEvent(content: string, importance: number = 0.5): void {
    const items = loadMemories();
    const now = Date.now() / 1000;
    items.push({
        id: uuidv4(),
        type: 'episodic',
        content: (content || '').trim().slice(0, 2000),
        importance: Math.max(0, Math.min(1, importance)),
        created_at: now,
        last_accessed: now,
    });
    saveMemories(items);
}

export function writeInsight(content: string, importance: number = 0.6): void {
    const items = loadMemories();
    const now = Date.now() / 1000;
    items.push({
        id: uuidv4(),
        type: 'semantic',
        content: (content || '').trim().slice(0, 2000),
        importance: Math.max(0, Math.min(1, importance)),
        created_at: now,
        last_accessed: now,
    });
    saveMemories(items);
}

export function retrieve(
    query: string,
    k: number = 5,
    alpha: number = ALPHA_RECENCY,
    beta: number = BETA_IMPORTANCE,
    gamma: number = GAMMA_RELEVANCE,
): [string, number, Record<string, any>][] {
    if (!MEMORY_ENABLED) return [];
    const items = loadMemories();
    if (!items.length) return [];
    const now = Date.now() / 1000;
    const scored: [number, Record<string, any>][] = [];
    for (const m of items) {
        const rec = recencyScore(m.created_at, now);
        const imp = m.importance ?? 0.5;
        const rel = relevanceScore(query, m.content ?? '');
        const score = alpha * rec + beta * imp + gamma * rel;
        scored.push([score, m]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, k).map(([score, m]) => [m.content, score, m]);
}

export function garbageCollect(
    maxItems: number = MAX_MEMORY_ITEMS,
    maxAgeDays: number = MAX_MEMORY_AGE_DAYS,
): number {
    const items = loadMemories();
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
    saveMemories(kept);
    return removed;
}

export function consolidateTurn(
    userMessage: string,
    assistantSummary: string,
    toolCallsSummary?: { name: string; success: boolean }[],
): void {
    if (!MEMORY_ENABLED) return;
    if (!userMessage && !assistantSummary) return;
    const content = `User: ${userMessage.slice(0, 200)}. Assistant: ${assistantSummary.slice(0, 300)}.`;
    writeEvent(content, 0.4);
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
    const items = loadMemories();
    if (items.length > MAX_MEMORY_ITEMS) {
        garbageCollect(MAX_MEMORY_ITEMS, MAX_MEMORY_AGE_DAYS);
    }
}
