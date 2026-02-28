"""
agent_builder.py — Fluent builder for creating portable agent instances.

Usage::

    from agent_builder import AgentBuilder

    agent = (
        AgentBuilder()
        .set_llm(api_key="sk-...", model="gpt-4o")
        .set_system_prompt("You are a helpful assistant.")
        .add_tool(
            name="greet",
            description="Say hi",
            execute=lambda args: "Hi!",
        )
        .add_skill(name="ts", description="TypeScript", body="...")
        .enable_memory()
        .build()
    )
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from agent_types import ToolDefinition, SkillDefinition, AgentConfig, LLMConfig, StorageConfig


class AgentBuilder:
    """Fluent builder that produces an ``AgentInstance``."""

    def __init__(self) -> None:
        self._config = AgentConfig(
            include_builtin_tools=True,
            enable_memory=False,
            enable_streaming=False,
            enable_context=True,
            max_tool_rounds=20,
        )

    # ---- LLM ----

    def set_llm(
        self,
        api_key: str,
        model: str = "gpt-4o",
        base_url: Optional[str] = None,
        timeout: float = 120.0,
    ) -> "AgentBuilder":
        """Configure the OpenAI-compatible LLM."""
        self._config.llm_config = LLMConfig(
            api_key=api_key,
            model=model,
            base_url=base_url,
            timeout=timeout,
        )
        return self

    def set_llm_provider(self, provider: Any) -> "AgentBuilder":
        """Provide a custom ``LLMProvider`` instance directly."""
        self._config.llm = provider
        return self

    # ---- System prompt ----

    def set_system_prompt(self, prompt: str) -> "AgentBuilder":
        """Set the base system prompt the agent uses."""
        self._config.system_prompt = prompt
        return self

    # ---- Tools ----

    def add_tool(
        self,
        name: str,
        description: str,
        execute: Callable[[Dict[str, Any]], str],
        parameters: Optional[Dict[str, Any]] = None,
        required: Optional[List[str]] = None,
        requires_approval: bool = False,
    ) -> "AgentBuilder":
        """Add a single user-defined tool."""
        self._config.tools.append(
            ToolDefinition(
                name=name,
                description=description,
                parameters=parameters or {},
                required=required or [],
                execute=execute,
                requires_approval=requires_approval,
            )
        )
        return self

    def add_tool_def(self, tool: ToolDefinition) -> "AgentBuilder":
        """Add a pre-built ``ToolDefinition``."""
        self._config.tools.append(tool)
        return self

    def add_tools(self, tools: List[ToolDefinition]) -> "AgentBuilder":
        """Add multiple tools at once."""
        self._config.tools.extend(tools)
        return self

    def set_include_builtin_tools(self, include: bool) -> "AgentBuilder":
        """Whether to include built-in tools (bash, read_file, etc.). Default: True."""
        self._config.include_builtin_tools = include
        return self

    # ---- Skills ----

    def add_skill(
        self,
        name: str,
        description: str,
        body: str,
    ) -> "AgentBuilder":
        """Add a single skill."""
        self._config.skills.append(
            SkillDefinition(name=name, description=description, body=body)
        )
        return self

    def add_skill_def(self, skill: SkillDefinition) -> "AgentBuilder":
        """Add a pre-built ``SkillDefinition``."""
        self._config.skills.append(skill)
        return self

    def add_skills(self, skills: List[SkillDefinition]) -> "AgentBuilder":
        """Add multiple skills at once."""
        self._config.skills.extend(skills)
        return self

    # ---- Storage ----

    def set_storage(
        self,
        backend: str = "file",
        dir: Optional[str] = None,
        bucket: Optional[str] = None,
        endpoint: Optional[str] = None,
        region: Optional[str] = None,
    ) -> "AgentBuilder":
        """Configure storage backend."""
        self._config.storage = StorageConfig(
            backend=backend,
            dir=dir,
            bucket=bucket,
            endpoint=endpoint,
            region=region,
        )
        return self

    # ---- Feature toggles ----

    def enable_memory(self, enable: bool = True) -> "AgentBuilder":
        """Enable long-term memory (episodic + semantic)."""
        self._config.enable_memory = enable
        return self

    def enable_streaming(self, enable: bool = True) -> "AgentBuilder":
        """Enable streaming responses by default."""
        self._config.enable_streaming = enable
        return self

    def enable_context(self, enable: bool = True) -> "AgentBuilder":
        """Enable context management (token budgeting, history trimming)."""
        self._config.enable_context = enable
        return self

    def set_max_tool_rounds(self, max_rounds: int) -> "AgentBuilder":
        """Max tool rounds per turn (safety limit)."""
        self._config.max_tool_rounds = max(1, min(max_rounds, 100))
        return self

    def set_approval_callback(
        self, callback: Callable[[str, Dict[str, Any]], bool]
    ) -> "AgentBuilder":
        """Set approval callback for mutating tools."""
        self._config.approval_callback = callback
        return self

    # ---- Sandbox ----

    def set_sandbox(
        self,
        allowed_paths: Optional[List[str]] = None,
        denied_paths: Optional[List[str]] = None,
        blocked_commands: Optional[List[str]] = None,
        blocked_patterns: Optional[List[str]] = None,
        allowed_commands: Optional[List[str]] = None,
        max_execution_secs: float = 30.0,
        max_output_chars: int = 50_000,
        allow_network: bool = True,
        allow_env_passthrough: bool = False,
        on_violation: str = "error",
    ) -> "AgentBuilder":
        """Configure the execution sandbox."""
        from sandbox import SandboxConfig

        self._config.sandbox = SandboxConfig(
            enabled=True,
            allowed_paths=allowed_paths or [__import__("os").getcwd()],
            denied_paths=denied_paths or [],
            blocked_commands=blocked_commands or [],
            blocked_patterns=blocked_patterns or [],
            allowed_commands=allowed_commands,
            max_execution_secs=max_execution_secs,
            max_output_chars=max_output_chars,
            allow_network=allow_network,
            allow_env_passthrough=allow_env_passthrough,
            on_violation=on_violation,
        )
        return self

    # ---- Build ----

    def build(self) -> "AgentInstance":
        """Validate config and build the agent instance."""
        from agent_instance import AgentInstance

        # Resolve LLM provider
        if self._config.llm is None:
            cfg = self._config.llm_config
            if cfg is None or not cfg.api_key:
                raise ValueError(
                    "AgentBuilder: must call .set_llm(api_key=...) or "
                    ".set_llm_provider() before .build()"
                )
            from llm_protocol import OpenAIProvider

            self._config.llm = OpenAIProvider(
                api_key=cfg.api_key,
                model=cfg.model,
                base_url=cfg.base_url,
                timeout=cfg.timeout,
            )

        return AgentInstance(self._config)
