/**
 * storage/cloudBackend.ts - Cloud-backed storage (S3-compatible).
 *
 * Uses @aws-sdk/client-s3; set AGENT_STORAGE_BACKEND=cloud and configure bucket + credentials.
 */

import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
    SessionStore,
    MemoryStore,
    SkillStore,
    ContextStore,
    StorageBackend,
} from './protocols';

// Key prefixes
const KEY_PREFIX = 'agent';
const SESSIONS_PREFIX = `${KEY_PREFIX}/sessions/`;
const MEMORY_KEY = `${KEY_PREFIX}/memory/data`;
const SKILLS_PREFIX = `${KEY_PREFIX}/skills/`;
const CONTEXT_PREFIX = `${KEY_PREFIX}/context/`;

function configBucket(): string {
    const v = (process.env.AGENT_STORAGE_BUCKET ?? '').trim();
    if (!v) throw new Error('Cloud storage requires AGENT_STORAGE_BUCKET');
    return v;
}

function configEndpoint(): string | undefined {
    return (process.env.AGENT_S3_ENDPOINT ?? '').trim() || undefined;
}

function configRegion(): string {
    return (
        (process.env.AGENT_STORAGE_REGION ?? process.env.AWS_REGION ?? 'us-east-1').trim()
    );
}

function getClient(): { client: S3Client; bucket: string } {
    const bucket = configBucket();
    const endpoint = configEndpoint();
    const region = configRegion();
    const opts: ConstructorParameters<typeof S3Client>[0] = {
        region,
        forcePathStyle: true,
    };
    if (endpoint) opts.endpoint = endpoint;
    return { client: new S3Client(opts), bucket };
}

function encode(data: any): Buffer {
    return Buffer.from(JSON.stringify(data), 'utf-8');
}

async function streamToString(stream: any): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

// ---------------------------------------------------------------------------
// CloudSessionStore
// ---------------------------------------------------------------------------

export class CloudSessionStore implements SessionStore {
    private _client: S3Client;
    private _bucket: string;

    constructor(client?: S3Client, bucket?: string) {
        if (client && bucket) {
            this._client = client;
            this._bucket = bucket;
        } else {
            const c = getClient();
            this._client = c.client;
            this._bucket = c.bucket;
        }
    }

    private _key(sessionId: string): string {
        return `${SESSIONS_PREFIX}${sessionId}`;
    }

    get(sessionId: string): Record<string, any> | null {
        // Sync wrapper — callers should await if needed
        return null; // Placeholder: S3 ops are async
    }

    async getAsync(sessionId: string): Promise<Record<string, any> | null> {
        try {
            const resp = await this._client.send(
                new GetObjectCommand({ Bucket: this._bucket, Key: this._key(sessionId) }),
            );
            const body = await streamToString(resp.Body);
            return JSON.parse(body);
        } catch {
            return null;
        }
    }

    put(sessionId: string, data: Record<string, any>): void {
        this._client.send(
            new PutObjectCommand({
                Bucket: this._bucket,
                Key: this._key(sessionId),
                Body: encode(data),
                ContentType: 'application/json; charset=utf-8',
            }),
        );
    }

    listIds(): string[] {
        return []; // Async — use listIdsAsync
    }

    async listIdsAsync(): Promise<string[]> {
        const ids: string[] = [];
        let continuationToken: string | undefined;
        do {
            const resp = await this._client.send(
                new ListObjectsV2Command({
                    Bucket: this._bucket,
                    Prefix: SESSIONS_PREFIX,
                    ContinuationToken: continuationToken,
                }),
            );
            for (const obj of resp.Contents ?? []) {
                const k = obj.Key ?? '';
                if (k.endsWith('/')) continue;
                const sid = k.slice(SESSIONS_PREFIX.length);
                if (sid) ids.push(sid);
            }
            continuationToken = resp.NextContinuationToken;
        } while (continuationToken);
        return ids.sort();
    }

    listSummaries(limit: number = 20): Record<string, any>[] {
        return []; // Async — use listSummariesAsync
    }

    async listSummariesAsync(limit: number = 20): Promise<Record<string, any>[]> {
        const ids = await this.listIdsAsync();
        const entries: Record<string, any>[] = [];
        for (const sid of ids) {
            const data = await this.getAsync(sid);
            if (!data) continue;
            entries.push({
                id: sid,
                updated_at: data.updated_at ?? 0,
                turns: (data.history ?? []).filter((m: any) => m.role === 'user').length,
                state: data.state ?? 'active',
            });
        }
        entries.sort((a, b) => b.updated_at - a.updated_at);
        return entries.slice(0, limit);
    }
}

