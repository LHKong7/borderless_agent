"""
agent_instance.py — Runtime agent returned by AgentBuilder.build().

Provides: chat(), stream(), create_session(), restore_session().
All internal modules are wired through dependency injection — no globals.
Mirrors the TypeScript agentInstance.ts.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, Callable, Dict, Generator, List, Optional, Tuple

from agent_types import (
    AgentConfig,
    ChatResult,
    SkillDefinition,
    StreamChunk,
    ToolDefinition,
    AutonomousTaskConfig,
    AutonomousTaskResult,
)
from llm_protocol import LLMProvider, LLMResponse
from session_core import Session, SessionManager
from context_core import (
    assemble_system,
    fold_observation,
    get_budget,
    sanitize_user_input,
    select_history,
)
from memory_core import consolidate_turn, retrieve
from sandbox import Sandbox


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _tool_defs_to_openai(tools: List[ToolDefinition]) -> List[Dict[str, Any]]:
    """Convert ToolDefinition list → OpenAI function-calling format."""
    result = []
    for t in tools:
        result.append({
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": {
                    "type": "object",
                    "properties": t.parameters or {},
                    "required": t.required or [],
                },
            },
        })
    return result


def _skill_descriptions(skills: List[SkillDefinition]) -> str:
    if not skills:
        return ""
    lines = [f"- {s.name}: {s.description}" for s in skills]
    return "\n\n**Available skills** (use the `Skill` tool to load one):\n" + "\n".join(lines)


def _build_skill_tool(skills: List[SkillDefinition]) -> Optional[ToolDefinition]:
    """Build the meta Skill tool for user-defined skills."""
    if not skills:
        return None
    loaded: set = set()

    def execute(args: Dict[str, Any]) -> str:
        name = args.get("skill", "")
        if name in loaded:
            return f"(Skill '{name}' already loaded. Use the knowledge above.)"
        skill = next((s for s in skills if s.name == name), None)
        if not skill:
            avail = ", ".join(s.name for s in skills)
            return f"Error: Unknown skill '{name}'. Available: {avail}"
        loaded.add(name)
        return (
            f'<skill-loaded name="{name}">\n'
            f"# Skill: {skill.name}\n\n{skill.body}\n"
            f"</skill-loaded>\n\n"
            "Use the knowledge above to complete the user's task. "
            "Do NOT call Skill again."
        )

    return ToolDefinition(
        name="Skill",
        description=(
            "Load a skill for specialized knowledge.\nAvailable:\n"
            + "\n".join(f"- {s.name}: {s.description}" for s in skills)
        ),
        parameters={"skill": {"type": "string", "description": "Skill name to load"}},
        required=["skill"],
        execute=execute,
    )


def _get_builtin_tool_defs() -> List[ToolDefinition]:
    """Return built-in tool definitions wrapping the existing tools_core functions."""
    from tools_core import (
        run_bash,
        run_read,
        run_grep,
        run_write,
        run_edit,
        run_todo,
        run_web_search,
        run_web_fetch,
    )

    return [
        ToolDefinition(
            name="bash",
            description="Run a shell command.",
            parameters={"command": {"type": "string"}},
            required=["command"],
            execute=lambda args: run_bash(args.get("command", "")),
        ),
        ToolDefinition(
            name="read_file",
            description="Read file with pagination (offset/limit).",
            parameters={
                "path": {"type": "string"},
                "offset": {"type": "integer", "description": "0-based start line"},
                "limit": {"type": "integer", "description": "Max lines"},
            },
            required=["path"],
            execute=lambda args: run_read(
                args.get("path", ""),
                offset=args.get("offset", 0),
                limit=args.get("limit"),
            ),
        ),
        ToolDefinition(
            name="grep",
            description="Search for pattern in file.",
            parameters={
                "path": {"type": "string"},
                "pattern": {"type": "string"},
                "context_before": {"type": "integer"},
                "context_after": {"type": "integer"},
            },
            required=["path", "pattern"],
            execute=lambda args: run_grep(
                args.get("path", ""),
                args.get("pattern", ""),
                context_before=args.get("context_before", 0),
                context_after=args.get("context_after", 0),
            ),
        ),
        ToolDefinition(
            name="write_file",
            description="Write content to file (creates backup).",
            parameters={
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            required=["path", "content"],
            requires_approval=True,
            execute=lambda args: run_write(args.get("path", ""), args.get("content", "")),
        ),
        ToolDefinition(
            name="edit_file",
            description="Replace text in file.",
            parameters={
                "path": {"type": "string"},
                "old_text": {"type": "string"},
                "new_text": {"type": "string"},
            },
            required=["path", "old_text", "new_text"],
            requires_approval=True,
            execute=lambda args: run_edit(
                args.get("path", ""),
                args.get("old_text", ""),
                args.get("new_text", ""),
            ),
        ),
        ToolDefinition(
            name="TodoWrite",
            description="Update task list.",
            parameters={
                "items": {"type": "array", "description": "Array of {content, status, activeForm}"},
            },
            required=["items"],
            execute=lambda args: run_todo(args.get("items", [])),
        ),
        ToolDefinition(
            name="WebSearch",
            description="Search the web for current information. Returns formatted search results with titles, URLs, and snippets.",
            parameters={
                "query": {"type": "string", "description": "The search query"},
                "allowed_domains": {"type": "array", "description": "Only include results from these domains"},
                "blocked_domains": {"type": "array", "description": "Exclude results from these domains"},
            },
            required=["query"],
            permission_level="dangerous",
            execute=lambda args: run_web_search(
                args.get("query", ""),
                args.get("allowed_domains"),
                args.get("blocked_domains"),
            ),
        ),
        ToolDefinition(
            name="WebFetch",
            description="Fetch content from a URL and return as plain text. HTML is stripped to text automatically.",
            parameters={
                "url": {"type": "string", "description": "The URL to fetch"},
                "prompt": {"type": "string", "description": "Instructions for processing the fetched content"},
            },
            required=["url", "prompt"],
            permission_level="dangerous",
            execute=lambda args: run_web_fetch(args.get("url", ""), args.get("prompt", "")),
        ),
    ]


def _tool_calls_from_response(response: LLMResponse) -> List[Dict[str, Any]]:
    """Extract tool calls into a standard shape."""
    result = []
    for tc in (response.tool_calls or []):
        result.append({
            "id": tc.id,
            "type": "function",
            "function": {
                "name": tc.name,
                "arguments": json.dumps(tc.arguments) if isinstance(tc.arguments, dict) else str(tc.arguments),
            },
        })
    return result


# ---------------------------------------------------------------------------
# Session wrapper
# ---------------------------------------------------------------------------

class _SessionHandle:
    """Concrete session handle returned by create_session / restore_session."""

    def __init__(self, session: Session, agent: "AgentInstance", mgr: SessionManager):
        self._session = session
        self._agent = agent
        self._mgr = mgr

    @property
    def id(self) -> str:
        return self._session.id

    def chat(self, message: str) -> ChatResult:
        result = self._agent._run_loop(message, self._session.history)
        self._session.history = result.history
        self._session.updated_at = time.time()
        self._mgr.save_session(self._session)
        return ChatResult(
            reply=result.reply,
            history=result.history,
            had_tool_calls=result.had_tool_calls,
            session_id=self._session.id,
        )

    def stream(self, message: str) -> Generator[StreamChunk, None, None]:
        for chunk in self._agent._run_loop_stream(message, self._session.history):
            yield chunk
        # Sync after streaming completes
        self._session.updated_at = time.time()
        self._mgr.save_session(self._session)

    def get_history(self) -> List[Dict[str, Any]]:
        return list(self._session.history)

    def save(self) -> None:
        self._mgr.save_session(self._session)


# ---------------------------------------------------------------------------
# AgentInstance
# ---------------------------------------------------------------------------

class AgentInstance:
    """Runtime agent created by ``AgentBuilder.build()``."""

    def __init__(self, config: AgentConfig) -> None:
        self._llm: LLMProvider = config.llm
        self._max_tool_rounds = config.max_tool_rounds
        self._memory_enabled = config.enable_memory
        self._streaming_enabled = config.enable_streaming
        self._context_enabled = config.enable_context
        self._approval_callback = config.approval_callback

        # Sandbox
        self._sandbox = Sandbox(config.sandbox)

        # Assemble tools
        self._tools: List[ToolDefinition] = []
        if config.include_builtin_tools:
            self._tools.extend(_get_builtin_tool_defs())
        self._tools.extend(config.tools)

        # Skills
        self._skills = list(config.skills)
        skill_tool = _build_skill_tool(self._skills)
        if skill_tool:
            self._tools.append(skill_tool)

        # Build lookup and OpenAI format
        self._tool_map: Dict[str, ToolDefinition] = {t.name: t for t in self._tools}
        self._openai_tools = _tool_defs_to_openai(self._tools)

        # System prompt
        self._system_prompt = (
            config.system_prompt
            or "You are a helpful assistant. Use the provided tools when needed."
        )
        if self._skills:
            self._system_prompt += _skill_descriptions(self._skills)

        # Storage & session manager
        store = None
        if config.storage:
            if config.storage.backend == "file":
                from storage.file_backend import create_file_backend

                backend = create_file_backend(
                    session_dir=config.storage.dir,
                )
                store = backend.session_store
        self._session_mgr = SessionManager(store=store)

        # MCP servers (connected lazily on first _run_loop call)
        self._mcp_configs = config.mcp_servers or []
        self._mcp_manager = None
        self._mcp_initialized = False

    # ---- Public API ----

    def chat(
        self,
        message: str,
        history: Optional[List[Dict[str, Any]]] = None,
    ) -> ChatResult:
        """Send a single message (stateless, no session)."""
        hist = list(history) if history else []
        return self._run_loop(message, hist)

    def stream(
        self,
        message: str,
        history: Optional[List[Dict[str, Any]]] = None,
    ) -> Generator[StreamChunk, None, None]:
        """Stream a single message (stateless, no session)."""
        hist = list(history) if history else []
        yield from self._run_loop_stream(message, hist)

    def create_session(self) -> _SessionHandle:
        """Create a new session (persisted, maintains conversation history)."""
        session = self._session_mgr.create_session(context={})
        return _SessionHandle(session, self, self._session_mgr)

    def restore_session(self, session_id: str) -> Optional[_SessionHandle]:
        """Restore a previously saved session by ID."""
        session = self._session_mgr.restore_session(session_id)
        if not session:
            return None
        return _SessionHandle(session, self, self._session_mgr)

    def list_sessions(self) -> List[str]:
        """List saved session IDs."""
        return self._session_mgr.list_session_ids()

    def list_session_summaries(self, limit: int = 20) -> List[Dict[str, Any]]:
        """List saved session summaries."""
        return self._session_mgr.list_sessions_summary(limit)

    @property
    def llm(self) -> LLMProvider:
        return self._llm

    @property
    def tools(self) -> List[ToolDefinition]:
        return list(self._tools)

    async def run_task(self, config: AutonomousTaskConfig) -> AutonomousTaskResult:
        """Run an autonomous task loop.

        The agent iterates through plan → execute → review → evaluate phases
        until self-evaluation meets the quality threshold or max iterations.
        """
        from autonomous_loop import AutonomousLoop
        loop = AutonomousLoop(self)
        return await loop.run(config)

    def _init_mcp(self) -> None:
        """Initialize MCP server connections (called lazily on first use)."""
        if self._mcp_initialized or not self._mcp_configs:
            return

        from mcp_client import MCPManager

        self._mcp_manager = MCPManager()
        self._mcp_manager.connect(self._mcp_configs)

        # Merge MCP tools into the agent's tool list
        mcp_defs = self._mcp_manager.get_tool_definitions()
        for mcp_tool in mcp_defs:
            self._openai_tools.append({
                "type": "function",
                "function": {
                    "name": mcp_tool["name"],
                    "description": mcp_tool["description"],
                    "parameters": mcp_tool["input_schema"],
                },
            })
        self._mcp_initialized = True

    def close(self) -> None:
        """Gracefully shut down MCP server connections."""
        if self._mcp_manager:
            self._mcp_manager.close()
            self._mcp_manager = None
            self._mcp_initialized = False

    # ---- Internal ----

    def _execute_tool(self, name: str, args: Dict[str, Any]) -> str:
        # Route MCP tools to MCPManager
        if self._mcp_manager and self._mcp_manager.is_mcp_tool(name):
            return self._mcp_manager.call_tool(name, args)

        tool = self._tool_map.get(name)
        if not tool:
            return f"Unknown tool: {name}"

        # Sandbox permission check (handles file guards, command analysis, etc.)
        decision = self._sandbox.check_permission(name, args)

        if decision.behavior == 'deny':
            return decision.message or 'Operation blocked by sandbox'

        if decision.behavior == 'ask':
            # If approval callback is set, delegate to it
            if self._approval_callback:
                approved = self._approval_callback(name, args)
                if not approved:
                    return 'Action not approved by user.'
            else:
                # No callback and sandbox says ask — deny by default
                return decision.message or 'Operation requires confirmation but no approval callback set'

        # Legacy requires_approval check (for user-defined tools)
        if tool.requires_approval and self._approval_callback and decision.behavior == 'allow':
            approved = self._approval_callback(name, args)
            if not approved:
                return 'Action not approved by user.'

        # Execute with sandbox timeout & output limits
        return self._sandbox.wrap_execution(lambda: tool.execute(args))

    def _build_system_for_turn(self, user_input: str) -> str:
        if not self._context_enabled:
            return self._system_prompt

        rag_lines: Optional[List[str]] = None
        if self._memory_enabled:
            memories = retrieve(user_input, k=5)
            rag_lines = [m[0] for m in memories if m[0]]

        return assemble_system(
            base_system=self._system_prompt,
            rag_lines=rag_lines if rag_lines else None,
        )

    def _run_loop(
        self,
        user_input: str,
        history: List[Dict[str, Any]],
    ) -> ChatResult:
        self._init_mcp()
        sanitized = sanitize_user_input(user_input)
        message = sanitized[0] if isinstance(sanitized, tuple) else sanitized

        system = self._build_system_for_turn(message)

        working = list(history)
        if self._context_enabled:
            budget = get_budget()
            working = select_history(working, message, budget.get("history", 100_000))

        working.append({"role": "user", "content": message})

        api_messages: List[Dict[str, Any]] = [
            {"role": "system", "content": system},
            *working,
        ]

        tool_rounds = 0
        had_tool_calls = False

        while True:
            response = self._llm.chat(
                messages=api_messages,
                tools=self._openai_tools,
                max_tokens=8000,
                stream=False,
            )

            tcs = _tool_calls_from_response(response)
            content = response.content or ""

            if not tcs:
                working.append({"role": "assistant", "content": content.strip()})
                if self._memory_enabled:
                    consolidate_turn(message, content.strip())
                history.clear()
                history.extend(working)
                return ChatResult(
                    reply=content.strip(),
                    history=working,
                    had_tool_calls=had_tool_calls,
                )

            had_tool_calls = True
            tool_rounds += 1
            if tool_rounds >= self._max_tool_rounds:
                msg = "Stopped: reached tool-use safety limit. Please simplify your request."
                working.append({"role": "assistant", "content": msg})
                history.clear()
                history.extend(working)
                return ChatResult(reply=msg, history=working, had_tool_calls=had_tool_calls)

            # Execute tools
            results = []
            for tc in tcs:
                fn = tc.get("function", {})
                name = fn.get("name", "")
                try:
                    args = json.loads(fn.get("arguments", "{}"))
                except (json.JSONDecodeError, TypeError):
                    args = {}
                output = self._execute_tool(name, args)
                if self._context_enabled:
                    output = fold_observation(output)
                results.append({"tool_call_id": tc["id"], "content": output})

            api_messages.append({
                "role": "assistant",
                "content": content or "",
                "tool_calls": tcs,
            })
            working.append({
                "role": "assistant",
                "content": content or "",
                "tool_calls": tcs,
            })
            for r in results:
                api_messages.append({
                    "role": "tool",
                    "tool_call_id": r["tool_call_id"],
                    "content": r["content"],
                })
                working.append({
                    "role": "tool",
                    "tool_call_id": r["tool_call_id"],
                    "content": r["content"],
                })

    def _run_loop_stream(
        self,
        user_input: str,
        history: List[Dict[str, Any]],
    ) -> Generator[StreamChunk, None, None]:
        self._init_mcp()
        sanitized = sanitize_user_input(user_input)
        message = sanitized[0] if isinstance(sanitized, tuple) else sanitized

        system = self._build_system_for_turn(message)

        working = list(history)
        if self._context_enabled:
            budget = get_budget()
            working = select_history(working, message, budget.get("history", 100_000))

        working.append({"role": "user", "content": message})

        api_messages: List[Dict[str, Any]] = [
            {"role": "system", "content": system},
            *working,
        ]

        tool_rounds = 0
        had_tool_calls = False

        while True:
            stream = self._llm.chat(
                messages=api_messages,
                tools=self._openai_tools,
                max_tokens=8000,
                stream=True,
            )

            last_response = None
            for r in stream:
                if r.content and not (r.tool_calls):
                    yield StreamChunk(delta=r.content, done=False)
                last_response = r

            content = last_response.content if last_response else ""
            tcs = _tool_calls_from_response(last_response) if last_response else []

            if not tcs:
                working.append({"role": "assistant", "content": (content or "").strip()})
                if self._memory_enabled:
                    consolidate_turn(message, (content or "").strip())
                history.clear()
                history.extend(working)
                yield StreamChunk(reply=(content or "").strip(), done=True)
                return

            had_tool_calls = True
            tool_rounds += 1
            if tool_rounds >= self._max_tool_rounds:
                msg = "Stopped: reached tool-use safety limit."
                working.append({"role": "assistant", "content": msg})
                history.clear()
                history.extend(working)
                yield StreamChunk(reply=msg, done=True)
                return

            results = []
            for tc in tcs:
                fn = tc.get("function", {})
                name = fn.get("name", "")
                try:
                    args = json.loads(fn.get("arguments", "{}"))
                except (json.JSONDecodeError, TypeError):
                    args = {}
                output = self._execute_tool(name, args)
                if self._context_enabled:
                    output = fold_observation(output)
                results.append({"tool_call_id": tc["id"], "content": output})

            api_messages.append({
                "role": "assistant",
                "content": content or "",
                "tool_calls": tcs,
            })
            working.append({
                "role": "assistant",
                "content": content or "",
                "tool_calls": tcs,
            })
            for r in results:
                api_messages.append({
                    "role": "tool",
                    "tool_call_id": r["tool_call_id"],
                    "content": r["content"],
                })
                working.append({
                    "role": "tool",
                    "tool_call_id": r["tool_call_id"],
                    "content": r["content"],
                })
