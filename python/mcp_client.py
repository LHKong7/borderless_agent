"""
mcp_client.py — MCP (Model Context Protocol) integration for Python agent.

Manages connections to one or more MCP servers (stdio or HTTP),
discovers their tools, and routes tool calls to the correct server.

MCP tool names are prefixed with "mcp_{server_name}_{tool_name}"
to avoid collisions with built-in tools.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger("agent")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class MCPServerConfig:
    """Configuration for a single MCP server connection."""

    name: str
    """Unique name for this server (used to prefix tool names)."""

    transport: str  # "stdio" | "http"
    """Transport type: 'stdio' for local process, 'http' for remote server."""

    command: Optional[str] = None
    """For stdio: command to spawn (e.g. 'npx', 'python')."""

    args: Optional[List[str]] = None
    """For stdio: command arguments."""

    env: Optional[Dict[str, str]] = None
    """For stdio: extra environment variables for the spawned process."""

    url: Optional[str] = None
    """For http: server URL (e.g. 'http://localhost:3000/mcp')."""


# ---------------------------------------------------------------------------
# Internal types
# ---------------------------------------------------------------------------

@dataclass
class _MCPToolInfo:
    original_name: str
    prefixed_name: str
    description: str
    input_schema: Dict[str, Any]


@dataclass
class _ConnectedServer:
    config: MCPServerConfig
    session: Any  # ClientSession
    tools: List[_MCPToolInfo] = field(default_factory=list)
    _cleanup: Any = None  # Async cleanup callable


# ---------------------------------------------------------------------------
# MCPManager
# ---------------------------------------------------------------------------

class MCPManager:
    """
    Manages connections to MCP servers and routes tool calls.

    Since the Python MCP SDK is async but the agent loop is sync,
    this class uses an internal asyncio event loop to bridge the gap.
    """

    def __init__(self) -> None:
        self._servers: Dict[str, _ConnectedServer] = {}
        self._tool_index: Dict[str, str] = {}  # prefixed_name → server_name
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._contexts: List[Any] = []  # Track context managers for cleanup

    def _get_loop(self) -> asyncio.AbstractEventLoop:
        """Get or create a dedicated event loop for MCP operations."""
        if self._loop is None or self._loop.is_closed():
            self._loop = asyncio.new_event_loop()
        return self._loop

    def _run_async(self, coro: Any) -> Any:
        """Run an async coroutine in our dedicated event loop."""
        loop = self._get_loop()
        return loop.run_until_complete(coro)

    def connect(self, configs: List[MCPServerConfig]) -> None:
        """Connect to all configured MCP servers and discover their tools."""
        for cfg in configs:
            try:
                self._connect_server(cfg)
            except Exception as e:
                logger.error(f"Failed to connect MCP server '{cfg.name}': {e}")

    def _connect_server(self, config: MCPServerConfig) -> None:
        """Connect to a single MCP server."""
        if config.name in self._servers:
            logger.warning(f"MCP server '{config.name}' already connected, skipping.")
            return

        self._run_async(self._async_connect_server(config))

    async def _async_connect_server(self, config: MCPServerConfig) -> None:
        """Async implementation of server connection."""
        from mcp import ClientSession, StdioServerParameters

        name = config.name

        if config.transport == "stdio":
            if not config.command:
                raise ValueError(f"MCP stdio server '{name}' requires a 'command'")

            from mcp.client.stdio import stdio_client

            server_params = StdioServerParameters(
                command=config.command,
                args=config.args or [],
                env={**os.environ, **(config.env or {})},
            )

            # Enter the stdio_client context manager
            ctx = stdio_client(server_params)
            read_stream, write_stream = await ctx.__aenter__()
            self._contexts.append(ctx)

        elif config.transport == "http":
            if not config.url:
                raise ValueError(f"MCP HTTP server '{name}' requires a 'url'")

            from mcp.client.streamable_http import streamable_http_client

            ctx = streamable_http_client(config.url)
            read_stream, write_stream, _ = await ctx.__aenter__()
            self._contexts.append(ctx)

        else:
            raise ValueError(f"Unknown MCP transport: {config.transport}")

        # Create and initialize session
        session_ctx = ClientSession(read_stream, write_stream)
        session = await session_ctx.__aenter__()
        self._contexts.append(session_ctx)
        await session.initialize()

        logger.info(f"MCP server '{name}' connected ({config.transport}).")

        # Discover tools (handle pagination)
        tools: List[_MCPToolInfo] = []
        cursor: Optional[str] = None
        while True:
            result = await session.list_tools(cursor=cursor)
            for tool in result.tools:
                prefixed_name = f"mcp_{name}_{tool.name}"
                schema = {}
                if tool.inputSchema:
                    schema = (
                        tool.inputSchema
                        if isinstance(tool.inputSchema, dict)
                        else tool.inputSchema.model_dump()
                    )
                tools.append(_MCPToolInfo(
                    original_name=tool.name,
                    prefixed_name=prefixed_name,
                    description=tool.description or "",
                    input_schema=schema,
                ))
                self._tool_index[prefixed_name] = name
            cursor = getattr(result, "nextCursor", None)
            if not cursor:
                break

        self._servers[name] = _ConnectedServer(
            config=config,
            session=session,
            tools=tools,
        )

        tool_names = [t.prefixed_name for t in tools]
        logger.info(
            f"MCP server '{name}': discovered {len(tools)} tool(s) — {', '.join(tool_names)}"
        )

    def get_tool_definitions(self) -> List[Dict[str, Any]]:
        """
        Get all discovered MCP tools in OpenAI function-calling format.
        """
        tools = []
        for server in self._servers.values():
            for tool in server.tools:
                tools.append({
                    "name": tool.prefixed_name,
                    "description": f"[MCP:{server.config.name}] {tool.description}",
                    "input_schema": tool.input_schema,
                })
        return tools

    def is_mcp_tool(self, name: str) -> bool:
        """Check if a tool name belongs to an MCP server."""
        return name in self._tool_index

    def call_tool(self, prefixed_name: str, args: Dict[str, Any]) -> str:
        """Call an MCP tool by its prefixed name (sync wrapper)."""
        return self._run_async(self._async_call_tool(prefixed_name, args))

    async def _async_call_tool(
        self, prefixed_name: str, args: Dict[str, Any]
    ) -> str:
        """Async implementation of tool call."""
        server_name = self._tool_index.get(prefixed_name)
        if not server_name:
            return f"Error: MCP tool not found: {prefixed_name}"

        server = self._servers.get(server_name)
        if not server:
            return f"Error: MCP server not connected: {server_name}"

        tool = next(
            (t for t in server.tools if t.prefixed_name == prefixed_name), None
        )
        if not tool:
            return f"Error: Tool not found on server {server_name}: {prefixed_name}"

        try:
            result = await server.session.call_tool(
                tool.original_name, arguments=args
            )

            # Parse content blocks
            if result.content and isinstance(result.content, list):
                parts = []
                for block in result.content:
                    if hasattr(block, "text"):
                        parts.append(block.text)
                    elif hasattr(block, "type") and block.type == "image":
                        parts.append(f"[Image: {getattr(block, 'mimeType', 'unknown')}]")
                    elif hasattr(block, "uri"):
                        parts.append(f"[Resource: {block.uri}]")
                    else:
                        parts.append(str(block))
                return "\n".join(parts)

            # Fallback
            if hasattr(result, "structuredContent") and result.structuredContent:
                import json
                return json.dumps(result.structuredContent, indent=2)

            return str(result.content or "(empty result)")

        except Exception as e:
            logger.error(f"MCP callTool error ({prefixed_name}): {e}")
            return f"Error calling MCP tool {prefixed_name}: {e}"

    def get_connected_servers(self) -> List[str]:
        """Get names of all connected MCP servers."""
        return list(self._servers.keys())

    def close(self) -> None:
        """Gracefully close all MCP server connections."""
        if self._loop and not self._loop.is_closed():
            try:
                self._run_async(self._async_close())
            except Exception as e:
                logger.error(f"Error during MCP shutdown: {e}")
            finally:
                self._loop.close()
                self._loop = None

    async def _async_close(self) -> None:
        """Async cleanup of all context managers."""
        for ctx in reversed(self._contexts):
            try:
                await ctx.__aexit__(None, None, None)
            except Exception as e:
                logger.error(f"Error closing MCP context: {e}")
        self._contexts.clear()
        self._servers.clear()
        self._tool_index.clear()
