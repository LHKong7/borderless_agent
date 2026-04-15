/**
 * storage/index.ts - Storage abstraction: file and cloud backends.
 *
 * Usage:
 *   Backend selection: set AGENT_STORAGE_BACKEND=file (default) or cloud.
 *   getStorageBackend() returns the backend for the current config.
 */

import {
    StorageBackend,
    SessionStore,
    MemoryStore,
    SkillStore,
    ContextStore,
} from './protocols';
import { createFileBackend } from './fileBackend';

let _defaultBackend: StorageBackend | null = null;

export async function getStorageBackend(options?: {
    backend?: string;
    sessionDir?: string;
    memoryFile?: string;
    skillsDir?: string;
    contextDir?: string;
}): Promise<StorageBackend> {
    const choice = (
        options?.backend ??
        process.env.AGENT_STORAGE_BACKEND ??
        'file'
    )
        .trim()
        .toLowerCase();

    if (choice === 'cloud') {
        const { createCloudBackend } = await import('./cloudBackend');
        _defaultBackend = await createCloudBackend();
    } else {
        _defaultBackend = createFileBackend({
            sessionDir: options?.sessionDir,
            memoryFile: options?.memoryFile,
            skillsDir: options?.skillsDir,
            contextDir: options?.contextDir,
        });
    }
    return _defaultBackend!;
}

async function ensureBackend(): Promise<StorageBackend> {
    if (!_defaultBackend) await getStorageBackend();
    return _defaultBackend!;
}

export async function getDefaultSessionStore(): Promise<SessionStore> {
    return (await ensureBackend()).sessionStore;
}

export async function getDefaultMemoryStore(): Promise<MemoryStore> {
    return (await ensureBackend()).memoryStore;
}

export async function getDefaultSkillStore(): Promise<SkillStore> {
    return (await ensureBackend()).skillStore;
}

export async function getDefaultContextStore(): Promise<ContextStore> {
    return (await ensureBackend()).contextStore;
}

export {
    StorageBackend,
    SessionStore,
    MemoryStore,
    SkillStore,
    ContextStore,
} from './protocols';
