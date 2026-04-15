/**
 * providers/anthropic.ts — Anthropic Claude LLM provider.
 *
 * Uses @anthropic-ai/sdk (optional peer dependency) with native tool_use blocks.
 * Supports baseUrl for API-compatible proxies and prompt caching.
 */

import type { LLMProvider, LLMResponse, ChatMessage, ToolCall } from '../llmProtocol';
import { getContextWindowForModel, withRetry, normalizeUsage } from './base';

// Lazy-load SDK to keep it optional
let AnthropicSDK: any = null;

async function getAnthropicSDK(): Promise<any> {
    if (AnthropicSDK) return AnthropicSDK;
    try {
        // @ts-ignore — optional peer dependency
        const mod = await import('@anthropic-ai/sdk');
        AnthropicSDK = mod.default ?? mod.Anthropic ?? mod;
        return AnthropicSDK;
    } catch {
        throw new Error(
            'AnthropicProvider requires @anthropic-ai/sdk. Install it with: npm install @anthropic-ai/sdk',
        );
    }
}

// ---------------------------------------------------------------------------
// Message format translation (OpenAI ↔ Anthropic)
// ---------------------------------------------------------------------------

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | any[];
}

function toAnthropicMessages(messages: ChatMessage[]): {
    system: string;
    messages: AnthropicMessage[];
} {
    let system = '';
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            system += (typeof msg.content === 'string' ? msg.content : '') + '\n';
            continue;
        }

        if (msg.role === 'tool') {
            // Convert OpenAI tool result → Anthropic tool_result content block
            result.push({
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: msg.tool_call_id ?? '',
                        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                    },
                ],
            });
            continue;
        }

        if (msg.role === 'assistant') {
            const blocks: any[] = [];

            // Text content
            if (typeof msg.content === 'string' && msg.content) {
                blocks.push({ type: 'text', text: msg.content });
            }

            // Tool calls → tool_use blocks
            if (msg.tool_calls?.length) {
                for (const tc of msg.tool_calls) {
                    const fn = tc.function ?? tc;
                    let input: Record<string, any> = {};
                    if (typeof fn.arguments === 'string') {
                        try { input = JSON.parse(fn.arguments); } catch { input = {}; }
                    } else if (typeof fn.arguments === 'object') {
                        input = fn.arguments;
                    }
                    blocks.push({
                        type: 'tool_use',
                        id: tc.id ?? '',
                        name: fn.name ?? '',
                        input,
                    });
                }
            }

            if (blocks.length) {
                result.push({ role: 'assistant', content: blocks });
            } else if (typeof msg.content === 'string') {
                result.push({ role: 'assistant', content: msg.content });
            }
            continue;
        }

        // User messages
        result.push({
            role: 'user',
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
        });
    }

    // Anthropic requires alternating user/assistant. Merge consecutive same-role messages.
    const merged: AnthropicMessage[] = [];
    for (const m of result) {
        if (merged.length > 0 && merged[merged.length - 1].role === m.role) {
            const prev = merged[merged.length - 1];
            const prevContent = Array.isArray(prev.content)
                ? prev.content
                : [{ type: 'text', text: prev.content }];
            const curContent = Array.isArray(m.content)
                ? m.content
                : [{ type: 'text', text: m.content }];
            prev.content = [...prevContent, ...curContent];
        } else {
            merged.push({ ...m });
        }
    }

    return { system: system.trim(), messages: merged };
}

function toolsToAnthropicFormat(tools: any[]): any[] {
    return tools.map((t) => {
        const fn = t.type === 'function' ? t.function : t;
        return {
            name: fn.name,
            description: fn.description ?? '',
            input_schema: fn.parameters ?? fn.input_schema ?? { type: 'object', properties: {} },
        };
    });
}

function toolCallsFromAnthropicResponse(content: any[]): ToolCall[] {
    const result: ToolCall[] = [];
    for (const block of content ?? []) {
        if (block.type === 'tool_use') {
            result.push({
                id: block.id ?? '',
                name: block.name ?? '',
                arguments: block.input ?? {},
            });
        }
    }
    return result;
}

function textFromAnthropicResponse(content: any[]): string {
    const parts: string[] = [];
    for (const block of content ?? []) {
        if (block.type === 'text' && block.text) {
            parts.push(block.text);
        }
    }
    return parts.join('');
}

function thinkingFromAnthropicResponse(content: any[]): string | null {
    const parts: string[] = [];
    for (const block of content ?? []) {
        if (block.type === 'thinking' && block.thinking) {
            parts.push(block.thinking);
        }
    }
    return parts.length ? parts.join('\n') : null;
}

