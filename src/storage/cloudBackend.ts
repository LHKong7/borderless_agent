/**
 * storage/cloudBackend.ts - Cloud-backed storage (S3-compatible).
 *
 * Uses @aws-sdk/client-s3; set AGENT_STORAGE_BACKEND=cloud and configure bucket + credentials.
 * All methods are natively async — no sync stubs.
 *
 * The AWS SDK is loaded lazily via dynamic import so that consumers who never
 * use cloud storage are not required to install @aws-sdk/client-s3.
 */

import {
    SessionStore,
    MemoryStore,
    SkillStore,
    ContextStore,
    StorageBackend,
} from './protocols';

// Lazy-loaded SDK references
let _S3Client: any;
let _GetObjectCommand: any;
let _PutObjectCommand: any;
let _ListObjectsV2Command: any;

async function loadS3SDK() {
    if (_S3Client) return;
    try {
        const sdk = await import('@aws-sdk/client-s3');
        _S3Client = sdk.S3Client;
        _GetObjectCommand = sdk.GetObjectCommand;
        _PutObjectCommand = sdk.PutObjectCommand;
        _ListObjectsV2Command = sdk.ListObjectsV2Command;
    } catch {
        throw new Error(
            'Cloud storage requires @aws-sdk/client-s3. Install it with: npm install @aws-sdk/client-s3',
        );
    }
}

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

function getClient(): { client: any; bucket: string } {
    const bucket = configBucket();
    const endpoint = configEndpoint();
    const region = configRegion();
    const opts: Record<string, any> = {
        region,
        forcePathStyle: true,
    };
    if (endpoint) opts.endpoint = endpoint;
    return { client: new _S3Client(opts), bucket };
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
    private _client: any;
    private _bucket: string;

    constructor(client: any, bucket: string) {
        this._client = client;
        this._bucket = bucket;
    }

    private _key(sessionId: string): string {
        return `${SESSIONS_PREFIX}${sessionId}`;
    }

    async get(sessionId: string): Promise<Record<string, any> | null> {
        try {
            const resp = await this._client.send(
                new _GetObjectCommand({ Bucket: this._bucket, Key: this._key(sessionId) }),
            );
            const body = await streamToString(resp.Body);
            return JSON.parse(body);
        } catch {
            return null;
        }
    }

    async put(sessionId: string, data: Record<string, any>): Promise<void> {
        await this._client.send(
            new _PutObjectCommand({
                Bucket: this._bucket,
                Key: this._key(sessionId),
                Body: encode(data),
                ContentType: 'application/json; charset=utf-8',
            }),
        );
    }

    async listIds(): Promise<string[]> {
        const ids: string[] = [];
        let continuationToken: string | undefined;
        do {
            const resp = await this._client.send(
                new _ListObjectsV2Command({
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

    async listSummaries(limit: number = 20): Promise<Record<string, any>[]> {
        const ids = await this.listIds();
        const entries: Record<string, any>[] = [];
        for (const sid of ids) {
            const data = await this.get(sid);
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
    private _client: any;
    private _bucket: string;

    constructor(client: any, bucket: string) {
        this._client = client;
        this._bucket = bucket;
    }

    async load(): Promise<Record<string, any>[]> {
        try {
            const resp = await this._client.send(
                new _GetObjectCommand({ Bucket: this._bucket, Key: MEMORY_KEY }),
            );
            const body = await streamToString(resp.Body);
            const data = JSON.parse(body);
            return Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    }

    async save(items: Record<string, any>[]): Promise<void> {
        await this._client.send(
            new _PutObjectCommand({
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
    private _client: any;
    private _bucket: string;

    constructor(client: any, bucket: string) {
        this._client = client;
        this._bucket = bucket;
    }

    async listSkills(): Promise<string[]> {
        const names: string[] = [];
        let continuationToken: string | undefined;
        do {
            const resp = await this._client.send(
                new _ListObjectsV2Command({
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

    async getSkill(name: string): Promise<Record<string, any> | null> {
        const key = `${SKILLS_PREFIX}${name}`;
        try {
            const resp = await this._client.send(
                new _GetObjectCommand({ Bucket: this._bucket, Key: key }),
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
    private _client: any;
    private _bucket: string;

    constructor(client: any, bucket: string) {
        this._client = client;
        this._bucket = bucket;
    }

    private _key(sessionId: string): string {
        return `${CONTEXT_PREFIX}${sessionId}`;
    }

    async get(sessionId: string): Promise<Record<string, any> | null> {
        try {
            const resp = await this._client.send(
                new _GetObjectCommand({ Bucket: this._bucket, Key: this._key(sessionId) }),
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

    async set(sessionId: string, data: Record<string, any>): Promise<void> {
        await this._client.send(
            new _PutObjectCommand({
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

export async function createCloudBackend(
    client?: any,
    bucket?: string,
): Promise<StorageBackend> {
    await loadS3SDK();

    let c: any;
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
