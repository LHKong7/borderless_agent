/**
 * providers/google.ts — Google Gemini LLM provider (experimental).
 *
 * Uses @google/generative-ai (optional peer dependency).
 * Supports baseUrl for API-compatible endpoints.
 */

import type { LLMProvider, LLMResponse, ChatMessage, ToolCall } from '../llmProtocol';
import { getContextWindowForModel, withRetry } from './base';

// Lazy-load SDK to keep it optional
let GoogleSDK: any = null;

async function getGoogleSDK(): Promise<any> {
    if (GoogleSDK) return GoogleSDK;
    try {
        // @ts-ignore — optional peer dependency
        const mod = await import('@google/generative-ai');
        GoogleSDK = mod;
        return GoogleSDK;
    } catch {
        throw new Error(
            'GoogleProvider requires @google/generative-ai. Install it with: npm install @google/generative-ai',
        );
    }
}

// ---------------------------------------------------------------------------
// Message format translation
// ---------------------------------------------------------------------------

function toGeminiContents(messages: ChatMessage[]): {
    systemInstruction: string;
    contents: any[];
} {
    let systemInstruction = '';
    const contents: any[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemInstruction += (typeof msg.content === 'string' ? msg.content : '') + '\n';
            continue;
        }

        if (msg.role === 'tool') {
            contents.push({
                role: 'function',
                parts: [
                    {
                        functionResponse: {
                            name: msg.name ?? 'tool',
                            response: { result: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) },
                        },
                    },
                ],
            });
            continue;
        }

        if (msg.role === 'assistant') {
            const parts: any[] = [];
            if (typeof msg.content === 'string' && msg.content) {
                parts.push({ text: msg.content });
            }
            if (msg.tool_calls?.length) {
                for (const tc of msg.tool_calls) {
                    const fn = tc.function ?? tc;
                    let args: Record<string, any> = {};
                    if (typeof fn.arguments === 'string') {
                        try { args = JSON.parse(fn.arguments); } catch { args = {}; }
                    } else if (typeof fn.arguments === 'object') {
                        args = fn.arguments;
                    }
                    parts.push({
                        functionCall: { name: fn.name, args },
                    });
                }
            }
            if (parts.length) contents.push({ role: 'model', parts });
            continue;
        }

        // User
        contents.push({
            role: 'user',
            parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '') }],
        });
    }

    return { systemInstruction: systemInstruction.trim(), contents };
}

function toolsToGeminiFormat(tools: any[]): any[] {
    const declarations = tools.map((t) => {
        const fn = t.type === 'function' ? t.function : t;
        return {
            name: fn.name,
            description: fn.description ?? '',
            parameters: fn.parameters ?? fn.input_schema ?? { type: 'object', properties: {} },
        };
    });
    return [{ functionDeclarations: declarations }];
}

function shortHash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36).slice(0, 8);
}

function geminiToolCallId(name: string, index: number, args: any): string {
    let argStr = '';
    try { argStr = JSON.stringify(args ?? {}); } catch { argStr = String(args); }
    return `gemini_${name}_${index}_${shortHash(argStr)}`;
}

function parseGeminiResponse(response: any): {
    text: string;
    toolCalls: ToolCall[];
    usage: Record<string, number>;
} {
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    let tcIdx = 0;
    for (const part of parts) {
        if (part.text) textParts.push(part.text);
        if (part.functionCall) {
            const name = part.functionCall.name ?? '';
            const args = part.functionCall.args ?? {};
            toolCalls.push({
                id: geminiToolCallId(name, tcIdx++, args),
                name,
                arguments: args,
            });
        }
    }

    const meta = response.usageMetadata ?? {};
    const usage: Record<string, number> = {
        input_tokens: meta.promptTokenCount ?? 0,
        output_tokens: meta.candidatesTokenCount ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: meta.cachedContentTokenCount ?? 0,
    };

    return { text: textParts.join(''), toolCalls, usage };
}

// ---------------------------------------------------------------------------
// GoogleProvider
// ---------------------------------------------------------------------------

export class GoogleProvider implements LLMProvider {
    private _apiKey: string;
    private _model: string;
    private _baseUrl?: string;
    private _client: any = null;

    constructor(options: {
        apiKey: string;
        model?: string;
        /** Custom base URL for API-compatible endpoints. */
        baseUrl?: string;
    }) {
        this._apiKey = options.apiKey;
        this._model = options.model ?? 'gemini-2.0-flash';
        this._baseUrl = options.baseUrl;
    }

