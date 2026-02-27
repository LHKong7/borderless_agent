"""
llm_protocol.py - LLM provider abstraction for library-style agent usage.

Protocol and types allow swapping OpenAI, Anthropic, or local backends without
changing the agent loop. chat() accepts list-of-dicts messages (current API shape)
and returns normalized LLMResponse (or an iterator when stream=True).

Streaming contract: when stream=True, the iterator yields one or more LLMResponse.
Earlier yields may have content set to incremental deltas; the last yielded value
must contain the full accumulated content and any tool_calls so the agent loop
can append assistant + tool messages and continue.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Protocol, Union

# -----------------------------------------------------------------------------
# Types (normalized output only; input remains List[Dict] for minimal change)
# -----------------------------------------------------------------------------


@dataclass
class ToolCall:
    """Normalized tool call from LLM response."""

    id: str
    name: str
    arguments: Dict[str, Any]


@dataclass
class LLMResponse:
    """Normalized LLM response. content may be a delta when streaming."""

    content: Optional[str]
    tool_calls: List[ToolCall]
    usage: Dict[str, int]  # e.g. prompt_tokens, completion_tokens
    model: str


# -----------------------------------------------------------------------------
# Protocol
# -----------------------------------------------------------------------------


class LLMProvider(Protocol):
    """Generic LLM provider interface."""

    @property
    def context_window_size(self) -> int:
        ...

    @property
    def supports_streaming(self) -> bool:
        ...

    def chat(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
        stream: bool = False,
    ) -> Union[LLMResponse, Iterator[LLMResponse]]:
        """
        Send messages and optional tools; return one LLMResponse or an iterator
        of LLMResponse when stream=True (deltas then final with tool_calls).
        """
        ...


# -----------------------------------------------------------------------------
# OpenAI implementation
# -----------------------------------------------------------------------------


def _usage_from_openai(usage: Any) -> Dict[str, int]:
    """Build usage dict from OpenAI response.usage."""
    if usage is None:
        return {}
    return {
        "input_tokens": getattr(usage, "input_tokens", 0) or 0,
        "output_tokens": getattr(usage, "output_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
        "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
    }


def _tool_calls_from_openai_message(msg: Any) -> List[ToolCall]:
    """Parse tool_calls from OpenAI message object into List[ToolCall]."""
    result: List[ToolCall] = []
    raw = list(msg.tool_calls) if getattr(msg, "tool_calls", None) else []
    for tc in raw:
        fn = getattr(tc, "function", None)
        name = getattr(fn, "name", "") or "" if fn else ""
        args_str = getattr(fn, "arguments", "") or "" if fn else "{}"
        try:
            import json
            arguments = json.loads(args_str) if args_str else {}
        except Exception:
            arguments = {}
        result.append(ToolCall(id=getattr(tc, "id", "") or "", name=name, arguments=arguments))
    return result


class OpenAIProvider:
    """LLMProvider implementation using OpenAI API."""

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: Optional[str] = None,
        timeout: float = 120,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._base_url = base_url
        self._timeout = timeout
        self._client: Any = None

    @property
    def _openai_client(self) -> Any:
        if self._client is None:
            from openai import OpenAI
            kw: Dict[str, Any] = {"api_key": self._api_key, "timeout": self._timeout}
            if self._base_url:
                kw["base_url"] = self._base_url
            self._client = OpenAI(**kw)
        return self._client

    @property
    def context_window_size(self) -> int:
        return 128000

    @property
    def supports_streaming(self) -> bool:
        return True

    def chat(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
        stream: bool = False,
    ) -> Union[LLMResponse, Iterator[LLMResponse]]:
        openai_tools = None
        if tools:
            # Accept either OpenAI format (type/function) or internal (name/description/input_schema)
            first = tools[0]
            if first.get("type") == "function":
                openai_tools = tools
            else:
                openai_tools = [
                    {
                        "type": "function",
                        "function": {
                            "name": t["name"],
                            "description": t.get("description", ""),
                            "parameters": t.get("input_schema", t.get("parameters", {"type": "object", "properties": {}})),
                        },
                    }
                    for t in tools
                ]
        kwargs: Dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "max_tokens": max_tokens or 8000,
            "temperature": temperature,
        }
        if openai_tools:
            kwargs["tools"] = openai_tools
            kwargs["tool_choice"] = "auto"

        if stream:
            return self._chat_stream(kwargs)
        resp = self._openai_client.chat.completions.create(**kwargs)
        msg = resp.choices[0].message
        usage = _usage_from_openai(getattr(resp, "usage", None))
        tool_calls = _tool_calls_from_openai_message(msg)
        return LLMResponse(
            content=(msg.content or "").strip() or None,
            tool_calls=tool_calls,
            usage=usage,
            model=self._model,
        )

    def _chat_stream(self, kwargs: Dict[str, Any]) -> Iterator[LLMResponse]:
        kwargs = dict(kwargs)
        kwargs["stream"] = True
        stream = self._openai_client.chat.completions.create(**kwargs)
        content_parts: List[str] = []
        tool_calls_accum: List[Dict[str, Any]] = []
        usage: Dict[str, int] = {}

        for chunk in stream:
            if not getattr(chunk, "choices", None) or len(chunk.choices) == 0:
                if getattr(chunk, "usage", None):
                    usage = _usage_from_openai(chunk.usage)
                continue
            choice = chunk.choices[0]
            delta = getattr(choice, "delta", None)
            if delta is None:
                continue
            part = getattr(delta, "content", None)
            if part:
                content_parts.append(part)
                yield LLMResponse(content=part, tool_calls=[], usage={}, model=self._model)
            for tc in getattr(delta, "tool_calls", None) or []:
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
                usage = _usage_from_openai(chunk.usage)

        full_content = "".join(content_parts)
        tool_calls_out: List[ToolCall] = []
        for acc in tool_calls_accum:
            if acc.get("id") or acc.get("name") or acc.get("arguments"):
                args_str = acc.get("arguments", "{}")
                try:
                    import json
                    arguments = json.loads(args_str) if args_str else {}
                except Exception:
                    arguments = {}
                tool_calls_out.append(
                    ToolCall(id=acc.get("id", ""), name=acc.get("name", ""), arguments=arguments)
                )
        yield LLMResponse(
            content=full_content or None,
            tool_calls=tool_calls_out,
            usage=usage,
            model=self._model,
        )
