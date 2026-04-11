/**
 * storage/protocols.ts - Storage interfaces for Session, Memory, Skill, and Context stores.
 *
 * All methods are async (Promise-returning) to support cloud-native backends
 * such as @vercel/storage, Supabase, Planetscale, and S3.
 */

export interface SessionStore {
    get(sessionId: string): Promise<Record<string, any> | null>;
    put(sessionId: string, data: Record<string, any>): Promise<void>;
    listSummaries(limit?: number): Promise<Record<string, any>[]>;
    listIds(): Promise<string[]>;
}

export interface MemoryStore {
    load(): Promise<Record<string, any>[]>;
    save(items: Record<string, any>[]): Promise<void>;
}

export interface SkillStore {
    listSkills(): Promise<string[]>;
    getSkill(name: string): Promise<Record<string, any> | null>;
}

export interface ContextStore {
    get(sessionId: string): Promise<Record<string, any> | null>;
    set(sessionId: string, data: Record<string, any>): Promise<void>;
}

export class StorageBackend {
    sessionStore: SessionStore;
    memoryStore: MemoryStore;
    skillStore: SkillStore;
    contextStore: ContextStore;

    constructor(
        sessionStore: SessionStore,
        memoryStore: MemoryStore,
        skillStore: SkillStore,
        contextStore: ContextStore,
    ) {
        this.sessionStore = sessionStore;
        this.memoryStore = memoryStore;
        this.skillStore = skillStore;
        this.contextStore = contextStore;
    }
}
