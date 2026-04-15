/**
 * toolExecutor.ts — Parallel-aware tool execution with per-tool timeouts.
 *
 * Splits a batch of tool calls into a parallel group (concurrency-safe,
 * no approval required) and a serialized group (mutating / requires
 * approval), executes them with `Promise.allSettled`, enforces per-tool
 * timeouts via AbortController, and surfaces structured errors.
 *
 * This module is purposely independent of AgentInstance so it can be
 * reused by future harness composition (PR3) and tested in isolation.
 */

import { ToolDefinition } from './types';
import { Sandbox } from './sandbox';
import {
    ToolError,
    ToolTimeoutError,
    ToolExecutionError,
} from './errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRequest {
    /** Tool call id (matches the LLM's `tool_call_id`). */
    id: string;
    /** Tool name to invoke. */
    name: string;
    /** Parsed arguments object. */
    arguments: Record<string, any>;
}

export interface ToolCallResult {
    id: string;
    name: string;
    output: string;
    success: boolean;
    durationMs: number;
    /** Machine-readable error code (only when success === false). */
    errorCode?: string;
    /** Whether this call was approved (only relevant for ask/approval flow). */
    approved?: boolean;
}

export interface ExecutionPlan {
    parallel: ToolCallRequest[];
    serialized: ToolCallRequest[];
}

export interface ToolExecutorContext {
    /** Approval callback (mirrors AgentConfig.approvalCallback). */
    approvalCallback?: (
        name: string,
        args: Record<string, any>,
    ) => Promise<boolean> | boolean;
    /** Optional MCP routing — if it claims the tool, executor delegates. */
    mcpRouter?: {
        isMCPTool(name: string): boolean;
        callTool(name: string, args: Record<string, any>): Promise<string>;
    } | null;
    /** Optional hook fired right before each tool executes (for telemetry/logging). */
    onToolStart?: (req: ToolCallRequest) => void;
    /** Optional hook fired when a tool finishes (success or failure). */
    onToolEnd?: (result: ToolCallResult) => void;
}

export interface ToolExecutorOptions {
    /** Default per-tool timeout when ToolDefinition doesn't supply one. Default: 60s. */
    defaultTimeoutMs?: number;
    /** Hard ceiling for any single tool. Default: 10 minutes. */
    maxTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// ToolExecutor
// ---------------------------------------------------------------------------

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const MAX_TOOL_TIMEOUT_MS = 600_000;

export class ToolExecutor {
    private readonly _toolMap: Map<string, ToolDefinition>;
    private readonly _sandbox: Sandbox;
    private readonly _defaultTimeoutMs: number;
    private readonly _maxTimeoutMs: number;

    constructor(
        toolMap: Map<string, ToolDefinition>,
        sandbox: Sandbox,
        options: ToolExecutorOptions = {},
    ) {
        this._toolMap = toolMap;
        this._sandbox = sandbox;
        this._defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
        this._maxTimeoutMs = options.maxTimeoutMs ?? MAX_TOOL_TIMEOUT_MS;
    }

    /**
     * Categorize tool calls into parallel-safe vs serialized groups.
     *
     * A tool call is serialized when:
     * - The tool requires approval (mutating / dangerous), OR
     * - The tool is explicitly flagged `concurrencySafe === false`.
     *
     * Unknown tools and MCP tools default to parallel (errors surface fast).
     */
    planExecution(calls: ToolCallRequest[]): ExecutionPlan {
        const parallel: ToolCallRequest[] = [];
        const serialized: ToolCallRequest[] = [];
        for (const c of calls) {
            const def = this._toolMap.get(c.name);
            const requiresApproval = def?.requiresApproval === true;
            const concurrencySafe = (def as any)?.concurrencySafe !== false;
            if (requiresApproval || !concurrencySafe) {
                serialized.push(c);
            } else {
                parallel.push(c);
            }
        }
        return { parallel, serialized };
    }

    /**
     * Execute a batch of tool calls. Returns results in the **original
     * input order**, not execution order.
     */
    async executeAll(
        calls: ToolCallRequest[],
        ctx: ToolExecutorContext = {},
    ): Promise<ToolCallResult[]> {
        if (!calls.length) return [];

        const plan = this.planExecution(calls);
        const indexById = new Map<string, number>();
        calls.forEach((c, i) => indexById.set(c.id, i));

        const results: ToolCallResult[] = new Array(calls.length);

        // Parallel group — Promise.allSettled so one failure doesn't poison others.
        if (plan.parallel.length > 0) {
            const settled = await Promise.allSettled(
                plan.parallel.map((req) => this._executeOne(req, ctx)),
            );
            settled.forEach((s, i) => {
                const req = plan.parallel[i];
                const idx = indexById.get(req.id)!;
                if (s.status === 'fulfilled') {
                    results[idx] = s.value;
                } else {
                    // Should never happen — _executeOne always resolves —
                    // but guard for completeness.
                    results[idx] = this._failureResult(
                        req,
                        0,
                        new ToolExecutionError(req.name, s.reason instanceof Error ? s.reason : new Error(String(s.reason))),
                    );
                }
            });
        }

        // Serialized group — execute one at a time so approval prompts don't overlap.
        for (const req of plan.serialized) {
            const idx = indexById.get(req.id)!;
            results[idx] = await this._executeOne(req, ctx);
        }

        return results;
    }

