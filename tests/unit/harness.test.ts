import { describe, it, expect } from 'vitest';
import { AgentHarness, ToolRegistry } from '../../src/harness';
import { MemoryExporter, Telemetry } from '../../src/telemetry';
import { ToolDefinition } from '../../src/types';
import { Sandbox } from '../../src/sandbox';

const fakeLLM = {
    chat: async () => ({ content: '', toolCalls: [], usage: {}, model: 'fake' }),
} as any;

describe('ToolRegistry', () => {
    it('rejects duplicate tool registration', () => {
        const r = new ToolRegistry([
            { name: 'a', description: '', execute: async () => 'ok' },
        ]);
        expect(() => r.register({ name: 'a', description: '', execute: async () => 'ok' })).toThrow(/already registered/);
    });

    it('lists registered tools', () => {
        const tools: ToolDefinition[] = [
            { name: 'a', description: '', execute: async () => 'A' },
            { name: 'b', description: '', execute: async () => 'B' },
        ];
        const r = new ToolRegistry(tools);
        expect(r.list().map((t) => t.name).sort()).toEqual(['a', 'b']);
        expect(r.has('a')).toBe(true);
        expect(r.get('b')?.name).toBe('b');
    });
});

describe('AgentHarness', () => {
    it('wires shared telemetry into the executor so spans propagate', async () => {
        const exp = new MemoryExporter();
        const tel = new Telemetry({ exporter: exp });
        const tools: ToolDefinition[] = [
            { name: 'echo', description: '', execute: async () => 'hi' },
        ];
        const h = new AgentHarness({
            llm: fakeLLM,
            tools,
            sandbox: { enabled: false },
            telemetry: tel,
        });
        await h.toolExecutor.executeAll([{ id: '1', name: 'echo', arguments: {} }]);
        expect(exp.spans.some((s) => s.name === 'tool.echo')).toBe(true);
        expect(h.metrics.getMetrics().toolMetrics.echo.callCount).toBe(1);
    });

    it('accepts a pre-built Sandbox instance', () => {
        const sb = new Sandbox({ enabled: false });
        const h = new AgentHarness({ llm: fakeLLM, sandbox: sb });
        expect(h.sandbox).toBe(sb);
    });

    it('initMCP is a no-op when no servers are configured', async () => {
        const h = new AgentHarness({ llm: fakeLLM });
        await h.initMCP();
        expect(h.mcpManager).toBeNull();
    });
});