// ---------------------------------------------------------------------------
// CloudMemoryStore
// ---------------------------------------------------------------------------

export class CloudMemoryStore implements MemoryStore {
    private _client: S3Client;
    private _bucket: string;

    constructor(client?: S3Client, bucket?: string) {
        if (client && bucket) {
            this._client = client;
            this._bucket = bucket;
        } else {
            const c = getClient();
            this._client = c.client;
            this._bucket = c.bucket;
        }
    }

    load(): Record<string, any>[] {
        return []; // Async — use loadAsync
    }

    async loadAsync(): Promise<Record<string, any>[]> {
        try {
            const resp = await this._client.send(
                new GetObjectCommand({ Bucket: this._bucket, Key: MEMORY_KEY }),
            );
            const body = await streamToString(resp.Body);
            const data = JSON.parse(body);
            return Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    }

    save(items: Record<string, any>[]): void {
        this._client.send(
            new PutObjectCommand({
                Bucket: this._bucket,
                Key: MEMORY_KEY,
                Body: encode(items),
                ContentType: 'application/json; charset=utf-8',
            }),
        );
    }
}

// ---------------------------------------------------------------------------
// CloudSkillStore
// ---------------------------------------------------------------------------

export class CloudSkillStore implements SkillStore {
    private _client: S3Client;
    private _bucket: string;

    constructor(client?: S3Client, bucket?: string) {
        if (client && bucket) {
            this._client = client;
            this._bucket = bucket;
        } else {
            const c = getClient();
            this._client = c.client;
            this._bucket = c.bucket;
        }
    }

    listSkills(): string[] {
        return []; // Async — use listSkillsAsync
    }

    async listSkillsAsync(): Promise<string[]> {
        const names: string[] = [];
        let continuationToken: string | undefined;
        do {
            const resp = await this._client.send(
                new ListObjectsV2Command({
                    Bucket: this._bucket,
                    Prefix: SKILLS_PREFIX,
                    ContinuationToken: continuationToken,
                }),
            );
            for (const obj of resp.Contents ?? []) {
                const k = obj.Key ?? '';
                if (k.endsWith('/')) continue;
                const name = k.slice(SKILLS_PREFIX.length);
                if (name) names.push(name);
            }
            continuationToken = resp.NextContinuationToken;
        } while (continuationToken);
        return names.sort();
    }

    getSkill(name: string): Record<string, any> | null {
        return null; // Async — use getSkillAsync
    }

    async getSkillAsync(name: string): Promise<Record<string, any> | null> {
        const key = `${SKILLS_PREFIX}${name}`;
        try {
            const resp = await this._client.send(
                new GetObjectCommand({ Bucket: this._bucket, Key: key }),
            );
            const body = await streamToString(resp.Body);
            return JSON.parse(body);
        } catch {
            return null;
        }
    }
}

// ---------------------------------------------------------------------------
// CloudContextStore
// ---------------------------------------------------------------------------

export class CloudContextStore implements ContextStore {
    private _client: S3Client;
    private _bucket: string;

    constructor(client?: S3Client, bucket?: string) {
        if (client && bucket) {
            this._client = client;
            this._bucket = bucket;
        } else {
            const c = getClient();
            this._client = c.client;
            this._bucket = c.bucket;
        }
    }

    private _key(sessionId: string): string {
        return `${CONTEXT_PREFIX}${sessionId}`;
    }

    get(sessionId: string): Record<string, any> | null {
        return null; // Async — use getAsync
    }

    async getAsync(sessionId: string): Promise<Record<string, any> | null> {
        try {
            const resp = await this._client.send(
                new GetObjectCommand({ Bucket: this._bucket, Key: this._key(sessionId) }),
            );
            const body = await streamToString(resp.Body);
            const data = JSON.parse(body);
            return data && typeof data === 'object' && !Array.isArray(data)
                ? data
                : null;
        } catch {
            return null;
        }
    }

    set(sessionId: string, data: Record<string, any>): void {
        this._client.send(
            new PutObjectCommand({
                Bucket: this._bucket,
                Key: this._key(sessionId),
                Body: encode(data),
                ContentType: 'application/json; charset=utf-8',
            }),
        );
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCloudBackend(
    client?: S3Client,
    bucket?: string,
): StorageBackend {
    let c: S3Client;
    let b: string;
    if (client && bucket) {
        c = client;
        b = bucket;
    } else {
        const result = getClient();
        c = result.client;
        b = result.bucket;
    }
    return new StorageBackend(
        new CloudSessionStore(c, b),
        new CloudMemoryStore(c, b),
        new CloudSkillStore(c, b),
        new CloudContextStore(c, b),
    );
}
