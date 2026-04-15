/**
 * harness.ts — Composition root for the agent runtime.
 *
 * `AgentHarness` is the single object that owns the cross-cutting
 * dependencies the agent loop needs:
 *   - llm provider
 *   - sandbox (permission + execution wrapping)
 *   - tool registry + parallel tool executor
 *   - telemetry (spans, logs)
 *   - metrics (turn / tool aggregates)
 *   - mcpManager (lazy)
 *
 * `AgentInstance` builds a harness in its constructor; advanced users can
 * also build a harness directly to mix and match components in tests or
 * orchestrate multiple agents off a shared telemetry backend.
 *
 * This is intentionally additive: nothing about the public AgentInstance
 * API changes. The harness exists to break tight coupling between the
 * loop and the components it depends on.
 */

import type { LLMProvider } from './llmProtocol';
import type { ToolDefinition } from './types';
import { Sandbox, SandboxConfig } from './sandbox';
import { ToolExecutor } from './toolExecutor';
import { Telemetry } from './telemetry';
import { MetricsCollector } from './metrics';
import { MCPManager, MCPServerConfig } from './mcpClient';

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/** Lookup-only tool registry. Mutation is intentionally restricted to
 *  the harness builder so the registry can index by name once. */
export class ToolRegistry {
    private readonly _byName: Map<string, ToolDefinition> = new Map();

    constructor(tools: ToolDefinition[] = []) {
        for (const t of tools) this._byName.set(t.name, t);
    }

    register(tool: ToolDefinition): void {
        if (this._byName.has(tool.name)) {
            throw new Error(`Tool already registered: ${tool.name}`);
        }
        this._byName.set(tool.name, tool);
    }

    has(name: string): boolean { return this._byName.has(name); }
    get(name: string): ToolDefinition | undefined { return this._byName.get(name); }
    list(): ToolDefinition[] { return Array.from(this._byName.values()); }
    asMap(): Map<string, ToolDefinition> { return this._byName; }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface HarnessConfig {
    llm: LLMProvider;
    tools?: ToolDefinition[];
    sandbox?: SandboxConfig | Sandbox;
    telemetry?: Telemetry;
    metrics?: MetricsCollector;
    mcpServers?: MCPServerConfig[];
}

export class AgentHarness {
    readonly llm: LLMProvider;
    readonly sandbox: Sandbox;
    readonly toolRegistry: ToolRegistry;
    readonly toolExecutor: ToolExecutor;
    readonly telemetry: Telemetry;
    readonly metrics: MetricsCollector;
    readonly mcpConfigs: MCPServerConfig[];

    private _mcpManager: MCPManager | null = null;
    private _mcpInitialized = false;
    private _mcpInitPromise: Promise<void> | null = null;

    constructor(config: HarnessConfig) {
        this.llm = config.llm;
        this.sandbox = config.sandbox instanceof Sandbox
            ? config.sandbox
            : new Sandbox(config.sandbox);
        this.telemetry = config.telemetry ?? Telemetry.noop();
        this.metrics = config.metrics ?? new MetricsCollector();
        this.toolRegistry = new ToolRegistry(config.tools ?? []);
        this.toolExecutor = new ToolExecutor(
            this.toolRegistry.asMap(),
            this.sandbox,
            { telemetry: this.telemetry, metrics: this.metrics },
        );
        this.mcpConfigs = config.mcpServers ?? [];
    }

    /** Lazily initialise MCP server connections. Idempotent. */
    async initMCP(): Promise<void> {
        if (this._mcpInitialized || !this.mcpConfigs.length) return;
        if (this._mcpInitPromise) return this._mcpInitPromise;
        this._mcpInitPromise = (async () => {
            try {
                this._mcpManager = new MCPManager();
                await this._mcpManager.connect(this.mcpConfigs);
                this.telemetry.info('mcp', 'connected', { servers: this.mcpConfigs.length });
            } catch (e: any) {
                this.telemetry.warn('mcp', 'connection failed; continuing without MCP', { error: e?.message ?? String(e) });
                console.error('[AgentHarness] MCP connection failed:', e?.message ?? e);
                this._mcpManager = null;
            }
            this._mcpInitialized = true;
        })();
        return this._mcpInitPromise;
    }

    /** Returns the active MCPManager (after `initMCP()`), or null. */
    get mcpManager(): MCPManager | null { return this._mcpManager; }

    /** Close MCP connections (call from `agent.close()`). */
    async close(): Promise<void> {
        if (this._mcpManager) {
            await this._mcpManager.close();
            this._mcpManager = null;
            this._mcpInitialized = false;
            this._mcpInitPromise = null;
        }
    }
}
