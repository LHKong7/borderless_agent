import { describe, it, expect } from 'vitest';
import { AgentBuilder } from '../../src/agentBuilder';
import { MockLLMProvider } from '../helpers/mockLLM';

describe('Agent loop integration', () => {
    it('returns a simple text reply', async () => {
        const mock = new MockLLMProvider([{ content: 'Hello there!' }]);
        const agent = new AgentBuilder()
            .setLLMProvider(mock)
            .setSystemPrompt('You are helpful.')
            .setIncludeBuiltinTools(false)
            .enableMemory(false)
            .enableContext(false)
            .build();

        const result = await agent.chat('Hi');
        expect(result.reply).toBe('Hello there!');
        expect(result.hadToolCalls).toBe(false);
    });

    it('executes a tool call and returns final reply', async () => {
        const mock = new MockLLMProvider([
            // First response: LLM requests a tool call
            {
                content: null,
                toolCalls: [
                    {
                        id: 'tc_1',
                        name: 'echo_tool',
                        arguments: { text: 'hello' },
                    },
                ],
            },
            // Second response: LLM returns final text after seeing tool result
            {
                content: 'The tool said: hello',
            },
        ]);

        const toolExecuted: string[] = [];
        const agent = new AgentBuilder()
            .setLLMProvider(mock)
            .setSystemPrompt('You are helpful.')
            .setIncludeBuiltinTools(false)
            .enableMemory(false)
            .enableContext(false)
            .addTool({
                name: 'echo_tool',
                description: 'Echoes text back',
                parameters: {
                    text: { type: 'string', description: 'Text to echo' },
                },
                required: ['text'],
                execute: (args) => {
                    toolExecuted.push(args.text);
                    return `Echo: ${args.text}`;
                },
            })
            .build();

        const result = await agent.chat('Please echo hello');
        expect(result.hadToolCalls).toBe(true);
        expect(toolExecuted).toContain('hello');
        expect(result.reply).toBe('The tool said: hello');
    });

    it('handles tool execution errors gracefully', async () => {
        const mock = new MockLLMProvider([
            {
                content: null,
                toolCalls: [
                    {
                        id: 'tc_err',
                        name: 'failing_tool',
                        arguments: {},
                    },
                ],
            },
            {
                content: 'The tool failed, sorry.',
            },
        ]);

        const agent = new AgentBuilder()
            .setLLMProvider(mock)
            .setSystemPrompt('test')
            .setIncludeBuiltinTools(false)
            .enableMemory(false)
            .enableContext(false)
            .addTool({
                name: 'failing_tool',
                description: 'Always fails',
                execute: () => {
                    throw new Error('Intentional failure');
                },
            })
            .build();

        const result = await agent.chat('Run the failing tool');
        expect(result.reply).toBe('The tool failed, sorry.');
        // LLM received at least 2 calls (first with tool call, second after tool error)
        expect(mock.receivedCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('respects max tool rounds limit', async () => {
        // LLM always returns a tool call - should stop at maxToolRounds
        const responses = Array.from({ length: 25 }, () => ({
            content: null,
            toolCalls: [
                { id: 'tc_loop', name: 'loop_tool', arguments: {} },
            ],
        }));

        const mock = new MockLLMProvider(responses);
        let callCount = 0;
        const agent = new AgentBuilder()
            .setLLMProvider(mock)
            .setSystemPrompt('test')
            .setIncludeBuiltinTools(false)
            .enableMemory(false)
            .enableContext(false)
            .setMaxToolRounds(3)
            .addTool({
                name: 'loop_tool',
                description: 'Loops',
                execute: () => {
                    callCount++;
                    return 'ok';
                },
            })
            .build();

        const result = await agent.chat('Loop forever');
        expect(callCount).toBeLessThanOrEqual(3);
        expect(result.reply).toContain('safety limit');
    });

    it('handles multiple tool calls in a single response', async () => {
        const mock = new MockLLMProvider([
            {
                content: null,
                toolCalls: [
                    { id: 'tc_a', name: 'tool_a', arguments: {} },
                    { id: 'tc_b', name: 'tool_b', arguments: {} },
                ],
            },
            {
                content: 'Both tools ran.',
            },
        ]);

        const executed: string[] = [];
        const agent = new AgentBuilder()
            .setLLMProvider(mock)
            .setSystemPrompt('test')
            .setIncludeBuiltinTools(false)
            .enableMemory(false)
            .enableContext(false)
            .addTools([
                {
                    name: 'tool_a',
                    description: 'Tool A',
                    execute: () => {
                        executed.push('a');
                        return 'A done';
                    },
                },
                {
                    name: 'tool_b',
                    description: 'Tool B',
                    execute: () => {
                        executed.push('b');
                        return 'B done';
                    },
                },
            ])
            .build();

        const result = await agent.chat('Run both');
        expect(executed).toContain('a');
        expect(executed).toContain('b');
        expect(result.hadToolCalls).toBe(true);
    });
});
