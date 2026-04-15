import { describe, it, expect } from 'vitest';
import { Telemetry, MemoryExporter } from '../../src/telemetry';
import { MetricsCollector } from '../../src/metrics';
import { ToolExecutor } from '../../src/toolExecutor';
import { Sandbox } from '../../src/sandbox';
import { ToolDefinition } from '../../src/types';

describe('Telemetry', () => {
    it('records spans and propagates traceId from parent', () => {
        const exp = new MemoryExporter();
        const t = new Telemetry({ exporter: exp });
        const root = t.startSpan('agent.turn');
        const child = t.startSpan('llm.chat');
        child.setAttribute('llm.model', 'test-model');
        child.end();
        root.end();
        expect(exp.spans).toHaveLength(2);
        const [llm, turn] = exp.spans;
        expect(llm.name).toBe('llm.chat');
        expect(turn.name).toBe('agent.turn');
        expect(llm.traceId).toBe(turn.traceId);
        expect(llm.parentSpanId).toBe(turn.spanId);
        expect(llm.attributes['llm.model']).toBe('test-model');
    });

    it('marks span error in withSpan when fn throws', async () => {
        const exp = new MemoryExporter();
        const t = new Telemetry({ exporter: exp });
        await expect(
            t.withSpan('boom', async () => { throw new Error('nope'); }),
        ).rejects.toThrow('nope');
        expect(exp.spans).toHaveLength(1);
        expect(exp.spans[0].status).toBe('error');
        expect(exp.spans[0].statusMessage).toBe('nope');
    });

    it('emits log entries with active trace context', () => {
        const exp = new MemoryExporter();
        const t = new Telemetry({ exporter: exp, minLogLevel: 'debug' });
        const span = t.startSpan('outer');
        t.info('test', 'hello', { k: 1 });
        span.end();
        expect(exp.logs).toHaveLength(1);
        expect(exp.logs[0].traceId).toBe(span.traceId);
        expect(exp.logs[0].context).toEqual({ k: 1 });
    });

    it('respects minLogLevel', () => {
        const exp = new MemoryExporter();
        const t = new Telemetry({ exporter: exp, minLogLevel: 'warn' });
        t.debug('x', 'd');
        t.info('x', 'i');
        t.warn('x', 'w');
        t.error('x', 'e');
        expect(exp.logs.map((l) => l.level)).toEqual(['warn', 'error']);
    });

    it('Telemetry.noop() is silent', () => {
        const t = Telemetry.noop();
        const s = t.startSpan('x');
        t.info('m', 'hi');
        s.end();
        // No exporter wired, nothing thrown.
        expect(t.activeSpan()).toBeUndefined();
    });
});

describe('MetricsCollector', () => {
    it('aggregates tool metrics', () => {
        const m = new MetricsCollector();
        m.recordToolCall('bash', 50, true);
        m.recordToolCall('bash', 150, true);
        m.recordToolCall('bash', 30, false);
        const snap = m.getMetrics();
        expect(snap.toolMetrics.bash.callCount).toBe(3);
        expect(snap.toolMetrics.bash.successCount).toBe(2);
        expect(snap.toolMetrics.bash.failureCount).toBe(1);
        expect(snap.toolMetrics.bash.avgDurationMs).toBeCloseTo((50 + 150 + 30) / 3);
    });

    it('records turn aggregates', () => {
        const m = new MetricsCollector();
        m.recordTurn({
            turnNumber: 1,
            hadToolCalls: true,
            toolCallCount: 2,
            inputTokens: 100,
            outputTokens: 50,
            durationMs: 1000,
            estimatedCost: 0.001,
            timestamp: Date.now(),
        });
        const snap = m.getMetrics();
        expect(snap.turnCount).toBe(1);
        expect(snap.totalInputTokens).toBe(100);
        expect(snap.totalCost).toBeCloseTo(0.001);
    });
});

describe('ToolExecutor + Telemetry integration', () => {
    it('emits a tool.<name> span for each call and updates metrics', async () => {
        const exp = new MemoryExporter();
        const tel = new Telemetry({ exporter: exp });
        const metrics = new MetricsCollector();
        const tools: ToolDefinition[] = [
            { name: 'ok', description: '', execute: async () => 'fine' },
            { name: 'bad', description: '', execute: async () => { throw new Error('nope'); } },
        ];
        const ex = new ToolExecutor(
            new Map(tools.map((t) => [t.name, t])),
            new Sandbox({ enabled: false }),
            { telemetry: tel, metrics },
        );
        await ex.executeAll([
            { id: '1', name: 'ok', arguments: {} },
            { id: '2', name: 'bad', arguments: {} },
        ]);
        const names = exp.spans.map((s) => s.name).sort();
        expect(names).toEqual(['tool.bad', 'tool.ok']);
        const snap = metrics.getMetrics();
        expect(snap.toolMetrics.ok.successCount).toBe(1);
        expect(snap.toolMetrics.bad.failureCount).toBe(1);
        expect(snap.errorsByType.TOOL_EXECUTION).toBe(1);
    });
});
