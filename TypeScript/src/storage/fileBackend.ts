/**
 * storage/fileBackend.ts - File-backed storage implementations.
 *
 * All methods are async to match the storage interface contract.
 * Internally uses synchronous fs operations (wrapped in async)
 * for zero-overhead local usage.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WORKDIR } from '../config';
import {
    SessionStore,
    MemoryStore,
    SkillStore,
    ContextStore,
    StorageBackend,
} from './protocols';

// Default paths
const DEFAULT_SESSION_DIR =
    process.env.AGENT_SESSION_DIR ?? path.join(WORKDIR, 'data', 'sessions');
const DEFAULT_MEMORY_DIR =
    process.env.AGENT_MEMORY_DIR ?? path.join(WORKDIR, 'data', 'memory');
const DEFAULT_MEMORY_FILE = path.join(DEFAULT_MEMORY_DIR, 'memories.json');
const DEFAULT_SKILLS_DIR =
    process.env.AGENT_SKILLS_DIR ?? path.join(WORKDIR, 'skills');
const DEFAULT_CONTEXT_DIR =
    process.env.AGENT_CONTEXT_DIR ?? path.join(WORKDIR, 'data', 'context');

function ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

function jsonRead(filePath: string): any | null {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

function jsonWrite(filePath: string, data: any): void {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// FileSessionStore
// ---------------------------------------------------------------------------

export class FileSessionStore implements SessionStore {
    private _dir: string;

    constructor(storageDir?: string) {
        this._dir = storageDir ?? DEFAULT_SESSION_DIR;
    }

    private _path(sessionId: string): string {
        return path.join(this._dir, `${sessionId}.json`);
    }

    async get(sessionId: string): Promise<Record<string, any> | null> {
        return jsonRead(this._path(sessionId));
    }

    async put(sessionId: string, data: Record<string, any>): Promise<void> {
        ensureDir(this._dir);
        jsonWrite(this._path(sessionId), data);
    }

    async listIds(): Promise<string[]> {
        const ids = new Set<string>();
        if (fs.existsSync(this._dir)) {
            for (const f of fs.readdirSync(this._dir)) {
                if (f.endsWith('.json')) ids.add(path.basename(f, '.json'));
            }
        }
        return [...ids].sort();
    }

    async listSummaries(limit: number = 20): Promise<Record<string, any>[]> {
        const entries: Record<string, any>[] = [];
        const seen = new Set<string>();
        if (fs.existsSync(this._dir)) {
            for (const f of fs.readdirSync(this._dir)) {
                if (!f.endsWith('.json')) continue;
                const sid = path.basename(f, '.json');
                if (seen.has(sid)) continue;
                const data = jsonRead(path.join(this._dir, f));
                if (!data) continue;
                entries.push({
                    id: sid,
                    updated_at: data.updated_at ?? 0,
                    turns: (data.history ?? []).filter(
                        (m: any) => m.role === 'user',
                    ).length,
                    state: data.state ?? 'active',
                });
                seen.add(sid);
            }
        }
        entries.sort((a, b) => b.updated_at - a.updated_at);
        return entries.slice(0, limit);
    }
}

// ---------------------------------------------------------------------------
// FileMemoryStore
// ---------------------------------------------------------------------------

export class FileMemoryStore implements MemoryStore {
    private _path: string;

    constructor(memoryFile?: string) {
        this._path = memoryFile ?? DEFAULT_MEMORY_FILE;
    }

    async load(): Promise<Record<string, any>[]> {
        const data = jsonRead(this._path);
        return Array.isArray(data) ? data : [];
    }

    async save(items: Record<string, any>[]): Promise<void> {
        jsonWrite(this._path, items);
    }
}

// ---------------------------------------------------------------------------
// FileSkillStore
// ---------------------------------------------------------------------------

export class FileSkillStore implements SkillStore {
    private _dir: string;
    private _cache: Record<string, Record<string, any>> = {};

    constructor(skillsDir?: string) {
        this._dir = skillsDir ?? DEFAULT_SKILLS_DIR;
    }

    private _parseSkillMd(filePath: string): Record<string, any> | null {
        if (!fs.existsSync(filePath)) return null;
        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return null;
        }
        const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
        if (!match) return null;
        const [, frontmatter, body] = match;
        const metadata: Record<string, string> = {};
        for (const line of frontmatter.trim().split('\n')) {
            const idx = line.indexOf(':');
            if (idx >= 0) {
                const key = line.slice(0, idx).trim();
                const value = line
                    .slice(idx + 1)
                    .trim()
                    .replace(/^["']|["']$/g, '');
                metadata[key] = value;
            }
        }
        if (!metadata.name || !metadata.description) return null;
        return {
            name: metadata.name,
            description: metadata.description,
            body: body.trim(),
            path: filePath,
            dir: path.dirname(filePath),
        };
    }

    async listSkills(): Promise<string[]> {
        this._cache = {};
        if (!fs.existsSync(this._dir)) return [];
        const out: string[] = [];
        for (const entry of fs.readdirSync(this._dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const skillMd = path.join(this._dir, entry.name, 'SKILL.md');
            if (!fs.existsSync(skillMd)) continue;
            const skill = this._parseSkillMd(skillMd);
            if (skill) {
                this._cache[skill.name] = skill;
                out.push(skill.name);
            }
        }
        return out;
    }

    async getSkill(name: string): Promise<Record<string, any> | null> {
        if (!Object.keys(this._cache).length && fs.existsSync(this._dir)) {
            await this.listSkills();
        }
        return this._cache[name] ?? null;
    }
}

// ---------------------------------------------------------------------------
// FileContextStore
// ---------------------------------------------------------------------------

export class FileContextStore implements ContextStore {
    private _dir: string;

    constructor(contextDir?: string) {
        this._dir = contextDir ?? DEFAULT_CONTEXT_DIR;
    }

    private _path(sessionId: string): string {
        return path.join(this._dir, `${sessionId}.json`);
    }

    async get(sessionId: string): Promise<Record<string, any> | null> {
        const data = jsonRead(this._path(sessionId));
        return data && typeof data === 'object' && !Array.isArray(data)
            ? data
            : null;
    }

    async set(sessionId: string, data: Record<string, any>): Promise<void> {
        jsonWrite(this._path(sessionId), data);
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFileBackend(options?: {
    sessionDir?: string;
    memoryFile?: string;
    skillsDir?: string;
    contextDir?: string;
}): StorageBackend {
    return new StorageBackend(
        new FileSessionStore(options?.sessionDir),
        new FileMemoryStore(options?.memoryFile),
        new FileSkillStore(options?.skillsDir),
        new FileContextStore(options?.contextDir),
    );
}
