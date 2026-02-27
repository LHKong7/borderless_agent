/**
 * llmProtocol.ts - LLM provider abstraction for library-style agent usage.
 *
 * Protocol and types allow swapping OpenAI, Anthropic, or local backends without
 * changing the agent loop. chat() accepts list-of-dicts messages and returns
 * normalized LLMResponse (or an async iterator when stream=true).
 */

import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
}

export interface LLMResponse {
    content: string | null;
    toolCalls: ToolCall[];
    usage: Record<string, number>;
    model: string;
}

export interface ChatMessage {
    role: string;
    content?: string | any[];
    tool_calls?: any[];
    tool_call_id?: string;
    [key: string]: any;
}

// ---------------------------------------------------------------------------
// LLMProvider interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
    readonly contextWindowSize: number;
    readonly supportsStreaming: boolean;

    chat(
        messages: ChatMessage[] | Record<string, any>[],
        options?: {
            tools?: any[];
            temperature?: number;
            maxTokens?: number;
            stream?: boolean;
        },
    ): Promise<LLMResponse> | AsyncGenerator<LLMResponse>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usageFromOpenAI(usage: any): Record<string, number> {
    if (!usage) return {};
    return {
        input_tokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
        cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    };
}

function toolCallsFromOpenAIMessage(msg: any): ToolCall[] {
    const result: ToolCall[] = [];
    const raw = msg?.tool_calls ?? [];
    for (const tc of raw) {
        const fn = tc?.function;
        const name: string = fn?.name ?? '';
        const argsStr: string = fn?.arguments ?? '{}';
        let args: Record<string, any> = {};
        try {
            args = JSON.parse(argsStr);
        } catch {
            args = {};
        }
        result.push({ id: tc?.id ?? '', name, arguments: args });
    }
    return result;
}

// ---------------------------------------------------------------------------
// OpenAI implementation
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
    private _apiKey: string;
    private _model: string;
    private _baseUrl?: string;
    private _timeout: number;
    private _client: OpenAI | null = null;

    constructor(options: {
        apiKey: string;
        model: string;
        baseUrl?: string;
        timeout?: number;
    }) {
        this._apiKey = options.apiKey;
        this._model = options.model;
        this._baseUrl = options.baseUrl;
        this._timeout = options.timeout ?? 120;
    }

    private get openaiClient(): OpenAI {
        if (!this._client) {
            const opts: ConstructorParameters<typeof OpenAI>[0] = {
                apiKey: this._apiKey,
                timeout: this._timeout * 1000,
            };
            if (this._baseUrl) {
                opts.baseURL = this._baseUrl;
            }
            this._client = new OpenAI(opts);
        }
        return this._client;
    }

    get contextWindowSize(): number {
        return 128_000;
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
        const tools = options?.tools ?? undefined;
        const temperature = options?.temperature ?? 0.7;
        const maxTokens = options?.maxTokens ?? 8000;
        const stream = options?.stream ?? false;

        let openaiTools: any[] | undefined;
        if (tools && tools.length > 0) {
            const first = tools[0];
            if (first.type === 'function') {
                openaiTools = tools;
            } else {
                openaiTools = tools.map((t) => ({
                    type: 'function' as const,
                    function: {
                        name: t.name,
                        description: t.description ?? '',
                        parameters:
                            t.input_schema ??
                            t.parameters ?? { type: 'object', properties: {} },
                    },
                }));
            }
        }

        const kwargs: any = {
            model: this._model,
            messages,
            max_tokens: maxTokens,
            temperature,
        };
        if (openaiTools) {
            kwargs.tools = openaiTools;
            kwargs.tool_choice = 'auto';
        }

        if (stream) {
            return this._chatStream(kwargs);
        }
        return this._chatNonStream(kwargs);
    }

    private async _chatNonStream(kwargs: any): Promise<LLMResponse> {
        const resp = await this.openaiClient.chat.completions.create(kwargs);
        const msg = (resp as any).choices[0].message;
        const usage = usageFromOpenAI((resp as any).usage);
        const toolCalls = toolCallsFromOpenAIMessage(msg);
        return {
            content: (msg.content ?? '').trim() || null,
            toolCalls,
            usage,
            model: this._model,
        };
    }

    private async *_chatStream(kwargs: any): AsyncGenerator<LLMResponse> {
        kwargs.stream = true;
        const stream = await this.openaiClient.chat.completions.create(kwargs);

        const contentParts: string[] = [];
        const toolCallsAccum: { id: string; name: string; arguments: string }[] = [];
        let usage: Record<string, number> = {};

        for await (const chunk of stream as any) {
            if (!chunk.choices || chunk.choices.length === 0) {
                if (chunk.usage) {
                    usage = usageFromOpenAI(chunk.usage);
                }
                continue;
            }
            const choice = chunk.choices[0];
            const delta = choice?.delta;
            if (!delta) continue;

            const part: string | undefined = delta?.content;
            if (part) {
                contentParts.push(part);
                yield {
                    content: part,
                    toolCalls: [],
                    usage: {},
                    model: this._model,
                };
            }

            for (const tc of delta?.tool_calls ?? []) {
                const idx = tc?.index;
                if (idx == null) continue;
                while (toolCallsAccum.length <= idx) {
                    toolCallsAccum.push({ id: '', name: '', arguments: '' });
                }
                const acc = toolCallsAccum[idx];
                if (tc.id) acc.id = tc.id;
                const fn = tc.function;
                if (fn) {
                    if (fn.name) acc.name = fn.name;
                    if (fn.arguments) acc.arguments += fn.arguments;
                }
            }

            if (chunk.usage) {
                usage = usageFromOpenAI(chunk.usage);
            }
        }

        const fullContent = contentParts.join('');
        const toolCallsOut: ToolCall[] = [];
        for (const acc of toolCallsAccum) {
            if (acc.id || acc.name || acc.arguments) {
                let args: Record<string, any> = {};
                try {
                    args = JSON.parse(acc.arguments || '{}');
                } catch {
                    args = {};
                }
                toolCallsOut.push({ id: acc.id, name: acc.name, arguments: args });
            }
        }

        yield {
            content: fullContent || null,
            toolCalls: toolCallsOut,
            usage,
            model: this._model,
        };
    }
}
