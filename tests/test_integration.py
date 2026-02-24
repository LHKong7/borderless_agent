"""Integration test: run a single turn through the pipeline with a mocked OpenAI client."""

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
os.environ.setdefault("OPENAI_API_KEY", "sk-test")

from session_core import SessionManager
from context_core import LifecycleManager
from config import MODEL


def _make_mock_response(text: str = "Hello from mock"):
    """Build a fake OpenAI chat.completions.create response."""
    msg = SimpleNamespace(
        content=text,
        tool_calls=None,
        role="assistant",
    )
    choice = SimpleNamespace(message=msg, finish_reason="stop")
    usage = SimpleNamespace(
        input_tokens=100,
        output_tokens=20,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
    )
    return SimpleNamespace(choices=[choice], usage=usage)


def test_run_turn_integration(tmp_path):
    session_mgr = SessionManager(storage_dir=tmp_path / "sessions")
    session_mgr.create_session(context={"test": True})

    lifecycle = LifecycleManager()
    budget = {"system": 40000, "rag": 10000, "history": 100000, "output_reserve": 8000, "total": 200000}
    history = []

    mock_resp = _make_mock_response("I'm the assistant.")

    with patch("loop_core.client") as mock_client:
        mock_client.chat.completions.create.return_value = mock_resp
        from cli.main import run_turn
        history, last_text = run_turn("Hello", history, session_mgr, lifecycle, budget)

    assert len(history) >= 2
    assert history[0]["role"] == "user"
    assert history[0]["content"] == "Hello"
    assert history[-1]["role"] == "assistant"
    assert "I'm the assistant." in last_text

    mock_client.chat.completions.create.assert_called_once()
    call_kwargs = mock_client.chat.completions.create.call_args
    messages_sent = call_kwargs.kwargs.get("messages") or call_kwargs[1].get("messages") or call_kwargs[0][0] if call_kwargs[0] else None
    if messages_sent is None and call_kwargs.kwargs:
        messages_sent = call_kwargs.kwargs.get("messages")
    assert messages_sent is not None
    assert messages_sent[0]["role"] == "system"


def test_run_turn_error_handling(tmp_path):
    session_mgr = SessionManager(storage_dir=tmp_path / "sessions")
    session_mgr.create_session(context={"test": True})

    lifecycle = LifecycleManager()
    budget = {"system": 40000, "rag": 10000, "history": 100000, "output_reserve": 8000, "total": 200000}
    history = []

    with patch("loop_core.client") as mock_client:
        mock_client.chat.completions.create.side_effect = RuntimeError("API down")
        from cli.main import run_turn
        history, last_text = run_turn("Hi", history, session_mgr, lifecycle, budget)

    assert "[Error:" in last_text
    assert any("[Error:" in m.get("content", "") for m in history if m.get("role") == "assistant")