    private async getClient(): Promise<any> {
        if (this._client) return this._client;
        const sdk = await getGoogleSDK();
        const GoogleGenerativeAI = sdk.GoogleGenerativeAI;
        this._client = new GoogleGenerativeAI(this._apiKey);
        return this._client;
    }

    /** Apply baseUrl to per-call requestOptions when configured. */
    private _withBaseUrl<T extends Record<string, any>>(opts: T): T {
        if (!this._baseUrl) return opts;
        return { ...opts, requestOptions: { ...(opts.requestOptions ?? {}), baseUrl: this._baseUrl } };
    }

    get contextWindowSize(): number {
        return getContextWindowForModel(this._model, 1_000_000);
    }

    get supportsStreaming(): boolean {
        return true;
    }

    chat(
        messages: ChatMessage[] | Record<string, any>[],
        options?: {
            tools?: any[];
            temperature?: number;
            maxTokens?: number;
            stream?: boolean;
        },
    ): Promise<LLMResponse> | AsyncGenerator<LLMResponse> {
        const stream = options?.stream ?? false;
        if (stream) return this._chatStream(messages as ChatMessage[], options);
        return this._chatNonStream(messages as ChatMessage[], options);
    }

    private async _chatNonStream(
        messages: ChatMessage[],
        options?: { tools?: any[]; temperature?: number; maxTokens?: number },
    ): Promise<LLMResponse> {
        const client = await this.getClient();
        const { systemInstruction, contents } = toGeminiContents(messages);
        const tools = options?.tools?.length ? toolsToGeminiFormat(options.tools) : undefined;

        const generationConfig: any = {};
        if (options?.maxTokens) generationConfig.maxOutputTokens = options.maxTokens;
        if (options?.temperature != null) generationConfig.temperature = options.temperature;

        const modelOpts: any = { model: this._model };
        if (systemInstruction) modelOpts.systemInstruction = systemInstruction;
        if (tools) modelOpts.tools = tools;
        if (Object.keys(generationConfig).length) modelOpts.generationConfig = generationConfig;

        return withRetry(async () => {
            const model = client.getGenerativeModel(this._withBaseUrl(modelOpts));
            const result = await model.generateContent({ contents });
            const response = result.response;
            const parsed = parseGeminiResponse(response);
            return {
                content: parsed.text || null,
                toolCalls: parsed.toolCalls,
                usage: parsed.usage,
                model: this._model,
            };
        });
    }

    private async *_chatStream(
        messages: ChatMessage[],
        options?: { tools?: any[]; temperature?: number; maxTokens?: number },
    ): AsyncGenerator<LLMResponse> {
        const client = await this.getClient();
        const { systemInstruction, contents } = toGeminiContents(messages);
        const tools = options?.tools?.length ? toolsToGeminiFormat(options.tools) : undefined;

        const generationConfig: any = {};
        if (options?.maxTokens) generationConfig.maxOutputTokens = options.maxTokens;
        if (options?.temperature != null) generationConfig.temperature = options.temperature;

        const modelOpts: any = { model: this._model };
        if (systemInstruction) modelOpts.systemInstruction = systemInstruction;
        if (tools) modelOpts.tools = tools;
        if (Object.keys(generationConfig).length) modelOpts.generationConfig = generationConfig;

        const model = client.getGenerativeModel(this._withBaseUrl(modelOpts));
        const streamResult: any = await withRetry(() =>
            model.generateContentStream({ contents }),
        );

        const contentParts: string[] = [];
        const toolCalls: ToolCall[] = [];
        let usage: Record<string, number> = {};
        let tcIdx = 0;

        for await (const chunk of streamResult.stream) {
            const candidate = chunk.candidates?.[0];
            for (const part of candidate?.content?.parts ?? []) {
                if (part.text) {
                    contentParts.push(part.text);
                    yield { content: part.text, toolCalls: [], usage: {}, model: this._model };
                }
                if (part.functionCall) {
                    const name = part.functionCall.name ?? '';
                    const args = part.functionCall.args ?? {};
                    toolCalls.push({
                        id: geminiToolCallId(name, tcIdx++, args),
                        name,
                        arguments: args,
                    });
                }
            }
            if (chunk.usageMetadata) {
                usage = {
                    input_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
                    output_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: chunk.usageMetadata.cachedContentTokenCount ?? 0,
                };
            }
        }

        yield {
            content: contentParts.join('') || null,
            toolCalls,
            usage,
            model: this._model,
        };
    }
}