    // -------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------

    private async _executeOne(
        req: ToolCallRequest,
        ctx: ToolExecutorContext,
    ): Promise<ToolCallResult> {
        const startedAt = Date.now();
        ctx.onToolStart?.(req);

        const finalize = (r: ToolCallResult): ToolCallResult => {
            ctx.onToolEnd?.(r);
            return r;
        };

        // 1) MCP routing takes precedence (these tools are not in _toolMap).
        if (ctx.mcpRouter?.isMCPTool(req.name)) {
            try {
                const out = await this._withTimeout(
                    () => ctx.mcpRouter!.callTool(req.name, req.arguments),
                    this._defaultTimeoutMs,
                    req.name,
                );
                return finalize({
                    id: req.id,
                    name: req.name,
                    output: out,
                    success: true,
                    durationMs: Date.now() - startedAt,
                });
            } catch (err) {
                return finalize(this._failureResult(req, Date.now() - startedAt, this._wrapError(req.name, err)));
            }
        }

        const tool = this._toolMap.get(req.name);
        if (!tool) {
            return finalize({
                id: req.id,
                name: req.name,
                output: `Unknown tool: ${req.name}`,
                success: false,
                durationMs: Date.now() - startedAt,
                errorCode: 'TOOL_NOT_FOUND',
            });
        }

        // 2) Sandbox permission check (denies / asks before any execution).
        const decision = this._sandbox.checkPermission(req.name, req.arguments);
        if (decision.behavior === 'deny') {
            return finalize({
                id: req.id,
                name: req.name,
                output: decision.message || 'Operation blocked by sandbox',
                success: false,
                durationMs: Date.now() - startedAt,
                errorCode: 'PERMISSION_DENIED',
            });
        }
        if (decision.behavior === 'ask') {
            if (ctx.approvalCallback) {
                const approved = await ctx.approvalCallback(req.name, req.arguments);
                if (!approved) {
                    return finalize({
                        id: req.id,
                        name: req.name,
                        output: 'Action not approved by user.',
                        success: false,
                        durationMs: Date.now() - startedAt,
                        errorCode: 'USER_DENIED',
                        approved: false,
                    });
                }
            } else {
                return finalize({
                    id: req.id,
                    name: req.name,
                    output: decision.message || 'Operation requires confirmation but no approval callback set',
                    success: false,
                    durationMs: Date.now() - startedAt,
                    errorCode: 'APPROVAL_REQUIRED',
                });
            }
        }

        // 3) Legacy `requiresApproval` flag for user-defined tools.
        if (tool.requiresApproval && ctx.approvalCallback && decision.behavior === 'allow') {
            const approved = await ctx.approvalCallback(req.name, req.arguments);
            if (!approved) {
                return finalize({
                    id: req.id,
                    name: req.name,
                    output: 'Action not approved by user.',
                    success: false,
                    durationMs: Date.now() - startedAt,
                    errorCode: 'USER_DENIED',
                    approved: false,
                });
            }
        }

        // 4) Execute with per-tool timeout, sandbox-wrapped output limits.
        const timeoutMs = this._resolveTimeout(tool);
        try {
            const output = await this._withTimeout(
                () => this._sandbox.wrapExecution(async () => tool.execute(req.arguments)),
                timeoutMs,
                req.name,
            );
            return finalize({
                id: req.id,
                name: req.name,
                output: typeof output === 'string' ? output : String(output),
                success: true,
                durationMs: Date.now() - startedAt,
                approved: true,
            });
        } catch (err) {
            return finalize(this._failureResult(req, Date.now() - startedAt, this._wrapError(req.name, err)));
        }
    }

    private _resolveTimeout(tool: ToolDefinition): number {
        const t = (tool as any).timeout;
        const ms = typeof t === 'number' && t > 0 ? t : this._defaultTimeoutMs;
        return Math.min(ms, this._maxTimeoutMs);
    }

    private async _withTimeout<T>(
        fn: () => Promise<T>,
        timeoutMs: number,
        toolName: string,
    ): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new ToolTimeoutError(toolName, timeoutMs)),
                    timeoutMs,
                );
            });
            return await Promise.race([fn(), timeoutPromise]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private _wrapError(toolName: string, err: unknown): ToolError {
        if (err instanceof ToolError) return err;
        const cause = err instanceof Error ? err : new Error(String(err));
        return new ToolExecutionError(toolName, cause);
    }

    private _failureResult(
        req: ToolCallRequest,
        durationMs: number,
        err: ToolError,
    ): ToolCallResult {
        return {
            id: req.id,
            name: req.name,
            output: `[${err.code}] ${err.message}`,
            success: false,
            durationMs,
            errorCode: err.code,
        };
    }
}
