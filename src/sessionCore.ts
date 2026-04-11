/**
 * sessionCore.ts - Session manager: lifecycle, conversation history, persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { WORKDIR } from './config';
import { SessionStore } from './storage/protocols';

const SESSION_DIR =
    process.env.AGENT_SESSION_DIR ?? path.join(WORKDIR, 'data', 'sessions');
export const SESSION_STATE_ACTIVE = 'active';
export const SESSION_STATE_ARCHIVED = 'archived';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class Session {
    id: string;
    state: string;
    history: Record<string, any>[];
    context: Record<string, any>;
    createdAt: number;
    updatedAt: number;

    constructor(options: {
        id: string;
        state?: string;
        history?: Record<string, any>[];
        context?: Record<string, any>;
        createdAt?: number;
        updatedAt?: number;
    }) {
        this.id = options.id;
        this.state = options.state ?? SESSION_STATE_ACTIVE;
        this.history = options.history ?? [];
        this.context = options.context ?? {};
        this.createdAt = options.createdAt ?? Date.now() / 1000;
        this.updatedAt = options.updatedAt ?? Date.now() / 1000;
    }

    toDict(): Record<string, any> {
        return {
            id: this.id,
            state: this.state,
            history: this.history,
            context: this.context,
            created_at: this.createdAt,
            updated_at: this.updatedAt,
        };
    }

    static fromDict(data: Record<string, any>): Session {
        return new Session({
            id: data.id,
            state: data.state ?? SESSION_STATE_ACTIVE,
            history: data.history ?? [],
            context: data.context ?? {},
            createdAt: data.created_at ?? Date.now() / 1000,
            updatedAt: data.updated_at ?? Date.now() / 1000,
        });
    }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
    private _storageDir: string;
    private _store: SessionStore | null;
    private _sessions: Map<string, Session> = new Map();
    private _activeSessionId: string | null = null;
    private _saveLocks: Map<string, Promise<void>> = new Map();

    constructor(options?: { storageDir?: string; store?: SessionStore | null }) {
        this._storageDir = options?.storageDir ?? SESSION_DIR;
        this._store = options?.store ?? null;
        if (!this._store) {
            this._ensureStorageDir();
        }
    }

    private _ensureStorageDir(): void {
        fs.mkdirSync(this._storageDir, { recursive: true });
    }

    private _sessionFile(sessionId: string): string {
        return path.join(this._storageDir, `${sessionId}.json`);
    }

    get sessions(): Map<string, Session> {
        return this._sessions;
    }

    get activeSession(): Session | null {
        if (!this._activeSessionId) return null;
        return this._sessions.get(this._activeSessionId) ?? null;
    }

    async createSession(options?: {
        context?: Record<string, any>;
        loadConversationHistory?: boolean;
    }): Promise<Session> {
        const sessionId = uuidv4();
        let history: Record<string, any>[] = [];
        if (options?.loadConversationHistory) {
            const last = await this._loadLatestFromDisk();
            if (last) {
                history = (last.history ?? []).slice(0, 50);
            }
        }
        const session = new Session({
            id: sessionId,
            state: SESSION_STATE_ACTIVE,
            history,
            context: options?.context ?? {},
        });
        this._sessions.set(sessionId, session);
        this._activeSessionId = sessionId;
        await this.saveSession(session);
        return session;
    }

    async restoreSession(sessionId: string): Promise<Session | null> {
        if (this._sessions.has(sessionId)) {
            this._activeSessionId = sessionId;
            return this._sessions.get(sessionId)!;
        }
        const data = await this._loadFromDisk(sessionId);
        if (!data) return null;
        const session = Session.fromDict(data);
        this._sessions.set(sessionId, session);
        this._activeSessionId = sessionId;
        return session;
    }

    async setActiveSession(sessionId: string): Promise<Session | null> {
        if (!this._sessions.has(sessionId)) {
            return this.restoreSession(sessionId);
        }
        this._activeSessionId = sessionId;
        return this._sessions.get(sessionId)!;
    }

    getActiveSession(): Session | null {
        return this.activeSession;
    }

    recordFileAccess(filePath: string): void {
        const active = this.activeSession;
        if (!active || !filePath?.trim()) return;
        const now = Date.now() / 1000;
        const recent: Record<string, any>[] = active.context.recent_files ?? [];
        const normalized = filePath.trim();
        const found = recent.find((f) => f.path === normalized);
        if (found) {
            found.access_count = (found.access_count ?? 0) + 1;
            found.last_accessed = now;
        } else {
            recent.push({ path: normalized, access_count: 1, last_accessed: now });
        }
        recent.sort(
            (a, b) =>
                -(a.access_count ?? 0) + (b.access_count ?? 0) ||
                -(a.last_accessed ?? 0) + (b.last_accessed ?? 0),
        );
        active.context.recent_files = recent.slice(0, 100);
    }

    async saveSession(session: Session): Promise<void> {
        // #13: per-session mutex to prevent concurrent write corruption
        const prev = this._saveLocks.get(session.id) ?? Promise.resolve();
        const current = prev.then(() => this._doSaveSession(session)).catch((e) => {
            console.error(`[SessionManager] Failed to save session ${session.id}:`, e);
        });
        this._saveLocks.set(session.id, current);
        await current;
    }

    private async _doSaveSession(session: Session): Promise<void> {
        session.updatedAt = Date.now() / 1000;
        let data = session.toDict();
        try {
            const { sanitizeForStorage } = require('./memoryCore');
            data = sanitizeForStorage(data);
        } catch {
            // memoryCore not available
        }
        if (this._store) {
            await this._store.put(session.id, data);
            return;
        }
        this._ensureStorageDir();
        const filePath = this._sessionFile(session.id);
        // #3: atomic write — write to temp file then rename
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmpPath, filePath);
    }

    async saveActive(): Promise<void> {
        const s = this.activeSession;
        if (s) await this.saveSession(s);
    }

    private async _loadFromDisk(sessionId: string): Promise<Record<string, any> | null> {
        if (this._store) return this._store.get(sessionId);
        const filePath = this._sessionFile(sessionId);
        if (!fs.existsSync(filePath)) return null;
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (e) {
            console.error(`[SessionManager] Corrupted session file ${filePath}:`, e);
            return null;
        }
    }

    private async _loadLatestFromDisk(): Promise<Record<string, any> | null> {
        if (this._store) {
            const summaries = await this._store.listSummaries(1);
            if (!summaries.length) return null;
            return this._store.get(summaries[0].id);
        }
        this._ensureStorageDir();
        let latest: { time: number; data: Record<string, any> } | null = null;
        if (fs.existsSync(this._storageDir)) {
            for (const f of fs.readdirSync(this._storageDir)) {
                if (!f.endsWith('.json')) continue;
                try {
                    const data = JSON.parse(
                        fs.readFileSync(path.join(this._storageDir, f), 'utf-8'),
                    );
                    const updated = data.updated_at ?? 0;
                    if (!latest || updated > latest.time) {
                        latest = { time: updated, data };
                    }
                } catch {
                    continue;
                }
            }
        }
        return latest?.data ?? null;
    }

    async listSessionIds(): Promise<string[]> {
        const ids = new Set(this._sessions.keys());
        if (this._store) {
            for (const id of await this._store.listIds()) ids.add(id);
        } else if (fs.existsSync(this._storageDir)) {
            for (const f of fs.readdirSync(this._storageDir)) {
                if (f.endsWith('.json')) ids.add(path.basename(f, '.json'));
            }
        }
        return [...ids].sort();
    }

    async listSessionsSummary(limit: number = 20): Promise<Record<string, any>[]> {
        if (this._store) return this._store.listSummaries(limit);
        const entries: Record<string, any>[] = [];
        const seen = new Set<string>();

        for (const [sid, session] of this._sessions) {
            entries.push({
                id: sid,
                updated_at: session.updatedAt,
                turns: session.history.filter((m) => m.role === 'user').length,
                state: session.state,
            });
            seen.add(sid);
        }

        if (fs.existsSync(this._storageDir)) {
            for (const f of fs.readdirSync(this._storageDir)) {
                if (!f.endsWith('.json')) continue;
                const sid = path.basename(f, '.json');
                if (seen.has(sid)) continue;
                try {
                    const data = JSON.parse(
                        fs.readFileSync(path.join(this._storageDir, f), 'utf-8'),
                    );
                    entries.push({
                        id: sid,
                        updated_at: data.updated_at ?? 0,
                        turns: (data.history ?? []).filter(
                            (m: any) => m.role === 'user',
                        ).length,
                        state: data.state ?? 'unknown',
                    });
                } catch {
                    continue;
                }
            }
        }

        entries.sort((a, b) => b.updated_at - a.updated_at);
        return entries.slice(0, limit);
    }

    async archiveSession(sessionId: string): Promise<boolean> {
        let s = this._sessions.get(sessionId) ?? null;
        if (!s) {
            const d = await this._loadFromDisk(sessionId);
            if (d) s = Session.fromDict(d);
        }
        if (!s) return false;
        s.state = SESSION_STATE_ARCHIVED;
        this._sessions.set(sessionId, s);
        await this.saveSession(s);
        if (this._activeSessionId === sessionId) {
            this._activeSessionId = null;
        }
        return true;
    }
}
