"""
types.py — Public type definitions for the agentic-system Python library.

Users import these to define tools, skills, and configure agents.
Mirrors the TypeScript types.ts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import (
    Any,
    AsyncGenerator,
    Callable,
    Dict,
    Generator,
    List,
    Optional,
    Protocol,
    Union,
    runtime_checkable,
)


# ---------------------------------------------------------------------------
# Tool definition (user-facing)
# ---------------------------------------------------------------------------

@dataclass
class ToolDefinition:
    """
    A tool the agent can call. Users provide ``execute`` — the runtime handler.

    Example::

        ToolDefinition(
            name="search_docs",
            description="Search project documentation",
            parameters={"query": {"type": "string"}},
            required=["query"],
            execute=lambda args: f"Results for: {args['query']}",
        )
    """

    name: str
    description: str
    parameters: Dict[str, Any] = field(default_factory=dict)
    required: List[str] = field(default_factory=list)
    execute: Callable[[Dict[str, Any]], str] = field(default=lambda args: "")
    requires_approval: bool = False
    permission_level: Optional[str] = None  # 'safe' | 'moderate' | 'dangerous' | 'critical'


# ---------------------------------------------------------------------------
# Skill definition (user-facing)
# ---------------------------------------------------------------------------

@dataclass
class SkillDefinition:
    """
    A skill that can be loaded by the agent on demand via the Skill tool.

    Example::

        SkillDefinition(
            name="python-expert",
            description="Expert knowledge about Python best practices",
            body="## Python style guide\\n- Use type hints...",
        )
    """

    name: str
    description: str
    body: str


# ---------------------------------------------------------------------------
# Agent configuration
# ---------------------------------------------------------------------------

@dataclass
class LLMConfig:
    api_key: str
    model: str = "gpt-4o"
    base_url: Optional[str] = None
    timeout: float = 120.0


@dataclass
class StorageConfig:
    backend: str = "file"  # "file" | "cloud" | "memory"
    dir: Optional[str] = None
    bucket: Optional[str] = None
    endpoint: Optional[str] = None
    region: Optional[str] = None


@dataclass
class AgentConfig:
    llm: Any = None  # LLMProvider instance
    llm_config: Optional[LLMConfig] = None
    system_prompt: Optional[str] = None
    tools: List[ToolDefinition] = field(default_factory=list)
    skills: List[SkillDefinition] = field(default_factory=list)
    include_builtin_tools: bool = True
    storage: Optional[StorageConfig] = None
    enable_memory: bool = False
    enable_streaming: bool = False
    enable_context: bool = True
    max_tool_rounds: int = 20
    approval_callback: Optional[Callable[[str, Dict[str, Any]], bool]] = None
    sandbox: Any = None  # SandboxConfig from sandbox.py
    mcp_servers: Optional[List[Any]] = None  # List[MCPServerConfig] from mcp_client.py


# ---------------------------------------------------------------------------
# Chat result types
# ---------------------------------------------------------------------------

@dataclass
class ChatResult:
    """Result from a single chat turn."""

    reply: str
    history: List[Dict[str, Any]]
    had_tool_calls: bool
    session_id: Optional[str] = None


@dataclass
class StreamChunk:
    """A chunk yielded during streaming."""

    delta: Optional[str] = None
    reply: Optional[str] = None
    done: bool = False


# ---------------------------------------------------------------------------
# Session handle (protocol)
# ---------------------------------------------------------------------------

@runtime_checkable
class AgentSession(Protocol):
    """Interface for a session handle."""

    @property
    def id(self) -> str: ...

    def chat(self, message: str) -> ChatResult: ...

    def stream(self, message: str) -> Generator[StreamChunk, None, None]: ...

    def get_history(self) -> List[Dict[str, Any]]: ...

    def save(self) -> None: ...


# ---------------------------------------------------------------------------
# Autonomous task types
# ---------------------------------------------------------------------------

AutonomousPhase = str  # Literal['plan', 'execute', 'review', 'evaluate']


@dataclass
class AutonomousTaskConfig:
    """Configuration for ``agent.run_task()``."""

    task: str
    quality_threshold: int = 7
    max_iterations: int = 10
    on_progress: Optional[Callable[['IterationProgress'], Optional[bool]]] = None


@dataclass
class IterationProgress:
    """Progress snapshot emitted after each phase."""

    iteration: int = 0
    phase: AutonomousPhase = 'plan'
    quality_score: Optional[int] = None
    plan: Optional[str] = None
    output: Optional[str] = None
    review: Optional[str] = None
    evaluation: Optional[str] = None


@dataclass
class AutonomousTaskResult:
    """Result of ``agent.run_task()``."""

    result: str = ''
    iterations: int = 0
    quality_score: int = 0
    threshold_met: bool = False
    progress_history: List[IterationProgress] = field(default_factory=list)
    history: List[Dict[str, Any]] = field(default_factory=list)
