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

export function getStorageBackend(options?: {
    backend?: string;
    sessionDir?: string;
    memoryFile?: string;
    skillsDir?: string;
    contextDir?: string;
}): StorageBackend {
    const choice = (
        options?.backend ??
        process.env.AGENT_STORAGE_BACKEND ??
        'file'
    )
        .trim()
        .toLowerCase();

    if (choice === 'cloud') {
        // Dynamic import to avoid requiring @aws-sdk when using file backend
        const { createCloudBackend } = require('./cloudBackend');
        _defaultBackend = createCloudBackend();
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

function ensureBackend(): StorageBackend {
    if (!_defaultBackend) getStorageBackend();
    return _defaultBackend!;
}

export function getDefaultSessionStore(): SessionStore {
    return ensureBackend().sessionStore;
}

export function getDefaultMemoryStore(): MemoryStore {
    return ensureBackend().memoryStore;
}

export function getDefaultSkillStore(): SkillStore {
    return ensureBackend().skillStore;
}

export function getDefaultContextStore(): ContextStore {
    return ensureBackend().contextStore;
}

export {
    StorageBackend,
    SessionStore,
    MemoryStore,
    SkillStore,
    ContextStore,
} from './protocols';
