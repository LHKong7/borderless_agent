import { describe, it, expect } from 'vitest';
import { ToolExecutor, ToolCallRequest } from '../../src/toolExecutor';
import { Sandbox } from '../../src/sandbox';
import { ToolDefinition } from '../../src/types';

function makeMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
    return new Map(tools.map((t) => [t.name, t]));
}

function makeSandbox(): Sandbox {
    return new Sandbox({ enabled: false });
}

describe('ToolExecutor.planExecution', () => {
    it('routes approval-required tools to serialized', () => {
        const tools: ToolDefinition[] = [
            { name: 'safe', description: '', execute: async () => 'ok' },
            { name: 'risky', description: '', requiresApproval: true, execute: async () => 'ok' },
            { name: 'serial', description: '', concurrencySafe: false, execute: async () => 'ok' },
        ];
        const ex = new ToolExecutor(makeMap(tools), makeSandbox());
        const plan = ex.planExecution([
            { id: '1', name: 'safe', arguments: {} },
            { id: '2', name: 'risky', arguments: {} },
            { id: '3', name: 'serial', arguments: {} },
        ]);
        expect(plan.parallel.map((c) => c.id)).toEqual(['1']);
        expect(plan.serialized.map((c) => c.id).sort()).toEqual(['2', '3']);
    });

    it('treats unknown tools as parallel-safe (so the error surfaces immediately)', () => {
        const ex = new ToolExecutor(makeMap([]), makeSandbox());
        const plan = ex.planExecution([{ id: '1', name: 'mystery', arguments: {} }]);
        expect(plan.parallel).toHaveLength(1);
    });
});

describe('ToolExecutor.executeAll', () => {
    it('executes parallel-safe tools concurrently', async () => {
        let started = 0;
        let maxConcurrent = 0;
        const sleeper = async () => {
            started++;
            maxConcurrent = Math.max(maxConcurrent, started);
            await new Promise((r) => setTimeout(r, 30));
            started--;
            return 'done';
        };
        const tools: ToolDefinition[] = [
            { name: 'a', description: '', execute: sleeper },
            { name: 'b', description: '', execute: sleeper },
            { name: 'c', description: '', execute: sleeper },
        ];
        const ex = new ToolExecutor(makeMap(tools), makeSandbox());
        const t0 = Date.now();
        await ex.executeAll([
            { id: '1', name: 'a', arguments: {} },
            { id: '2', name: 'b', arguments: {} },
            { id: '3', name: 'c', arguments: {} },
        ]);
        const elapsed = Date.now() - t0;
        expect(maxConcurrent).toBeGreaterThanOrEqual(2);
        // Three serial 30ms calls would take ≥90ms; parallel should be much faster.
        expect(elapsed).toBeLessThan(80);
    });

    it('preserves input order in results', async () => {
        const tools: ToolDefinition[] = [
            { name: 'fast', description: '', execute: async () => 'A' },
            { name: 'slow', description: '', execute: async () => { await new Promise((r) => setTimeout(r, 25)); return 'B'; } },
        ];
        const ex = new ToolExecutor(makeMap(tools), makeSandbox());
        const results = await ex.executeAll([
            { id: '1', name: 'slow', arguments: {} },
            { id: '2', name: 'fast', arguments: {} },
        ]);
        expect(results.map((r) => r.id)).toEqual(['1', '2']);
        expect(results[0].output).toBe('B');
        expect(results[1].output).toBe('A');
    });

    it('returns a TOOL_TIMEOUT result when the per-tool timeout fires', async () => {
        const tools: ToolDefinition[] = [
            {
                name: 'hang',
                description: '',
                timeout: 30,
                execute: () => new Promise<string>((res) => setTimeout(() => res('late'), 200)),
            },
        ];
        const ex = new ToolExecutor(makeMap(tools), makeSandbox());
        const [r] = await ex.executeAll([{ id: '1', name: 'hang', arguments: {} }]);
        expect(r.success).toBe(false);
        expect(r.errorCode).toBe('TOOL_TIMEOUT');
    });

    it('isolates failures: one throwing tool does not break siblings', async () => {
        const tools: ToolDefinition[] = [
            { name: 'good', description: '', execute: async () => 'ok' },
            { name: 'bad', description: '', execute: async () => { throw new Error('boom'); } },
        ];
        const ex = new ToolExecutor(makeMap(tools), makeSandbox());
        const results = await ex.executeAll([
            { id: '1', name: 'bad', arguments: {} },
            { id: '2', name: 'good', arguments: {} },
        ]);
        expect(results[0].success).toBe(false);
        expect(results[0].errorCode).toBe('TOOL_EXECUTION');
        expect(results[1].success).toBe(true);
        expect(results[1].output).toBe('ok');
    });

    it('returns USER_DENIED when approval callback rejects', async () => {
        const tools: ToolDefinition[] = [
            { name: 'mut', description: '', requiresApproval: true, execute: async () => 'should not run' },
        ];
        const ex = new ToolExecutor(makeMap(tools), makeSandbox());
        const [r] = await ex.executeAll(
            [{ id: '1', name: 'mut', arguments: {} }],
            { approvalCallback: () => false },
        );
        expect(r.success).toBe(false);
        expect(r.errorCode).toBe('USER_DENIED');
    });

    it('returns TOOL_NOT_FOUND for unknown tools', async () => {
        const ex = new ToolExecutor(makeMap([]), makeSandbox());
        const [r] = await ex.executeAll([{ id: '1', name: 'ghost', arguments: {} }]);
        expect(r.success).toBe(false);
        expect(r.errorCode).toBe('TOOL_NOT_FOUND');
    });

    it('routes MCP tools through the supplied router', async () => {
        const ex = new ToolExecutor(makeMap([]), makeSandbox());
        const [r] = await ex.executeAll(
            [{ id: '1', name: 'mcp__x', arguments: { q: 1 } }],
            {
                mcpRouter: {
                    isMCPTool: (n) => n.startsWith('mcp__'),
                    callTool: async (n, a) => `mcp:${n}:${JSON.stringify(a)}`,
                },
            },
        );
        expect(r.success).toBe(true);
        expect(r.output).toBe('mcp:mcp__x:{"q":1}');
    });
});
