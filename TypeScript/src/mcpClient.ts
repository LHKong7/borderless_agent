/**
 * mcpClient.ts — MCP (Model Context Protocol) integration.
 *
 * Manages connections to one or more MCP servers (stdio or HTTP),
 * discovers their tools, and routes tool calls to the correct server.
 *
 * MCP tool names are prefixed with "mcp_{serverName}_{toolName}"
 * to avoid collisions with built-in tools.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from './config';

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
    /** Unique name for this server (used to prefix tool names). */
    name: string;
    /** Transport type: 'stdio' for local process, 'http' for remote server. */
    transport: 'stdio' | 'http';
    /** For stdio: command to spawn (e.g. 'npx', 'node'). */
    command?: string;
    /** For stdio: command arguments (e.g. ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']). */
    args?: string[];
    /** For stdio: extra environment variables for the spawned process. */
    env?: Record<string, string>;
    /** For http: server URL (e.g. 'http://localhost:3000/mcp'). */
    url?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ConnectedServer {
    config: MCPServerConfig;
    client: Client;
    tools: MCPToolInfo[];
}

interface MCPToolInfo {
    /** Original tool name from the MCP server. */
    originalName: string;
    /** Prefixed name: mcp_{serverName}_{toolName} */
    prefixedName: string;
    /** Tool description. */
    description: string;
    /** JSON Schema for input parameters. */
    inputSchema: Record<string, any>;
}

// ---------------------------------------------------------------------------
// MCPManager
// ---------------------------------------------------------------------------

export class MCPManager {
    private _servers: Map<string, ConnectedServer> = new Map();
    private _toolIndex: Map<string, string> = new Map(); // prefixedName → serverName

    /**
     * Connect to all configured MCP servers and discover their tools.
     * Errors on individual servers are logged but do not prevent others from connecting.
     */
    async connect(configs: MCPServerConfig[]): Promise<void> {
        const connectPromises = configs.map((cfg) => this._connectServer(cfg));
        await Promise.allSettled(connectPromises);
    }

    /**
     * Get all discovered MCP tools in OpenAI function-calling format.
     */
    getToolDefinitions(): Record<string, any>[] {
        const tools: Record<string, any>[] = [];
        for (const server of this._servers.values()) {
            for (const tool of server.tools) {
                tools.push({
                    name: tool.prefixedName,
                    description: `[MCP:${server.config.name}] ${tool.description}`,
                    input_schema: tool.inputSchema,
                });
            }
        }
        return tools;
    }

    /**
     * Check if a tool name belongs to an MCP server.
     */
    isMCPTool(name: string): boolean {
        return this._toolIndex.has(name);
    }

    /**
     * Call an MCP tool by its prefixed name.
     */
    async callTool(prefixedName: string, args: Record<string, any>): Promise<string> {
        const serverName = this._toolIndex.get(prefixedName);
        if (!serverName) {
            return `Error: MCP tool not found: ${prefixedName}`;
        }

        const server = this._servers.get(serverName);
        if (!server) {
            return `Error: MCP server not connected: ${serverName}`;
        }

        const tool = server.tools.find((t) => t.prefixedName === prefixedName);
        if (!tool) {
            return `Error: Tool not found on server ${serverName}: ${prefixedName}`;
        }

        try {
            const result = await server.client.callTool({
                name: tool.originalName,
                arguments: args,
            });

            // MCP tool results have a `content` array of typed blocks
            if (result.content && Array.isArray(result.content)) {
                return result.content
                    .map((block: any) => {
                        if (block.type === 'text') return block.text;
                        if (block.type === 'image') return `[Image: ${block.mimeType}]`;
                        if (block.type === 'resource') return `[Resource: ${block.uri}]`;
                        return JSON.stringify(block);
                    })
                    .join('\n');
            }

            // Fallback: structuredContent or raw
            if (result.structuredContent) {
                return JSON.stringify(result.structuredContent, null, 2);
            }

            return String(result.content ?? '(empty result)');
        } catch (err: any) {
            logger.error(`MCP callTool error (${prefixedName}): ${err.message ?? err}`);
            return `Error calling MCP tool ${prefixedName}: ${err.message ?? String(err)}`;
        }
    }

    /**
     * Get the names of all connected MCP servers.
     */
    getConnectedServers(): string[] {
        return [...this._servers.keys()];
    }

    /**
     * Gracefully close all MCP server connections.
     */
    async close(): Promise<void> {
        const closePromises: Promise<void>[] = [];
        for (const server of this._servers.values()) {
            closePromises.push(
                server.client.close().catch((err) => {
                    logger.error(`Error closing MCP server ${server.config.name}: ${err}`);
                }),
            );
        }
        await Promise.allSettled(closePromises);
        this._servers.clear();
        this._toolIndex.clear();
    }

    // ---- Private methods ----

    private async _connectServer(config: MCPServerConfig): Promise<void> {
        const { name, transport } = config;
        if (this._servers.has(name)) {
            logger.warning(`MCP server '${name}' already connected, skipping.`);
            return;
        }

        try {
            const client = new Client({
                name: `borderless-agent-${name}`,
                version: '1.0.0',
            });

            let mcpTransport: any;
            if (transport === 'stdio') {
                if (!config.command) {
                    throw new Error(`MCP stdio server '${name}' requires a 'command'`);
                }
                mcpTransport = new StdioClientTransport({
                    command: config.command,
                    args: config.args ?? [],
                    env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
                });
            } else if (transport === 'http') {
                if (!config.url) {
                    throw new Error(`MCP HTTP server '${name}' requires a 'url'`);
                }
                mcpTransport = new StreamableHTTPClientTransport(
                    new URL(config.url),
                );
            } else {
                throw new Error(`Unknown MCP transport: ${transport}`);
            }

            await client.connect(mcpTransport);
            logger.info(`MCP server '${name}' connected (${transport}).`);

            // Discover tools (handle pagination)
            const tools: MCPToolInfo[] = [];
            let cursor: string | undefined;
            do {
                const result = await client.listTools({ cursor });
                for (const tool of result.tools) {
                    const prefixedName = `mcp_${name}_${tool.name}`;
                    tools.push({
                        originalName: tool.name,
                        prefixedName,
                        description: tool.description ?? '',
                        inputSchema: (tool.inputSchema as Record<string, any>) ?? {
                            type: 'object',
                            properties: {},
                        },
                    });
                    this._toolIndex.set(prefixedName, name);
                }
                cursor = result.nextCursor;
            } while (cursor);

            this._servers.set(name, { config, client, tools });
            logger.info(
                `MCP server '${name}': discovered ${tools.length} tool(s) — ${tools.map((t) => t.prefixedName).join(', ')}`,
            );
        } catch (err: any) {
            logger.error(
                `Failed to connect MCP server '${name}': ${err.message ?? err}`,
            );
        }
    }
}
