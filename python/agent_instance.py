"""
agent_instance.py — Runtime agent returned by AgentBuilder.build().

Provides: chat(), stream(), create_session(), restore_session().
All internal modules are wired through dependency injection — no globals.
Mirrors the TypeScript agentInstance.ts.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Callable, Dict, Generator, List, Optional, Tuple

logger = logging.getLogger("agent")

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
        # #3: save error handling — don't crash if save fails
        try:
            self._mgr.save_session(self._session)
        except Exception as e:
            logger.error("[SessionHandle] Failed to save session: %s", e)
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
        try:
            self._mgr.save_session(self._session)
        except Exception as e:
            logger.error("[SessionHandle] Failed to save session: %s", e)

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

        self._human_input_callback = config.human_input_callback

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

        # Human-in-the-loop tool
        self._tools.append(self._build_ask_user_tool())

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

        try:
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
        except Exception as e:
            # #23: MCP connection failure — continue without MCP tools
            logger.error("[AgentInstance] MCP connection failed, continuing without MCP tools: %s", e)
            self._mcp_manager = None
        self._mcp_initialized = True

    def close(self) -> None:
        """Gracefully shut down MCP server connections."""
        if self._mcp_manager:
            self._mcp_manager.close()
            self._mcp_manager = None
            self._mcp_initialized = False

    # ---- Human-in-the-loop ----

    def _build_ask_user_tool(self) -> ToolDefinition:
        """Build the ask_user tool for human-in-the-loop interaction."""
        agent = self

        def execute(args: Dict[str, Any]) -> str:
            question = args.get("question", "")
            if not agent._human_input_callback:
                return (
                    "[Human input not available] No human_input_callback is configured. "
                    "Proceed with your best judgment."
                )
            try:
                answer = agent._human_input_callback(question)
                return answer or "(User provided no response)"
            except Exception as e:
                return f"[Human input error] {e}"

        return ToolDefinition(
            name="ask_user",
            description=(
                "Ask the user a question and wait for their response. "
                "Use this when you need clarification, additional information, "
                "confirmation on an important decision, or when the task is ambiguous. "
                "Do NOT use this for trivial questions you can resolve yourself."
            ),
            parameters={
                "question": {
                    "type": "string",
                    "description": "The question to ask the user",
                },
            },
            required=["question"],
            execute=execute,
        )

    # ---- Internal ----

    def _execute_tool(self, name: str, args: Dict[str, Any]) -> str:
        # Route MCP tools to MCPManager (#12: MCP call try-catch)
        if self._mcp_manager and self._mcp_manager.is_mcp_tool(name):
            try:
                return self._mcp_manager.call_tool(name, args)
            except Exception as e:
                return f"[MCP tool error] {name}: {e}"

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

        # #4: Execute with try-catch to prevent loop crash
        try:
            return self._sandbox.wrap_execution(lambda: tool.execute(args))
        except Exception as e:
            return f"[Tool error] {name}: {e}"

    def _build_system_for_turn(self, user_input: str) -> str:
        if not self._context_enabled:
            return self._system_prompt

        rag_lines: Optional[List[str]] = None
        if self._memory_enabled:
            try:
                memories = retrieve(user_input, k=5)
                rag_lines = [m[0] for m in memories if m[0]]
            except Exception as e:
                # #7: memory retrieval failure — continue without memories
                logger.error("[AgentInstance] Memory retrieval failed, continuing without memories: %s", e)

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
            selected = select_history(working, message, budget.get("history", 100_000))
            # #16: guarantee at least last 2 messages if history exists
            working = selected if selected else (working[-2:] if len(working) >= 2 else list(working))

        working.append({"role": "user", "content": message})

        api_messages: List[Dict[str, Any]] = [
            {"role": "system", "content": system},
            *working,
        ]

        tool_rounds = 0
        had_tool_calls = False

        while True:
            # #1: LLM call with retry
            try:
                response = self._llm_call_with_retry(api_messages, stream=False)
            except Exception as e:
                err_msg = f"I encountered an error communicating with the AI model: {e}. Please try again."
                working.append({"role": "assistant", "content": err_msg})
                history.clear()
                history.extend(working)
                return ChatResult(reply=err_msg, history=working, had_tool_calls=had_tool_calls)

            tcs = _tool_calls_from_response(response)
            content = response.content or ""
            thinking = getattr(response, 'thinking', None)

            if not tcs:
                assistant_msg = {"role": "assistant", "content": content.strip()}
                if thinking:
                    assistant_msg["thinking"] = thinking
                working.append(assistant_msg)
                # #8: memory consolidation failure handling
                if self._memory_enabled:
                    try:
                        consolidate_turn(message, content.strip())
                    except Exception as e:
                        logger.error("[AgentInstance] consolidateTurn failed: %s", e)
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
                    # #15: inform LLM about parse failure instead of silent {}
                    results.append({
                        "tool_call_id": tc["id"],
                        "content": f'[Argument parse error] Could not parse arguments for tool "{name}". Raw: {fn.get("arguments", "")[:200]}',
                    })
                    continue
                output = self._execute_tool(name, args)
                if self._context_enabled:
                    output = fold_observation(output)
                results.append({"tool_call_id": tc["id"], "content": output})

            # Preserve thinking in tool-call assistant messages
            assistant_tool_msg = {
                "role": "assistant",
                "content": content or "",
                "tool_calls": tcs,
            }
            if thinking:
                assistant_tool_msg["thinking"] = thinking
            api_messages.append(assistant_tool_msg)
            working.append(dict(assistant_tool_msg))
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

    # #1/#5: LLM call with exponential backoff retry
    def _llm_call_with_retry(self, api_messages, stream=False, max_retries=3):
        RETRYABLE_CODES = {429, 500, 502, 503}
        for attempt in range(1, max_retries + 1):
            try:
                return self._llm.chat(
                    messages=api_messages,
                    tools=self._openai_tools,
                    max_tokens=8000,
                    stream=stream,
                )
            except Exception as e:
                status = getattr(e, 'status_code', None) or getattr(e, 'status', None)
                if status is None:
                    resp = getattr(e, 'response', None)
                    if resp is not None:
                        status = getattr(resp, 'status_code', None)
                retryable = status in RETRYABLE_CODES if status else False
                if attempt < max_retries and retryable:
                    time.sleep(2 ** (attempt - 1))
                    continue
                raise

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
            selected = select_history(working, message, budget.get("history", 100_000))
            # #16: guarantee at least last 2 messages
            working = selected if selected else (working[-2:] if len(working) >= 2 else list(working))

        working.append({"role": "user", "content": message})

        api_messages: List[Dict[str, Any]] = [
            {"role": "system", "content": system},
            *working,
        ]

        tool_rounds = 0
        had_tool_calls = False

        while True:
            # #1: LLM call with retry
            try:
                stream = self._llm_call_with_retry(api_messages, stream=True)
            except Exception as e:
                err_msg = f"I encountered an error communicating with the AI model: {e}. Please try again."
                working.append({"role": "assistant", "content": err_msg})
                history.clear()
                history.extend(working)
                yield StreamChunk(reply=err_msg, done=True)
                return

            last_response = None
            try:
                for r in stream:
                    if r.content and not (r.tool_calls):
                        yield StreamChunk(delta=r.content, done=False)
                    last_response = r
            except Exception as e:
                err_msg = f"Stream interrupted: {e}"
                working.append({"role": "assistant", "content": err_msg})
                history.clear()
                history.extend(working)
                yield StreamChunk(reply=err_msg, done=True)
                return

            content = last_response.content if last_response else ""
            thinking = getattr(last_response, 'thinking', None) if last_response else None
            tcs = _tool_calls_from_response(last_response) if last_response else []

            if not tcs:
                assistant_msg = {"role": "assistant", "content": (content or "").strip()}
                if thinking:
                    assistant_msg["thinking"] = thinking
                working.append(assistant_msg)
                # #8: memory consolidation failure handling
                if self._memory_enabled:
                    try:
                        consolidate_turn(message, (content or "").strip())
                    except Exception as e:
                        logger.error("[AgentInstance] consolidateTurn failed: %s", e)
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
                    # #15: inform LLM about parse failure
                    results.append({
                        "tool_call_id": tc["id"],
                        "content": f'[Argument parse error] Could not parse arguments for tool "{name}". Raw: {fn.get("arguments", "")[:200]}',
                    })
                    continue
                output = self._execute_tool(name, args)
                if self._context_enabled:
                    output = fold_observation(output)
                results.append({"tool_call_id": tc["id"], "content": output})

            assistant_tool_msg = {
                "role": "assistant",
                "content": content or "",
                "tool_calls": tcs,
            }
            if thinking:
                assistant_tool_msg["thinking"] = thinking
            api_messages.append(assistant_tool_msg)
            working.append(dict(assistant_tool_msg))
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
