"""
loop_core.py - Main agent loop and system prompt (OpenAI SDK).

Integrates long-term memory: optional retrieved_memories injected into system prompt,
and returns last assistant text for consolidation.
"""

import json
import logging
import time
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Tuple

from config import WORKDIR, MODEL, client, stream_enabled
from skills_core import SKILLS
from agents_core import get_agent_descriptions
from tools_core import ALL_TOOLS, MAX_TOOL_ROUNDS, execute_tool

logger = logging.getLogger("agent")
slog = logging.getLogger("agent.structured")


def _tools_to_openai(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert Anthropic-style tools (name, description, input_schema) to OpenAI function tools."""
    out = []
    for t in tools:
        out.append({
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t.get("input_schema", {"type": "object", "properties": {}}),
            },
        })
    return out

try:
    from context_core import fold_observation, context_enabled, compute_usage_stats
except ImportError:
    def fold_observation(x: str, _max: int = 3500) -> str:
        return x
    def context_enabled() -> bool:
        return False
    def compute_usage_stats(usage: Any, max_tokens: int) -> dict:
        return {}


def get_base_system() -> str:
    """System prompt without RAG/memory block (for context assembler)."""
    return f"""You are a general-purpose assistant. Your workspace is {WORKDIR}.

You can help with many kinds of tasks: answering questions, searching and reading files, writing or editing content, running commands, and using specialized knowledge via skills and subagents.

**Skills** (invoke with Skill tool when the task matches a domain):
{SKILLS.get_descriptions()}

**Subagents** (invoke with Task tool for focused subtasks—e.g. exploration vs. execution):
{get_agent_descriptions()}

Rules:
- Use Skill at most ONCE per request; after loading a skill, answer using that knowledge and do not call Skill again.
- Use Task when a subtask fits an Explorer (read-only) or Executor (write/run, with approval) agent.
- Use TodoWrite to track multi-step work.
- Prefer using tools when they help; otherwise respond clearly in natural language.
- Be concise and helpful. If you take actions, briefly say what you did."""


def _build_system(retrieved_memories: Optional[List[str]] = None) -> str:
    base = get_base_system()
    if retrieved_memories:
        memory_block = "**Relevant past context (long-term memory):**\n" + "\n".join(
            f"- {m}" for m in retrieved_memories
        )
        base = base + "\n\n" + memory_block
    return base


def _messages_to_openai(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert history to OpenAI API format: expand user messages with tool_result list into role 'tool' messages."""
    out: List[Dict[str, Any]] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role == "user" and isinstance(content, list):
            # Legacy: list of {type: "tool_result", tool_call_id, content} -> one "tool" message per item
            if content and isinstance(content[0], dict) and content[0].get("type") == "tool_result":
                for r in content:
                    out.append({
                        "role": "tool",
                        "tool_call_id": r.get("tool_call_id", ""),
                        "content": r.get("content", ""),
                    })
                continue
        out.append(dict(m))
    return out


def _last_assistant_text(messages: List[Dict[str, Any]]) -> str:
    """Extract final assistant text from last message (for consolidation)."""
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    return (block.get("text") or "").strip()
    return ""


def _usage_dict(response: Any) -> Optional[Dict[str, Any]]:
    """Build usage dict from OpenAI response for compute_usage_stats."""
    u = getattr(response, "usage", None)
    if u is None:
        return None
    return {
        "input_tokens": getattr(u, "input_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(u, "cache_creation_input_tokens", 0) or 0,
        "cache_read_input_tokens": getattr(u, "cache_read_input_tokens", 0) or 0,
        "output_tokens": getattr(u, "output_tokens", 0) or 0,
    }


def _stream_to_message(
    stream: Any,
    budget: Optional[Dict[str, int]],
    sid_tag: str,
    on_content_delta: Optional[Callable[[str], None]] = None,
):
    """
    Consume OpenAI stream: optionally call on_content_delta for each content chunk,
    accumulate content and tool_calls. Returns (content: str, tool_calls: list, usage: dict or None).
    """
    content_parts: List[str] = []
    tool_calls_accum: List[Dict[str, Any]] = []
    usage = None

    for chunk in stream:
        if not getattr(chunk, "choices", None) or len(chunk.choices) == 0:
            if getattr(chunk, "usage", None):
                usage = _usage_dict(chunk)
            continue
        choice = chunk.choices[0]
        delta = getattr(choice, "delta", None)
        if delta is None:
            continue
        # Content
        part = getattr(delta, "content", None)
        if part:
            content_parts.append(part)
            if on_content_delta is not None:
                on_content_delta(part)
            else:
                print(part, end="", flush=True)
        # Tool calls (streamed by index; merge by index)
        tc_deltas = getattr(delta, "tool_calls", None) or []
        for tc in tc_deltas:
            idx = getattr(tc, "index", None)
            if idx is None:
                continue
            while len(tool_calls_accum) <= idx:
                tool_calls_accum.append({"id": "", "name": "", "arguments": ""})
            acc = tool_calls_accum[idx]
            if getattr(tc, "id", None):
                acc["id"] = tc.id
            fn = getattr(tc, "function", None)
            if fn is not None:
                n = getattr(fn, "name", None) or (fn.get("name") if isinstance(fn, dict) else None)
                if n:
                    acc["name"] = n
                a = getattr(fn, "arguments", None) or (fn.get("arguments") if isinstance(fn, dict) else None)
                if a:
                    acc["arguments"] = acc.get("arguments", "") + a
        if getattr(chunk, "usage", None):
            usage = _usage_dict(chunk)

    content = "".join(content_parts)
    if content and on_content_delta is None:
        print(flush=True)  # newline after streamed content
    tool_calls_out: List[Any] = []
    for acc in tool_calls_accum:
        if acc.get("id") or acc.get("name") or acc.get("arguments"):
            tc = SimpleNamespace(
                id=acc.get("id", ""),
                function=SimpleNamespace(name=acc.get("name", ""), arguments=acc.get("arguments", "")),
            )
            tool_calls_out.append(tc)
    return content, tool_calls_out, usage


def agent_loop(
    messages: List[Dict[str, Any]],
    retrieved_memories: Optional[List[str]] = None,
    system_override: Optional[str] = None,
    budget: Optional[Dict[str, int]] = None,
    session_id: str = "",
    on_content_delta: Optional[Callable[[str], None]] = None,
) -> Tuple[List[Dict[str, Any]], str, bool]:
    """
    Main agent loop with skills support (OpenAI chat completions + tool calls).

    Includes a safety limit on tool rounds to avoid infinite loops.
    Returns (updated messages, last_assistant_text, had_tool_calls).
    """
    loop_start = time.monotonic()
    tool_rounds = 0
    had_tool_calls = False
    total_tool_count = 0
    system = system_override if system_override else _build_system(retrieved_memories)
    openai_tools = _tools_to_openai(ALL_TOOLS)
    api_messages: List[Dict[str, Any]] = [{"role": "system", "content": system}] + _messages_to_openai(messages)

    sid_tag = session_id[:8] if session_id else "-"
    slog.debug("agent_loop start session=%s rounds_limit=%s", sid_tag, MAX_TOOL_ROUNDS)

    while True:
        req_start = time.monotonic()
        use_stream = stream_enabled() or (on_content_delta is not None)
        if use_stream:
            stream = client.chat.completions.create(
                model=MODEL,
                messages=api_messages,
                tools=openai_tools,
                tool_choice="auto",
                max_tokens=8000,
                stream=True,
            )
            req_ms = int((time.monotonic() - req_start) * 1000)
            slog.debug("api_call session=%s duration_ms=%s (stream)", sid_tag, req_ms)
            content, tool_calls, usage = _stream_to_message(
                stream, budget, sid_tag, on_content_delta=on_content_delta
            )
            req_ms = int((time.monotonic() - req_start) * 1000)
            slog.debug("api_call session=%s duration_ms=%s", sid_tag, req_ms)
            # Synthesize message for rest of loop
            msg = SimpleNamespace(content=content, tool_calls=tool_calls if tool_calls else None)
        else:
            response = client.chat.completions.create(
                model=MODEL,
                messages=api_messages,
                tools=openai_tools,
                tool_choice="auto",
                max_tokens=8000,
            )
            req_ms = int((time.monotonic() - req_start) * 1000)
            slog.debug("api_call session=%s duration_ms=%s", sid_tag, req_ms)
            msg = response.choices[0].message
            tool_calls = list(msg.tool_calls) if msg.tool_calls else []
            usage = _usage_dict(response)

        # Token usage visibility (streaming may not have usage in all backends)
        if usage and (usage.get("input_tokens") or usage.get("output_tokens")):
            inp = usage.get("input_tokens", 0) + usage.get("cache_creation_input_tokens", 0) + usage.get("cache_read_input_tokens", 0)
            out = usage.get("output_tokens", 0)
            if budget and budget.get("total"):
                stats = compute_usage_stats(usage, budget["total"])
                if stats.get("used") is not None:
                    logger.info("  [Tokens: in %s out %s (%s%% of budget)]", inp, out, stats["used"])
                else:
                    logger.info("  [Tokens: in %s out %s]", inp, out)
            else:
                logger.info("  [Tokens: in %s out %s]", inp, out)

        if msg.content and not stream_enabled():
            print(msg.content)

        tool_calls = list(msg.tool_calls) if msg.tool_calls else []
        if not tool_calls:
            messages.append({"role": "assistant", "content": (msg.content or "").strip()})
            total_ms = int((time.monotonic() - loop_start) * 1000)
            slog.debug("agent_loop end session=%s duration_ms=%s rounds=%s tools=%s", sid_tag, total_ms, tool_rounds, total_tool_count)
            return messages, (msg.content or "").strip(), had_tool_calls

        had_tool_calls = True
        tool_rounds += 1
        if tool_rounds >= MAX_TOOL_ROUNDS:
            logger.warning("[agent] Reached tool-use limit, stopping further tool calls.")
            messages.append({
                "role": "assistant",
                "content": "Stopped tool calls due to safety limit. Please rephrase or narrow your request if you still need help.",
            })
            total_ms = int((time.monotonic() - loop_start) * 1000)
            slog.debug("agent_loop end session=%s duration_ms=%s rounds=%s tools=%s (limit hit)", sid_tag, total_ms, tool_rounds, total_tool_count)
            return messages, _last_assistant_text(messages), had_tool_calls

        # Build tool_calls in OpenAI format for next request
        assistant_tool_calls = [
            {"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
            for tc in tool_calls
        ]
        results: List[Dict[str, Any]] = []
        for tc in tool_calls:
            total_tool_count += 1
            name = tc.function.name
            try:
                args = json.loads(tc.function.arguments) if tc.function.arguments else {}
            except json.JSONDecodeError:
                args = {}
            if name == "Task":
                logger.info("> Task: %s", args.get("description", "subtask"))
            elif name == "Skill":
                logger.info("> Loading skill: %s", args.get("skill", "?"))
            else:
                logger.info("> %s", name)

            output = execute_tool(name, args)
            if context_enabled():
                output = fold_observation(output)

            if name == "Skill":
                logger.info("  Skill loaded (%s chars)", len(output))
            elif name != "Task":
                preview = output[:200] + "..." if len(output) > 200 else output
                logger.info("  %s", preview)

            results.append({"type": "tool_result", "tool_call_id": tc.id, "content": output})

        # Append assistant message (with tool_calls) and tool result messages (OpenAI format: role "tool")
        api_messages.append({
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": assistant_tool_calls,
        })
        for r in results:
            api_messages.append({
                "role": "tool",
                "tool_call_id": r["tool_call_id"],
                "content": r["content"],
            })
        # Keep local messages in sync for memory (same format so history is API-compatible)
        messages.append({
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": assistant_tool_calls,
        })
        for r in results:
            messages.append({
                "role": "tool",
                "tool_call_id": r["tool_call_id"],
                "content": r["content"],
            })

