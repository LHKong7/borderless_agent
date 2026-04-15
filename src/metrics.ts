/**
 * metrics.ts — Aggregate per-turn / per-tool / per-error counters.
 *
 * Intentionally synchronous, in-memory, and zero-dep. Snapshot via
 * `getMetrics()` for inspection or export to an external system.
 */

export interface TurnMetrics {
    turnNumber: number;
    hadToolCalls: boolean;
    toolCallCount: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    estimatedCost?: number;
    timestamp: number;
}

export interface ToolMetrics {
    name: string;
    callCount: number;
    successCount: number;
    failureCount: number;
    totalDurationMs: number;
    avgDurationMs: number;
}

export interface AgentMetricsSnapshot {
    turnCount: number;
    turns: TurnMetrics[];
    toolMetrics: Record<string, ToolMetrics>;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    errorCount: number;
    errorsByType: Record<string, number>;
}

export class MetricsCollector {
    private _turns: TurnMetrics[] = [];
    private _toolMetrics: Map<string, ToolMetrics> = new Map();
    private _errorCount = 0;
    private _errorsByType: Record<string, number> = {};

    recordTurn(turn: TurnMetrics): void {
        this._turns.push(turn);
    }

    recordToolCall(name: string, durationMs: number, success: boolean): void {
        const existing = this._toolMetrics.get(name) ?? {
            name,
            callCount: 0,
            successCount: 0,
            failureCount: 0,
            totalDurationMs: 0,
            avgDurationMs: 0,
        };
        existing.callCount += 1;
        existing.totalDurationMs += durationMs;
        existing.avgDurationMs = existing.totalDurationMs / existing.callCount;
        if (success) existing.successCount += 1;
        else existing.failureCount += 1;
        this._toolMetrics.set(name, existing);
    }

    recordError(type: string): void {
        this._errorCount += 1;
        this._errorsByType[type] = (this._errorsByType[type] ?? 0) + 1;
    }

    getMetrics(): AgentMetricsSnapshot {
        let inTok = 0;
        let outTok = 0;
        let cost = 0;
        for (const t of this._turns) {
            inTok += t.inputTokens;
            outTok += t.outputTokens;
            cost += t.estimatedCost ?? 0;
        }
        const toolMap: Record<string, ToolMetrics> = {};
        for (const [k, v] of this._toolMetrics) toolMap[k] = { ...v };
        return {
            turnCount: this._turns.length,
            turns: [...this._turns],
            toolMetrics: toolMap,
            totalInputTokens: inTok,
            totalOutputTokens: outTok,
            totalCost: cost,
            errorCount: this._errorCount,
            errorsByType: { ...this._errorsByType },
        };
    }

    reset(): void {
        this._turns = [];
        this._toolMetrics.clear();
        this._errorCount = 0;
        this._errorsByType = {};
    }
}
