#!/usr/bin/env python3
"""
CLI entry point for the general-purpose agent (REPL, session choice, run_turn).

Delegates to project root modules:
- config.py       : shared configuration
- session_core.py : SessionManager (session lifecycle, history, persistence)
- skills_core.py  : SkillLoader and SKILLS
- agents_core.py  : AGENT_TYPES
- tools_core.py   : tool definitions and implementations
- loop_core.py    : main agent loop
- memory_core.py  : long-term memory (retrieve, consolidate)
- context_core.py : context pipeline (budget, selector, assembler, injection defense)
"""

import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from config import WORKDIR, MODEL, setup_agent_logging
from session_core import SessionManager
from skills_core import SKILLS
from storage import get_storage_backend
from memory_core import set_memory_store
from agents_core import AGENT_TYPES
from tools_core import LOADED_SKILLS, set_file_access_callback
from loop_core import agent_loop, get_base_system
from memory_core import (
    retrieve,
    consolidate_turn,
    write_insight,
    load_user_preferences,
    load_project_knowledge,
)
from context_core import (
    get_budget,
    select_history,
    assemble_system,
    sanitize_user_input,
    LifecycleManager,
    summarize_rounds,
    context_enabled,
    reply_cache_enabled,
    get_cached_reply,
    set_cached_reply,
)

logger = logging.getLogger("agent")
slog = logging.getLogger("agent.structured")

# When context management is off, keep legacy sliding-window constant
try:
    from memory_core import MAX_HISTORY_TURNS
except ImportError:
    MAX_HISTORY_TURNS = 30


