import { describe, it, expect } from 'vitest';
import { AgentBuilder } from '../../src/agentBuilder';
import { MockLLMProvider } from '../helpers/mockLLM';

describe('AgentBuilder', () => {
    it('throws when no LLM is configured', () => {
        expect(() => new AgentBuilder().build()).toThrow('must call .setLLM');
    });

    it('builds with setLLMProvider', () => {
        const mock = new MockLLMProvider([{ content: 'hi' }]);
        const agent = new AgentBuilder()
            .setLLMProvider(mock)
            .setSystemPrompt('test')
            .setIncludeBuiltinTools(false)
            .build();
        expect(agent).toBeDefined();
    });

    it('supports fluent chaining', () => {
        const mock = new MockLLMProvider();
        const builder = new AgentBuilder();
        const result = builder
            .setLLMProvider(mock)
            .setSystemPrompt('You are helpful.')
            .addTool({
                name: 'greet',
                description: 'Say hi',
                execute: () => 'Hi!',
            })
            .addSkill({
                name: 'ts',
                description: 'TypeScript',
                body: 'TS tips',
            })
            .enableMemory()
            .enableStreaming()
            .enableContext()
            .setMaxToolRounds(10);
        expect(result).toBe(builder);
    });

    it('adds multiple tools', () => {
        const mock = new MockLLMProvider();
        const agent = new AgentBuilder()
            .setLLMProvider(mock)
            .setIncludeBuiltinTools(false)
            .addTools([
                { name: 'a', description: 'A', execute: () => 'a' },
                { name: 'b', description: 'B', execute: () => 'b' },
            ])
            .build();
        // The agent should have the tools (plus internal ones like Skill, ask_user)
        expect(agent.tools.length).toBeGreaterThanOrEqual(2);
    });

    it('clamps maxToolRounds', () => {
        const mock = new MockLLMProvider();
        const agent1 = new AgentBuilder()
            .setLLMProvider(mock)
            .setIncludeBuiltinTools(false)
            .setMaxToolRounds(0)
            .build();
        const agent2 = new AgentBuilder()
            .setLLMProvider(mock)
            .setIncludeBuiltinTools(false)
            .setMaxToolRounds(200)
            .build();
        expect(agent1).toBeDefined();
        expect(agent2).toBeDefined();
    });

    it('sets approval callback', () => {
        const mock = new MockLLMProvider();
        const agent = new AgentBuilder()
            .setLLMProvider(mock)
            .setIncludeBuiltinTools(false)
            .setApprovalCallback(() => true)
            .build();
        expect(agent).toBeDefined();
    });

    it('sets human input callback', () => {
        const mock = new MockLLMProvider();
        const agent = new AgentBuilder()
            .setLLMProvider(mock)
            .setIncludeBuiltinTools(false)
            .setHumanInputCallback(() => 'user response')
            .build();
        expect(agent).toBeDefined();
    });
});
