/**
 * storage/protocols.ts - Storage interfaces for Session, Memory, Skill, and Context stores.
 */

export interface SessionStore {
    get(sessionId: string): Record<string, any> | null;
    put(sessionId: string, data: Record<string, any>): void;
    listSummaries(limit?: number): Record<string, any>[];
    listIds(): string[];
}

export interface MemoryStore {
    load(): Record<string, any>[];
    save(items: Record<string, any>[]): void;
}

export interface SkillStore {
    listSkills(): string[];
    getSkill(name: string): Record<string, any> | null;
}

export interface ContextStore {
    get(sessionId: string): Record<string, any> | null;
    set(sessionId: string, data: Record<string, any>): void;
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
