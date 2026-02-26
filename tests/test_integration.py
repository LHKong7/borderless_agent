"""Integration test: run a single turn through the pipeline with a mocked LLM provider."""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
os.environ.setdefault("OPENAI_API_KEY", "sk-test")

from session_core import SessionManager
from context_core import LifecycleManager
from config import MODEL
from llm_protocol import LLMResponse


def _make_mock_llm_response(text: str = "Hello from mock") -> LLMResponse:
    """Build a fake LLMResponse for provider.chat()."""
    return LLMResponse(
        content=text,
        tool_calls=[],
        usage={"input_tokens": 100, "output_tokens": 20},
        model="test",
    )


def test_run_turn_integration(tmp_path):
    session_mgr = SessionManager(storage_dir=tmp_path / "sessions")
    session_mgr.create_session(context={"test": True})

    lifecycle = LifecycleManager()
    budget = {"system": 40000, "rag": 10000, "history": 100000, "output_reserve": 8000, "total": 200000}
    history = []

    mock_llm = MagicMock()
    mock_llm.supports_streaming = False
    mock_llm.chat.return_value = _make_mock_llm_response("I'm the assistant.")

    with patch("loop_core.default_llm_provider", mock_llm):
        from cli.main import run_turn
        history, last_text = run_turn("Hello", history, session_mgr, lifecycle, budget)

    assert len(history) >= 2
    assert history[0]["role"] == "user"
    assert history[0]["content"] == "Hello"
    assert history[-1]["role"] == "assistant"
    assert "I'm the assistant." in last_text

    mock_llm.chat.assert_called_once()
    call_kwargs = mock_llm.chat.call_args
    messages_sent = call_kwargs.kwargs.get("messages") or (call_kwargs[1].get("messages") if call_kwargs[1] else None)
    assert messages_sent is not None
    assert messages_sent[0]["role"] == "system"


def test_run_turn_error_handling(tmp_path):
    session_mgr = SessionManager(storage_dir=tmp_path / "sessions")
    session_mgr.create_session(context={"test": True})

    lifecycle = LifecycleManager()
    budget = {"system": 40000, "rag": 10000, "history": 100000, "output_reserve": 8000, "total": 200000}
    history = []

    mock_llm = MagicMock()
    mock_llm.supports_streaming = False
    mock_llm.chat.side_effect = RuntimeError("API down")

    with patch("loop_core.default_llm_provider", mock_llm):
        from cli.main import run_turn
        history, last_text = run_turn("Hi", history, session_mgr, lifecycle, budget)

    assert "[Error:" in last_text
    assert any("[Error:" in m.get("content", "") for m in history if m.get("role") == "assistant")