function normalizeAnthropicUsage(usage: any): Record<string, number> {
    if (!usage) return {};
    return {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    };
}

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
    private _apiKey: string;
    private _model: string;
    private _baseUrl?: string;
    private _timeout: number;
    private _client: any = null;

    constructor(options: {
        apiKey: string;
        model?: string;
        /** Custom base URL for API-compatible proxies. */
        baseUrl?: string;
        timeout?: number;
    }) {
        this._apiKey = options.apiKey;
        this._model = options.model ?? 'claude-sonnet-4-20250514';
        this._baseUrl = options.baseUrl;
        this._timeout = options.timeout ?? 120;
    }

    private async getClient(): Promise<any> {
        if (this._client) return this._client;
        const Anthropic = await getAnthropicSDK();
        const opts: any = {
            apiKey: this._apiKey,
            timeout: this._timeout * 1000,
        };
        if (this._baseUrl) opts.baseURL = this._baseUrl;
        this._client = new Anthropic(opts);
        return this._client;
    }

    get contextWindowSize(): number {
        return getContextWindowForModel(this._model, 200_000);
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
        const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
        const tools = options?.tools?.length ? toolsToAnthropicFormat(options.tools) : undefined;

        const kwargs: any = {
            model: this._model,
            max_tokens: options?.maxTokens ?? 8000,
            messages: anthropicMessages,
        };
        if (system) kwargs.system = system;
        if (tools) kwargs.tools = tools;
        if (options?.temperature != null) kwargs.temperature = options.temperature;

        return withRetry(async () => {
            const resp = await client.messages.create(kwargs);
            const content = resp.content ?? [];
            return {
                content: textFromAnthropicResponse(content) || null,
                toolCalls: toolCallsFromAnthropicResponse(content),
                usage: normalizeAnthropicUsage(resp.usage),
                model: this._model,
                thinking: thinkingFromAnthropicResponse(content),
            };
        });
    }

    private async *_chatStream(
        messages: ChatMessage[],
        options?: { tools?: any[]; temperature?: number; maxTokens?: number },
    ): AsyncGenerator<LLMResponse> {
        const client = await this.getClient();
        const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
        const tools = options?.tools?.length ? toolsToAnthropicFormat(options.tools) : undefined;

        const kwargs: any = {
            model: this._model,
            max_tokens: options?.maxTokens ?? 8000,
            messages: anthropicMessages,
            stream: true,
        };
        if (system) kwargs.system = system;
        if (tools) kwargs.tools = tools;
        if (options?.temperature != null) kwargs.temperature = options.temperature;

        const stream = await withRetry(() => client.messages.create(kwargs));

        const contentParts: string[] = [];
        const thinkingParts: string[] = [];
        const toolCalls: ToolCall[] = [];
        let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
        let usage: Record<string, number> = {};

        for await (const event of stream as any) {
            if (event.type === 'message_start' && event.message?.usage) {
                usage = normalizeAnthropicUsage(event.message.usage);
            }

            if (event.type === 'content_block_start') {
                const block = event.content_block;
                if (block?.type === 'tool_use') {
                    currentToolUse = { id: block.id, name: block.name, inputJson: '' };
                }
            }

            if (event.type === 'content_block_delta') {
                const delta = event.delta;
                if (delta?.type === 'text_delta' && delta.text) {
                    contentParts.push(delta.text);
                    yield { content: delta.text, toolCalls: [], usage: {}, model: this._model };
                }
                if (delta?.type === 'thinking_delta' && delta.thinking) {
                    thinkingParts.push(delta.thinking);
                }
                if (delta?.type === 'input_json_delta' && currentToolUse) {
                    currentToolUse.inputJson += delta.partial_json ?? '';
                }
            }

            if (event.type === 'content_block_stop' && currentToolUse) {
                let input: Record<string, any> = {};
                try { input = JSON.parse(currentToolUse.inputJson || '{}'); } catch { input = {}; }
                toolCalls.push({
                    id: currentToolUse.id,
                    name: currentToolUse.name,
                    arguments: input,
                });
                currentToolUse = null;
            }

            if (event.type === 'message_delta' && event.usage) {
                usage = {
                    ...usage,
                    output_tokens: event.usage.output_tokens ?? usage.output_tokens ?? 0,
                };
            }
        }

        yield {
            content: contentParts.join('') || null,
            toolCalls,
            usage,
            model: this._model,
            thinking: thinkingParts.join('') || null,
        };
    }
}
