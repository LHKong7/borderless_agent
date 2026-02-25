"""
tools_core.py - Tool definitions and implementations (bash, file ops, skills, tasks).

Read: pagination (offset/limit) and chunked read for large files.
Grep: context lines (before/after) around matches.
Write: atomic write + backup before overwrite (rollback-friendly).
"""

import json
import logging
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from config import WORKDIR, MODEL, client

# Mid-term memory: optional callback when a file is read (session recent_files tracking)
_file_access_callback: Optional[Callable[[str], None]] = None


def set_file_access_callback(cb: Optional[Callable[[str], None]]) -> None:
    """Set callback invoked when read_file is used (e.g. SessionManager.record_file_access)."""
    global _file_access_callback
    _file_access_callback = cb

logger = logging.getLogger("agent")
from skills_core import SKILLS
from todo_core import TODO
from agents_core import AGENT_TYPES, EXECUTOR_MUTATING_TOOLS


def _tools_to_openai(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert tools (name, description, input_schema) to OpenAI function tools."""
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


BASE_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "bash",
        "description": "Run shell command.",
        "input_schema": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    },
    {
        "name": "read_file",
        "description": "Read file contents with pagination. Use offset/limit for large files to avoid token overflow.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "offset": {"type": "integer", "description": "Line number to start from (0-based). Default 0."},
                "limit": {"type": "integer", "description": "Max lines to return. Default 500. Omit for first page only."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "grep",
        "description": "Search for pattern in file; show matching lines with optional context (lines before/after).",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "pattern": {"type": "string"},
                "context_before": {"type": "integer", "description": "Lines to show before each match. Default 0."},
                "context_after": {"type": "integer", "description": "Lines to show after each match. Default 0."},
            },
            "required": ["path", "pattern"],
        },
    },
    {
        "name": "write_file",
        "description": "Write to file. Creates backup of existing file before overwrite (rollback-friendly).",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "edit_file",
        "description": "Replace text in file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_text": {"type": "string"},
                "new_text": {"type": "string"},
            },
            "required": ["path", "old_text", "new_text"],
        },
    },
    {
        "name": "TodoWrite",
        "description": "Update task list.",
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string"},
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                            },
                            "activeForm": {"type": "string"},
                        },
                        "required": ["content", "status", "activeForm"],
                    },
                }
            },
            "required": ["items"],
        },
    },
    {
        "name": "search_knowledge_base",
        "description": "Query knowledge base (stub). Use for Explorer when user asks to look up docs or KB.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "read_email",
        "description": "Read emails (stub). Use for Explorer when user asks to check or read mail.",
        "input_schema": {
            "type": "object",
            "properties": {
                "folder": {"type": "string", "description": "Inbox, Sent, etc."},
                "limit": {"type": "integer"},
            },
            "required": [],
        },
    },
]

TASK_TOOL: Dict[str, Any] = {
    "name": "Task",
    "description": "Spawn a subagent for a focused subtask.\n\nAgent types:\n"
    + "\n".join(f"- {name}: {cfg['description']}" for name, cfg in AGENT_TYPES.items()),
    "input_schema": {
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "Short task description (3-5 words)",
            },
            "prompt": {
                "type": "string",
                "description": "Detailed instructions for the subagent",
            },
            "agent_type": {
                "type": "string",
                "enum": list(AGENT_TYPES.keys()),
            },
        },
        "required": ["description", "prompt", "agent_type"],
    },
}

SKILL_TOOL: Dict[str, Any] = {
    "name": "Skill",
    "description": f"""Load a skill to gain specialized knowledge for a task.

Available skills:
{SKILLS.get_descriptions()}

When to use:
- IMMEDIATELY when user task matches a skill description
- Before attempting domain-specific work (PDF, MCP, etc.)

The skill content will be injected into the conversation, giving you
detailed instructions and access to resources.""",
    "input_schema": {
        "type": "object",
        "properties": {
            "skill": {
                "type": "string",
                "description": "Name of the skill to load",
            }
        },
        "required": ["skill"],
    },
}

ALL_TOOLS: List[Dict[str, Any]] = BASE_TOOLS + [TASK_TOOL, SKILL_TOOL]

# Safety limit to prevent infinite tool-use loops
MAX_TOOL_ROUNDS = 20

# Track which skills have been loaded in the current top-level user interaction
LOADED_SKILLS: set[str] = set()

# Approval callback for Executor: (tool_name, tool_args) -> bool. Set to None to auto-approve (e.g. tests).
_executor_approval_callback = None


def set_executor_approval_callback(callback):
    """Set a (tool_name, tool_args) -> bool callback for Executor mutating actions. None = auto-approve."""
    global _executor_approval_callback
    _executor_approval_callback = callback


def _default_executor_approval(tool_name: str, tool_args: Dict[str, Any]) -> bool:
    """Default: print action and ask user y/n."""
    summary = f"[Executor] {tool_name}"
    if tool_name == "bash":
        summary += f": {tool_args.get('command', '')[:80]}"
    elif tool_name == "write_file":
        summary += f": write {tool_args.get('path', '')} ({len(tool_args.get('content', ''))} chars)"
    elif tool_name == "edit_file":
        summary += f": edit {tool_args.get('path', '')}"
    else:
        summary += f": {tool_args}"
    try:
        answer = input(f"\n{summary}\nApprove? (y/n): ").strip().lower()
        return answer in ("y", "yes")
    except (EOFError, KeyboardInterrupt):
        return False


def get_tools_for_agent(agent_type: str) -> list[Dict[str, Any]]:
    """Filter tools based on agent type."""
    allowed = AGENT_TYPES.get(agent_type, {}).get("tools", "*")
    if allowed == "*":
        return BASE_TOOLS
    return [t for t in BASE_TOOLS if t["name"] in allowed]


def safe_path(p: str) -> Path:
    """Ensure path stays within workspace."""
    path = (WORKDIR / p).resolve()
    if not path.is_relative_to(WORKDIR):
        raise ValueError(f"Path escapes workspace: {p}")
    return path


def run_bash(cmd: str) -> str:
    """Execute shell command."""
    if any(d in cmd for d in ["rm -rf /", "sudo", "shutdown"]):
        return "Error: Dangerous command"
    try:
        r = subprocess.run(
            cmd,
            shell=True,
            cwd=WORKDIR,
            capture_output=True,
            text=True,
            timeout=60,
        )
        return ((r.stdout + r.stderr).strip() or "(no output)")[:50000]
    except Exception as e:  # noqa: BLE001
        return f"Error: {e}"


# Default pagination: avoid loading huge files in one go
READ_DEFAULT_LIMIT = 500
READ_MAX_CHARS = 50_000


def run_read(path: str, offset: int = 0, limit: int | None = None) -> str:
    """
    Read file with pagination (offset/limit). Streams by line so large files
    don't load entirely into memory. Use for long docs (PDF text, logs, etc.).
    """
    try:
        fp = safe_path(path)
        if not fp.exists():
            return f"Error: File not found: {path}"
        if _file_access_callback is not None:
            try:
                _file_access_callback(path)
            except Exception:  # noqa: BLE001
                pass
        if limit is None:
            limit = READ_DEFAULT_LIMIT
        offset = max(0, offset)
        limit = max(1, min(limit, 2000))
        lines: List[str] = []
        with open(fp, "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i < offset:
                    continue
                if len(lines) >= limit:
                    # Don't scan rest of file; just hint next page
                    footer = f"\n[Lines {offset + 1}-{offset + len(lines)}; use offset={offset + limit} for next page]"
                    out = "\n".join(lines)
                    if len(out) > READ_MAX_CHARS:
                        out = out[:READ_MAX_CHARS] + "\n...[truncated]"
                    return out + footer
                lines.append(line.rstrip("\n"))
        out = "\n".join(lines)
        if len(out) > READ_MAX_CHARS:
            out = out[:READ_MAX_CHARS] + "\n...[truncated]"
        footer = f"\n[Lines {offset + 1}-{offset + len(lines)}]"
        return out + footer
    except Exception as e:  # noqa: BLE001
        return f"Error: {e}"


def run_grep(
    path: str,
    pattern: str,
    context_before: int = 0,
    context_after: int = 0,
) -> str:
    """Search file for pattern; return matching lines with optional context (lines before/after)."""
    try:
        fp = safe_path(path)
        if not fp.exists():
            return f"Error: File not found: {path}"
        context_before = max(0, min(context_before, 10))
        context_after = max(0, min(context_after, 10))
        try:
            pat = re.compile(pattern)
        except re.error:
            pat = re.compile(re.escape(pattern))
        lines = fp.read_text(encoding="utf-8", errors="replace").splitlines()
        results: List[str] = []
        i = 0
        while i < len(lines):
            if pat.search(lines[i]):
                start = max(0, i - context_before)
                end = min(len(lines), i + 1 + context_after)
                for j in range(start, end):
                    prefix = "  " if j != i else "> "
                    results.append(f"{prefix}{j + 1}: {lines[j]}")
                results.append("")  # blank between match groups
                i = end
            else:
                i += 1
        if not results:
            return f"No matches for pattern '{pattern[:60]}' in {path}"
        return ("\n".join(results).strip())[:READ_MAX_CHARS]
    except Exception as e:  # noqa: BLE001
        return f"Error: {e}"


def run_write(path: str, content: str) -> str:
    """
    Write content to file: backup existing file (for rollback), then atomic write
    (write to temp then rename so no partial state on disk).
    """
    try:
        fp = safe_path(path)
        fp.parent.mkdir(parents=True, exist_ok=True)
        did_backup = False
        if fp.exists():
            backup = fp.with_suffix(fp.suffix + ".bak")
            backup.write_bytes(fp.read_bytes())
            did_backup = True
        tmp = fp.with_suffix(fp.suffix + ".tmp")
        tmp.write_text(content)
        tmp.replace(fp)
        return f"Wrote {len(content)} bytes to {path}" + (
            f" (backup: {backup.name})" if did_backup else ""
        )
    except Exception as e:  # noqa: BLE001
        return f"Error: {e}"


def run_edit(path: str, old_text: str, new_text: str) -> str:
    """Replace exact text in file."""
    try:
        fp = safe_path(path)
        text = fp.read_text()
        if old_text not in text:
            return f"Error: Text not found in {path}"
        fp.write_text(text.replace(old_text, new_text, 1))
        return f"Edited {path}"
    except Exception as e:  # noqa: BLE001
        return f"Error: {e}"


def run_todo(items: list[Dict[str, Any]]) -> str:
    """Update the todo list."""
    try:
        return TODO.update(items)
    except Exception as e:  # noqa: BLE001
        return f"Error: {e}"


def run_search_knowledge_base(query: str) -> str:
    """Stub: knowledge base not connected. Explorer can use read_file/grep for local files."""
    return (
        "[Stub] Knowledge base is not connected. "
        "Use read_file and grep on local files under the workspace for retrieval."
    )


def run_read_email(folder: str = "Inbox", limit: int = 10) -> str:
    """Stub: email not connected. Explorer can use for future integration."""
    return (
        "[Stub] Email is not connected. "
        "When integrated, this would list emails from the specified folder."
    )


def run_skill(skill_name: str) -> str:
    """
    Load a skill and inject it into the conversation.

    First time in a turn:
      - Return full SKILL.md body wrapped in <skill-loaded> tags.
    Subsequent calls for the same skill in the same top-level interaction:
      - Return only a short reminder, to avoid repeatedly injecting large content.
    """
    # If we've already loaded this skill in the current user interaction,
    # avoid re-injecting the full content; just remind the model to answer.
    if skill_name in LOADED_SKILLS:
        return (
            f"(Skill '{skill_name}' is already loaded for this task. "
            "Use the previously loaded knowledge to answer the user directly, "
            "and do NOT call the Skill tool again.)"
        )

    LOADED_SKILLS.add(skill_name)

    content = SKILLS.get_skill_content(skill_name)

    if content is None:
        available = ", ".join(SKILLS.list_skills()) or "none"
        return f"Error: Unknown skill '{skill_name}'. Available: {available}"

    # Wrap in tags so model knows it's skill content
    return f"""<skill-loaded name="{skill_name}">
{content}
</skill-loaded>

You have now loaded this skill. Use the knowledge above to complete the user's task.
Do NOT call the Skill tool again for this task; respond with your full answer in natural language."""


def run_task(description: str, prompt: str, agent_type: str) -> str:
    """Execute a subagent task (OpenAI chat.completions + tool calls)."""
    if agent_type not in AGENT_TYPES:
        return f"Error: Unknown agent type '{agent_type}'"

    config = AGENT_TYPES[agent_type]
    sub_system = f"""You are a {agent_type} subagent at {WORKDIR}.

{config["prompt"]}

Complete the task and return a clear, concise summary."""

    sub_tools = get_tools_for_agent(agent_type)
    openai_tools = _tools_to_openai(sub_tools)
    api_messages: list[Dict[str, Any]] = [
        {"role": "system", "content": sub_system},
        {"role": "user", "content": prompt},
    ]

    logger.info("  [%s] %s", agent_type, description)
    start = time.time()
    tool_count = 0
    tool_rounds = 0
    last_text = "(subagent returned no text)"

    while True:
        response = client.chat.completions.create(
            model=MODEL,
            messages=api_messages,
            tools=openai_tools,
            tool_choice="auto",
            max_tokens=8000,
        )
        msg = response.choices[0].message
        tool_calls = list(msg.tool_calls) if msg.tool_calls else []

        # Subagent token usage
        u = getattr(response, "usage", None)
        if u and (getattr(u, "input_tokens", 0) or getattr(u, "output_tokens", 0)):
            inp = getattr(u, "input_tokens", 0) or 0
            out = getattr(u, "output_tokens", 0) or 0
            logger.info("  [%s] Tokens: in %s out %s", agent_type, inp, out)

        if msg.content:
            last_text = (msg.content or "").strip()

        if not tool_calls:
            break

        tool_rounds += 1
        if tool_rounds >= MAX_TOOL_ROUNDS:
            logger.warning("  [%s] Reached tool-use limit, stopping tool calls.", agent_type)
            break

        assistant_tool_calls = [
            {"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
            for tc in tool_calls
        ]
        results: list[Dict[str, Any]] = []

        for tc in tool_calls:
            tool_count += 1
            name = tc.function.name
            try:
                args = json.loads(tc.function.arguments) if tc.function.arguments else {}
            except json.JSONDecodeError:
                args = {}
            if config.get("requires_approval") and name in EXECUTOR_MUTATING_TOOLS:
                ask = _executor_approval_callback or _default_executor_approval
                if not ask(name, args):
                    output = "Action not approved by user."
                else:
                    output = execute_tool(name, args)
            else:
                output = execute_tool(name, args)
            results.append({"type": "tool_result", "tool_call_id": tc.id, "content": output})

            elapsed = time.time() - start
            sys.stdout.write(f"\r  [{agent_type}] {description} ... {tool_count} tools, {elapsed:.1f}s")
            sys.stdout.flush()

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

    elapsed = time.time() - start
    logger.info("  [%s] %s - done (%s tools, %.1fs)", agent_type, description, tool_count, elapsed)
    return last_text


def execute_tool(name: str, args: Dict[str, Any]) -> str:
    """Dispatch tool call to implementation."""
    if name == "bash":
        return run_bash(args["command"])
    if name == "read_file":
        return run_read(
            args["path"],
            offset=args.get("offset", 0),
            limit=args.get("limit"),
        )
    if name == "grep":
        return run_grep(
            args["path"],
            args["pattern"],
            context_before=args.get("context_before", 0),
            context_after=args.get("context_after", 0),
        )
    if name == "write_file":
        return run_write(args["path"], args["content"])
    if name == "edit_file":
        return run_edit(args["path"], args["old_text"], args["new_text"])
    if name == "TodoWrite":
        return run_todo(args["items"])
    if name == "search_knowledge_base":
        return run_search_knowledge_base(args.get("query", ""))
    if name == "read_email":
        return run_read_email(
            folder=args.get("folder", "Inbox"),
            limit=args.get("limit", 10),
        )
    if name == "Task":
        return run_task(args["description"], args["prompt"], args["agent_type"])
    if name == "Skill":
        return run_skill(args["skill"])
    return f"Unknown tool: {name}"

