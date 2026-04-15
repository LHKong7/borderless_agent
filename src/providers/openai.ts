/**
 * providers/openai.ts — OpenAI-compatible LLM provider.
 *
 * Extracted from llmProtocol.ts. Supports any OpenAI-compatible endpoint
 * via baseUrl (e.g. Azure, Together, Ollama, vLLM, LiteLLM).
 */

import OpenAI from 'openai';
import type { LLMProvider, LLMResponse, ChatMessage, ToolCall } from '../llmProtocol';
import { getContextWindowForModel, withRetry, normalizeUsage } from './base';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function thinkingFromMessage(msg: any): string | null {
    if (!msg) return null;
    if (typeof msg.thinking === 'string' && msg.thinking) return msg.thinking;
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) return msg.reasoning_content;
    if (typeof msg.reasoning === 'string' && msg.reasoning) return msg.reasoning;
    if (Array.isArray(msg.content)) {
        const parts: string[] = [];
        for (const block of msg.content) {
            if (block?.type === 'thinking' && typeof block.thinking === 'string') {
                parts.push(block.thinking);
            }
        }
        if (parts.length) return parts.join('\n');
    }
    return null;
}

function toolCallsFromMessage(msg: any): ToolCall[] {
    const result: ToolCall[] = [];
    for (const tc of msg?.tool_calls ?? []) {
        const fn = tc?.function;
        let args: Record<string, any> = {};
        try {
            args = JSON.parse(fn?.arguments ?? '{}');
        } catch {
            args = {};
        }
        result.push({ id: tc?.id ?? '', name: fn?.name ?? '', arguments: args });
    }
    return result;
}

// ---------------------------------------------------------------------------
// OpenAIProvider
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
        /** Custom base URL for OpenAI-compatible endpoints (Azure, Together, Ollama, etc.) */
        baseUrl?: string;
        timeout?: number;
    }) {
        this._apiKey = options.apiKey;
        this._model = options.model;
        this._baseUrl = options.baseUrl;
        this._timeout = options.timeout ?? 120;
    }

    private get client(): OpenAI {
        if (!this._client) {
            const opts: ConstructorParameters<typeof OpenAI>[0] = {
                apiKey: this._apiKey,
                timeout: this._timeout * 1000,
            };
            if (this._baseUrl) opts.baseURL = this._baseUrl;
            this._client = new OpenAI(opts);
        }
        return this._client;
    }

    get contextWindowSize(): number {
        return getContextWindowForModel(this._model);
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
        const tools = options?.tools;
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
                            t.input_schema ?? t.parameters ?? { type: 'object', properties: {} },
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

        if (stream) return this._chatStream(kwargs);
        return this._chatNonStream(kwargs);
    }

    private async _chatNonStream(kwargs: any): Promise<LLMResponse> {
        return withRetry(async () => {
            const resp = await this.client.chat.completions.create(kwargs);
            const msg = (resp as any).choices[0].message;
            return {
                content: (msg.content ?? '').trim() || null,
                toolCalls: toolCallsFromMessage(msg),
                usage: normalizeUsage((resp as any).usage),
                model: this._model,
                thinking: thinkingFromMessage(msg),
            };
        });
    }

    private async *_chatStream(kwargs: any): AsyncGenerator<LLMResponse> {
        kwargs.stream = true;
        const stream = await withRetry(() =>
            this.client.chat.completions.create(kwargs),
        );

        const contentParts: string[] = [];
        const thinkingParts: string[] = [];
        const toolCallsAccum: { id: string; name: string; arguments: string }[] = [];
        let usage: Record<string, number> = {};

        for await (const chunk of stream as any) {
            if (!chunk.choices || chunk.choices.length === 0) {
                if (chunk.usage) usage = normalizeUsage(chunk.usage);
                continue;
            }
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            const thinkingDelta = delta?.thinking ?? delta?.reasoning_content ?? delta?.reasoning;
            if (thinkingDelta) thinkingParts.push(thinkingDelta);

            const part: string | undefined = delta?.content;
            if (part) {
                contentParts.push(part);
                yield { content: part, toolCalls: [], usage: {}, model: this._model };
            }

            for (const tc of delta?.tool_calls ?? []) {
                const idx = tc?.index;
                if (idx == null || idx > 100) continue;
                while (toolCallsAccum.length <= idx) {
                    toolCallsAccum.push({ id: '', name: '', arguments: '' });
                }
                const acc = toolCallsAccum[idx];
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }

            if (chunk.usage) usage = normalizeUsage(chunk.usage);
        }

        const toolCallsOut: ToolCall[] = [];
        for (const acc of toolCallsAccum) {
            if (acc.id || acc.name || acc.arguments) {
                let args: Record<string, any> = {};
                try { args = JSON.parse(acc.arguments || '{}'); } catch { args = {}; }
                toolCallsOut.push({ id: acc.id, name: acc.name, arguments: args });
            }
        }

        yield {
            content: contentParts.join('') || null,
            toolCalls: toolCallsOut,
            usage,
            model: this._model,
            thinking: thinkingParts.join('') || null,
        };
    }
}
