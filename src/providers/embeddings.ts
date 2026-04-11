/**
 * providers/embeddings.ts — Optional embedding provider interface.
 *
 * Embedding-based memory retrieval is entirely opt-in. If no EmbeddingProvider
 * is configured, the memory system falls back to keyword-based scoring.
 *
 * Users enable it via:
 *   builder.setEmbeddingProvider(new OpenAIEmbeddingProvider({ apiKey }))
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
    /** Model identifier for logging/tracking. */
    readonly model: string;
    /** Embedding vector dimensions. */
    readonly dimensions: number;
    /** Embed one or more texts into vectors. */
    embed(texts: string[]): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Cosine similarity (used by memory retrieval when embeddings are available)
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// OpenAI embedding implementation
// ---------------------------------------------------------------------------

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
    readonly model: string;
    readonly dimensions: number;
    private _apiKey: string;
    private _baseUrl?: string;
    private _client: any = null;

    constructor(options: {
        apiKey: string;
        /** Embedding model. Default: text-embedding-3-small */
        model?: string;
        /** Output dimensions (text-embedding-3-small supports 256–1536). Default: 1536 */
        dimensions?: number;
        /** Custom base URL for OpenAI-compatible endpoints. */
        baseUrl?: string;
    }) {
        this._apiKey = options.apiKey;
        this.model = options.model ?? 'text-embedding-3-small';
        this.dimensions = options.dimensions ?? 1536;
        this._baseUrl = options.baseUrl;
    }

    private async getClient(): Promise<any> {
        if (this._client) return this._client;
        const OpenAI = (await import('openai')).default;
        const opts: any = { apiKey: this._apiKey };
        if (this._baseUrl) opts.baseURL = this._baseUrl;
        this._client = new OpenAI(opts);
        return this._client;
    }

    async embed(texts: string[]): Promise<number[][]> {
        if (!texts.length) return [];
        const client = await this.getClient();
        const response = await client.embeddings.create({
            model: this.model,
            input: texts,
            dimensions: this.dimensions,
        });
        return response.data
            .sort((a: any, b: any) => a.index - b.index)
            .map((d: any) => d.embedding);
    }
}
