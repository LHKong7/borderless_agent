"""
agentic-system — Portable agentic AI framework for Python.

Usage::

    from agentic_system import AgentBuilder

    agent = (
        AgentBuilder()
        .set_llm(api_key="sk-...")
        .set_system_prompt("You are a helpful assistant.")
        .add_tool(name="greet", description="Say hi", execute=lambda _: "Hi!")
        .build()
    )

    result = agent.chat("Hello!")
    print(result.reply)
"""

# Builder & Instance
from agent_builder import AgentBuilder  # noqa: F401
from agent_instance import AgentInstance  # noqa: F401

# Public types
from agent_types import (  # noqa: F401
    AgentConfig,
    AgentSession,
    ChatResult,
    LLMConfig,
    SkillDefinition,
    StorageConfig,
    StreamChunk,
    ToolDefinition,
    AutonomousTaskConfig,
    AutonomousTaskResult,
    IterationProgress,
)

# LLM provider (for advanced users)
from llm_protocol import LLMProvider, LLMResponse, OpenAIProvider  # noqa: F401

# Storage factories
from storage import get_storage_backend  # noqa: F401

# Session manager (for direct access)
from session_core import Session, SessionManager  # noqa: F401

# MCP
from mcp_client import MCPServerConfig, MCPManager  # noqa: F401

__all__ = [
    # Core API
    "AgentBuilder",
    "AgentInstance",
    # Types
    "ToolDefinition",
    "SkillDefinition",
    "AgentConfig",
    "LLMConfig",
    "StorageConfig",
    "ChatResult",
    "StreamChunk",
    "AgentSession",
    # Autonomous task
    "AutonomousTaskConfig",
    "AutonomousTaskResult",
    "IterationProgress",
    # LLM
    "LLMProvider",
    "LLMResponse",
    "OpenAIProvider",
    # Storage
    "get_storage_backend",
    # Session
    "Session",
    "SessionManager",
    # MCP
    "MCPServerConfig",
    "MCPManager",
]