def _relative_time(ts: float) -> str:
    """Human-friendly relative time string (e.g. '2h ago')."""
    diff = time.time() - ts
    if diff < 60:
        return "just now"
    if diff < 3600:
        return f"{int(diff // 60)}m ago"
    if diff < 86400:
        return f"{int(diff // 3600)}h ago"
    days = int(diff // 86400)
    return f"{days}d ago"


def _choose_session(session_mgr: SessionManager) -> None:
    """Prompt for new, list, or restore session; set active session."""
    while True:
        try:
            choice = input("Start: [n]ew session, [l]ist sessions, [r]estore <id> (default n): ").strip().lower() or "n"
        except (EOFError, KeyboardInterrupt):
            choice = "n"
        if choice == "n":
            session_mgr.create_session(context={"started": True})
            return
        if choice == "l":
            summaries = session_mgr.list_sessions_summary(limit=20)
            if not summaries:
                print("  No saved sessions.")
            else:
                for s in summaries:
                    sid_short = s["id"][:8]
                    rel = _relative_time(s["updated_at"])
                    turns = s["turns"]
                    state = s["state"]
                    print(f"  {sid_short}  {rel:>10}  {turns} turns  [{state}]  {s['id']}")
            continue
        if choice.startswith("r "):
            sid = choice[2:].strip()
            if session_mgr.restore_session(sid):
                return
            print(f"  Session not found: {sid}")
            continue
        print("  Use n, l, or r <id>.")


def run_turn(
    user_input: str,
    history: List[Dict[str, Any]],
    session_mgr: SessionManager,
    lifecycle: LifecycleManager,
    budget: Dict[str, int],
    stream_callback: Optional[Any] = None,
) -> Tuple[List[Dict[str, Any]], str]:
    """
    Execute a single conversation turn. Callable from REPL, server, or scripts.

    Pipeline: sanitize -> topic shift -> retrieve -> select history -> reply cache
    -> assemble system -> agent_loop -> consolidate -> update session.

    Returns (updated history, last_assistant_text).
    """
    turn_start = time.monotonic()
    LOADED_SKILLS.clear()
    user_input, _ = sanitize_user_input(user_input)

    if context_enabled() and lifecycle.detect_topic_shift(user_input, history[-6:]):
        if history:
            summary = summarize_rounds(history)
            if summary:
                write_insight(summary, importance=0.5)
        history.clear()
        lifecycle.reset_session()

    memory_tuples = retrieve(user_input, k=5)
    rag_lines = [m[0] for m in memory_tuples if m[0]]

    if context_enabled():
        history = select_history(
            history, user_input,
            max_tokens=budget["history"], max_turns=MAX_HISTORY_TURNS,
        )
    else:
        max_messages = MAX_HISTORY_TURNS * 2
        if len(history) > max_messages:
            history = history[-max_messages:]

    history.append({"role": "user", "content": user_input})

    active = session_mgr.get_active_session()
    session_id = active.id if active else ""

    # Reply cache: exact match (optional, best-effort, no-tool rounds only)
    if reply_cache_enabled() and active:
        cached = get_cached_reply(session_id, user_input, history)
        if cached:
            last_assistant_text, _ = cached
            history.append({"role": "assistant", "content": last_assistant_text})
            consolidate_turn(user_input, last_assistant_text or "")
            _sync_session(session_mgr, lifecycle, history)
            return history, last_assistant_text

    system_override = None
    if context_enabled():
        project_knowledge = load_project_knowledge()
        prefs = load_user_preferences()
        preferences_summary = f"Model: {prefs.get('model', 'gpt-4o')}."
        if prefs.get("permissions"):
            preferences_summary += f" Permissions: {prefs.get('permissions')}."
        recent_files_summary = None
        if active:
            recent = active.context.get("recent_files") or []
            if recent:
                lines = [f"- {f.get('path', '')} (accessed {f.get('access_count', 0)}x)" for f in recent[:10]]
                recent_files_summary = "\n".join(lines) if lines else None
        system_override = assemble_system(
            get_base_system(),
            rag_lines=rag_lines if rag_lines else None,
            conversation_summary=lifecycle.get_conversation_summary() or None,
            budget_rag=budget["rag"],
            project_knowledge=project_knowledge,
            preferences_summary=preferences_summary,
            recent_files_summary=recent_files_summary,
        )

    history_before_turn = list(history)
    try:
        history, last_assistant_text, had_tool_calls = agent_loop(
                history,
                retrieved_memories=None if system_override else (rag_lines or None),
                system_override=system_override,
                budget=budget,
                session_id=session_id,
                on_content_delta=stream_callback,
            )
        consolidate_turn(user_input, last_assistant_text or "")

        if reply_cache_enabled() and active and not had_tool_calls:
            set_cached_reply(session_id, user_input, history_before_turn, last_assistant_text or "", history)

        _sync_session(session_mgr, lifecycle, history)
    except Exception as e:  # noqa: BLE001
        logger.error("Error: %s", e)
        err_msg = str(e)[:500]
        history.append({"role": "assistant", "content": f"[Error: {err_msg}]"})
        last_assistant_text = f"[Error: {err_msg}]"
        _sync_session(session_mgr, lifecycle, history)

    turn_ms = int((time.monotonic() - turn_start) * 1000)
    sid_tag = session_id[:8] if session_id else "-"
    slog.debug("run_turn end session=%s duration_ms=%s history_len=%s", sid_tag, turn_ms, len(history))

    return history, last_assistant_text


def _sync_session(
    session_mgr: SessionManager,
    lifecycle: LifecycleManager,
    history: List[Dict[str, Any]],
) -> None:
    """Update session history/summary, persist, and optionally compress old turns."""
    active = session_mgr.get_active_session()
    if active is not None:
        active.history = history
        active.context["conversation_summary"] = lifecycle.get_conversation_summary()
        session_mgr.save_active()
    if context_enabled() and len(history) >= 20:
        summary = summarize_rounds(history[:-2])
        if summary:
            lifecycle.set_conversation_summary(summary)


def main() -> None:
    setup_agent_logging()
    # Use storage abstraction: file (default) or cloud via AGENT_STORAGE_BACKEND
    backend = get_storage_backend()
    session_mgr = SessionManager(store=backend.session_store)
    set_memory_store(backend.memory_store)
    SKILLS.set_store(backend.skill_store)
    set_file_access_callback(lambda p: session_mgr.record_file_access(p))

    print(f"General-purpose Agent v4 (Skills + Memory + Context) - {WORKDIR}")
    print(f"Skills: {', '.join(SKILLS.list_skills()) or 'none'}")
    print(f"Agent types: {', '.join(AGENT_TYPES.keys())}")
    print("Type 'exit' to quit.\n")

    _choose_session(session_mgr)
    active = session_mgr.get_active_session()
    assert active is not None
    history: List[Dict[str, Any]] = active.history

    lifecycle = LifecycleManager()
    saved_summary = active.context.get("conversation_summary")
    if saved_summary:
        lifecycle.set_conversation_summary(saved_summary)
    budget = get_budget(model=MODEL)

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if not user_input or user_input.lower() in ("exit", "quit", "q"):
            session_mgr.save_active()
            break

        history, _ = run_turn(user_input, history, session_mgr, lifecycle, budget)
        print()


if __name__ == "__main__":
    main()
