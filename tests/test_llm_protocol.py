"""Unit tests for LLM provider abstraction: OpenAIProvider and LLMResponse."""

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from llm_protocol import LLMResponse, OpenAIProvider, ToolCall


def test_openai_provider_non_stream():
    """OpenAIProvider.chat(stream=False) returns LLMResponse with content and tool_calls."""
    mock_msg = SimpleNamespace(
        content="Hello",
        tool_calls=[
            SimpleNamespace(
                id="call_1",
                function=SimpleNamespace(name="bash", arguments='{"command": "echo hi"}'),
            ),
        ],
    )
    mock_choice = SimpleNamespace(message=mock_msg, finish_reason="stop")
    mock_usage = SimpleNamespace(
        input_tokens=10,
        output_tokens=5,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
    )
    mock_resp = SimpleNamespace(choices=[mock_choice], usage=mock_usage)

    with patch.object(OpenAIProvider, "_openai_client", new_callable=lambda: MagicMock()) as mock_client_get:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = mock_resp
        mock_client_get.return_value = mock_client

        provider = OpenAIProvider(api_key="sk-test", model="gpt-4o")
        result = provider.chat(
            messages=[{"role": "user", "content": "Hi"}],
            stream=False,
        )

    assert isinstance(result, LLMResponse)
    assert result.content == "Hello"
    assert result.model == "gpt-4o"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].id == "call_1"
    assert result.tool_calls[0].name == "bash"
    assert result.tool_calls[0].arguments == {"command": "echo hi"}
    assert result.usage.get("input_tokens") == 10
    assert result.usage.get("output_tokens") == 5


def test_openai_provider_stream():
    """OpenAIProvider.chat(stream=True) yields LLMResponse deltas then final with tool_calls."""
    chunks = [
        SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="Hel"), tool_calls=None)]),
        SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="lo"), tool_calls=None)]),
        SimpleNamespace(
            choices=[SimpleNamespace(delta=SimpleNamespace(content=None, tool_calls=[
                SimpleNamespace(index=0, id="c1", function=SimpleNamespace(name="bash", arguments='{"command":"x"}')),
            ]))],
            usage=SimpleNamespace(input_tokens=5, output_tokens=2, cache_creation_input_tokens=0, cache_read_input_tokens=0),
        ),
    ]

    with patch.object(OpenAIProvider, "_openai_client", new_callable=lambda: MagicMock()) as mock_client_get:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = iter(chunks)
        mock_client_get.return_value = mock_client

        provider = OpenAIProvider(api_key="sk-test", model="gpt-4o")
        stream = provider.chat(
            messages=[{"role": "user", "content": "Hi"}],
            stream=True,
        )

    parts = list(stream)
    assert len(parts) >= 2
    assert parts[0].content == "Hel"
    assert parts[1].content == "lo"
    last = parts[-1]
    assert last.content == "Hello"
    assert len(last.tool_calls) == 1
    assert last.tool_calls[0].name == "bash"
    assert last.tool_calls[0].arguments == {"command": "x"}


def test_provider_properties():
    """OpenAIProvider has context_window_size and supports_streaming."""
    provider = OpenAIProvider(api_key="sk-x", model="gpt-4o")
    assert provider.context_window_size == 128000
    assert provider.supports_streaming is True
