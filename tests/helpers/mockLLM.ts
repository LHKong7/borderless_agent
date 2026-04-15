/**
 * MockLLMProvider — A test double implementing LLMProvider.
 *
 * Supports canned responses, tool call simulation, and token usage reporting.
 */

import type { LLMProvider, LLMResponse, ChatMessage } from '../../src/llmProtocol';

export interface MockResponse {
    content?: string | null;
    toolCalls?: { id: string; name: string; arguments: Record<string, any> }[];
    usage?: Record<string, number>;
    thinking?: string | null;
}

export class MockLLMProvider implements LLMProvider {
    readonly contextWindowSize: number;
    readonly supportsStreaming: boolean;

    /** Queue of responses to return, in order. */
    private _responses: MockResponse[];
    /** All messages received across all calls, for assertion. */
    readonly receivedCalls: { messages: ChatMessage[]; options?: Record<string, any> }[] = [];
    private _callIndex = 0;

    constructor(
        responses: MockResponse[] = [],
        opts?: { contextWindowSize?: number; supportsStreaming?: boolean },
    ) {
        this._responses = responses;
        this.contextWindowSize = opts?.contextWindowSize ?? 128_000;
        this.supportsStreaming = opts?.supportsStreaming ?? false;
    }

    /** Add more responses to the queue. */
    enqueue(...responses: MockResponse[]): void {
        this._responses.push(...responses);
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
        this.receivedCalls.push({ messages: messages as ChatMessage[], options });

        if (options?.stream) {
            return this._chatStream();
        }
        return this._chatNonStream();
    }

    private async _chatNonStream(): Promise<LLMResponse> {
        const mock = this._responses[this._callIndex] ?? { content: 'Mock response' };
        this._callIndex = Math.min(this._callIndex + 1, this._responses.length - 1);

        return {
            content: mock.content ?? null,
            toolCalls: (mock.toolCalls ?? []).map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
            })),
            usage: mock.usage ?? { input_tokens: 100, output_tokens: 50 },
            model: 'mock-model',
            thinking: mock.thinking ?? null,
        };
    }

    private async *_chatStream(): AsyncGenerator<LLMResponse> {
        const mock = this._responses[this._callIndex] ?? { content: 'Mock response' };
        this._callIndex = Math.min(this._callIndex + 1, this._responses.length - 1);

        const content = mock.content ?? '';
        // Yield content in chunks
        for (let i = 0; i < content.length; i += 10) {
            yield {
                content: content.slice(i, i + 10),
                toolCalls: [],
                usage: {},
                model: 'mock-model',
            };
        }
        // Final chunk with tool calls and usage
        yield {
            content: content,
            toolCalls: (mock.toolCalls ?? []).map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
            })),
            usage: mock.usage ?? { input_tokens: 100, output_tokens: 50 },
            model: 'mock-model',
            thinking: mock.thinking ?? null,
        };
    }
}
