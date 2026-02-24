"""
agents_core.py - Agent type registry and descriptions.

Explorer (侦察兵): read-only, high concurrency. Executor (执行者): mutating, single-thread, requires approval.
"""

from typing import Dict, Any


# Tools that change state; Executor must get approval before running these
EXECUTOR_MUTATING_TOOLS = frozenset({"write_file", "edit_file", "bash"})


AGENT_TYPES: Dict[str, Dict[str, Any]] = {
    "explore": {
        "description": "Read-only agent for exploring code, finding files, searching",
        "tools": ["bash", "read_file"],
        "prompt": "You are an exploration agent. Search and analyze, but never modify files. Return a concise summary.",
    },
    "code": {
        "description": "Full agent for implementing features and fixing bugs",
        "tools": "*",
        "prompt": "You are a coding agent. Implement the requested changes efficiently.",
    },
    "plan": {
        "description": "Planning agent for designing implementation strategies",
        "tools": ["bash", "read_file"],
        "prompt": "You are a planning agent. Analyze the codebase and output a numbered implementation plan. Do NOT make changes.",
    },
    # Explorer Agent (侦察兵): retrieval only, no side effects, safe for high concurrency
    "explorer": {
        "description": "Explorer (侦察兵): Retrieve info, read emails, query knowledge base. No side effects, safe for high concurrency.",
        "tools": ["read_file", "grep", "Skill", "search_knowledge_base", "read_email"],
        "prompt": "You are an Explorer (侦察兵). Your job is to gather information only: search, read files, query knowledge base, read emails. Never modify files or run commands that change state. Return clear, concise findings.",
    },
    # Executor Agent (执行者): mutating actions, single-thread, requires approval per action
    "executor": {
        "description": "Executor (执行者): Buy tickets, post, transfer, write files. Single-thread; each mutating action requires user approval.",
        "tools": ["write_file", "edit_file", "bash", "TodoWrite"],
        "prompt": "You are an Executor (执行者). You perform concrete actions: write/edit files, run commands, update tasks. Each mutating action will be sent to the user for approval before execution. Propose one logical step at a time when possible.",
        "requires_approval": True,
    },
}


def get_agent_descriptions() -> str:
    """Generate agent type descriptions for system prompt."""
    return "\n".join(
        f"- {name}: {cfg['description']}" for name, cfg in AGENT_TYPES.items()
    )

