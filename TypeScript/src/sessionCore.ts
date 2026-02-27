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

    createSession(options?: {
        context?: Record<string, any>;
        loadConversationHistory?: boolean;
    }): Session {
        const sessionId = uuidv4();
        let history: Record<string, any>[] = [];
        if (options?.loadConversationHistory) {
            const last = this._loadLatestFromDisk();
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
        this.saveSession(session);
        return session;
    }

    restoreSession(sessionId: string): Session | null {
        if (this._sessions.has(sessionId)) {
            this._activeSessionId = sessionId;
            return this._sessions.get(sessionId)!;
        }
        const data = this._loadFromDisk(sessionId);
        if (!data) return null;
        const session = Session.fromDict(data);
        this._sessions.set(sessionId, session);
        this._activeSessionId = sessionId;
        return session;
    }

    setActiveSession(sessionId: string): Session | null {
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

    saveSession(session: Session): void {
        session.updatedAt = Date.now() / 1000;
        let data = session.toDict();
        try {
            const { sanitizeForStorage } = require('./memoryCore');
            data = sanitizeForStorage(data);
        } catch {
            // memoryCore not available
        }
        if (this._store) {
            this._store.put(session.id, data);
            return;
        }
        this._ensureStorageDir();
        const filePath = this._sessionFile(session.id);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }

    saveActive(): void {
        const s = this.activeSession;
        if (s) this.saveSession(s);
    }

    private _loadFromDisk(sessionId: string): Record<string, any> | null {
        if (this._store) return this._store.get(sessionId);
        const filePath = this._sessionFile(sessionId);
        if (!fs.existsSync(filePath)) return null;
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return null;
        }
    }

    private _loadLatestFromDisk(): Record<string, any> | null {
        if (this._store) {
            const summaries = this._store.listSummaries(1);
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

    listSessionIds(): string[] {
        const ids = new Set(this._sessions.keys());
        if (this._store) {
            for (const id of this._store.listIds()) ids.add(id);
        } else if (fs.existsSync(this._storageDir)) {
            for (const f of fs.readdirSync(this._storageDir)) {
                if (f.endsWith('.json')) ids.add(path.basename(f, '.json'));
            }
        }
        return [...ids].sort();
    }

    listSessionsSummary(limit: number = 20): Record<string, any>[] {
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

    archiveSession(sessionId: string): boolean {
        let s = this._sessions.get(sessionId) ?? null;
        if (!s) {
            const d = this._loadFromDisk(sessionId);
            if (d) s = Session.fromDict(d);
        }
        if (!s) return false;
        s.state = SESSION_STATE_ARCHIVED;
        this._sessions.set(sessionId, s);
        this.saveSession(s);
        if (this._activeSessionId === sessionId) {
            this._activeSessionId = null;
        }
        return true;
    }
}
