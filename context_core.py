"""
context_core.py - Context management pipeline (CONTEXT_MANAGEMENT.md).

Aligns with Claude Code–style context management:
- Dynamic context window (200K default, 1M when model/features support it)
- Model-specific max output tokens
- Token usage stats (input + cache creation + cache read)
- Env-based config with validation (output limits, bash/task max length)

Also implements:
- Data Source Layer: registry with token estimation
- Lifecycle Manager: session, token budget, topic-shift detection
- Selector: sliding window + budget-based trim
- Compressor: observation folding, optional summarization placeholder
- Assembler: position engineering, injection defense
- Optional exact-match reply cache
"""

import hashlib
import os
import re
import uuid
from typing import Any, Dict, List, Optional, Tuple

# -----------------------------------------------------------------------------
# Feature identifiers (Claude Code–style; used for context window / caching)
# -----------------------------------------------------------------------------

FEATURES = {
    "CLAUDE_CODE": "claude-code-20250219",
    "INTERLEAVED_THINKING": "interleaved-thinking-2025-05-14",
    "CONTEXT_1M": "context-1m-2025-08-07",
    "CONTEXT_MANAGEMENT": "context-management-2025-06-27",
    "STRUCTURED_OUTPUTS": "structured-outputs-2025-12-15",
    "WEB_SEARCH": "web-search-2025-03-05",
    "TOOL_EXAMPLES": "tool-examples-2025-10-29",
    "ADVANCED_TOOL_USE": "advanced-tool-use-2025-11-20",
    "TOOL_SEARCH_TOOL": "tool-search-tool-2025-10-19",
    "EFFORT": "effort-2025-11-24",
    "PROMPT_CACHING_SCOPE": "prompt-caching-scope-2026-01-05",
}

# -----------------------------------------------------------------------------
# Token estimation (heuristic: ~3 chars per token for mixed EN/CJK)
# -----------------------------------------------------------------------------

def estimate_tokens(text: str) -> int:
    """Rough token count for budget control. Adjust per model if needed."""
    if not text:
        return 0
    return max(1, len(text) // 3)


def estimate_messages_tokens(messages: List[Dict[str, Any]]) -> int:
    """Sum token estimate for a list of message dicts (role + content)."""
    total = 0
    for m in messages:
        total += estimate_tokens(str(m.get("role", "")))
        content = m.get("content")
        if isinstance(content, str):
            total += estimate_tokens(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and "text" in block:
                    total += estimate_tokens(block.get("text", ""))
                elif isinstance(block, dict) and "content" in block:
                    total += estimate_tokens(str(block.get("content", "")))
    return total


# -----------------------------------------------------------------------------
# Context window and output limits (Claude Code–style constants)
# -----------------------------------------------------------------------------

DEFAULT_MAX_TOKENS = 200_000       # Default context window (uRq)
DEFAULT_OUTPUT_TOKENS = 20_000    # Default output token limit (nv6)
DEFAULT_MAX_OUTPUT_TOKENS = 32_000  # Default max_tokens (BRq)
MAX_OUTPUT_TOKENS_CAP = 64_000    # Env cap for AGENT_MAX_OUTPUT_TOKENS
CONTEXT_1M_TOKENS = 1_000_000

SYSTEM_RESERVE_TOKENS = 1_000
OUTPUT_RESERVE_RATIO = 0.10   # 10% for generation when not using model-specific output
RAG_RATIO = 0.40
HISTORY_RATIO = 0.50


def _is_claude_sonnet_4(model: str) -> bool:
    """True if model is Claude Sonnet 4 (for 1M context detection)."""
    return "claude-sonnet-4" in (model or "").lower()


def get_context_window_size(
    model: Optional[str] = None,
    enabled_features: Optional[List[str]] = None,
) -> int:
    """
    Dynamic context window: 1M if model/features support it, else 200K.
    Supports [1m] marker or context-1m feature + claude-sonnet-4.
    """
    model = (model or "").strip()
    features = set(enabled_features or [])
    if "[1m]" in model:
        return CONTEXT_1M_TOKENS
    if FEATURES.get("CONTEXT_1M") in features and _is_claude_sonnet_4(model):
        return CONTEXT_1M_TOKENS
    return DEFAULT_MAX_TOKENS


def get_max_output_tokens(model: Optional[str] = None) -> int:
    """
    Model-specific max output tokens (Claude Code lY1-style).
    Claude 3: 4K–8K; Claude 4: 32K–64K. Default 32K.
    For non-Claude models, use env AGENT_MAX_OUTPUT_TOKENS or default.
    """
    raw = os.environ.get("AGENT_MAX_OUTPUT_TOKENS", "").strip()
    if raw:
        try:
            val = int(raw)
            if val > 0:
                return min(val, MAX_OUTPUT_TOKENS_CAP)
        except ValueError:
            pass
    model_lower = (model or "").lower()
    # Claude 3
    if "3-5" in model_lower:
        return 8192
    if "claude-3-opus" in model_lower:
        return 4096
    if "claude-3-sonnet" in model_lower:
        return 8192
    if "claude-3-haiku" in model_lower:
        return 4096
    # Claude 4
    if "opus-4-5" in model_lower:
        return 64_000
    if "opus-4" in model_lower:
        return 32_000
    if "sonnet-4" in model_lower or "haiku-4" in model_lower:
        return 64_000
    return DEFAULT_MAX_OUTPUT_TOKENS


def compute_usage_stats(
    usage: Optional[Dict[str, Any]],
    max_tokens: int,
) -> Dict[str, Optional[int]]:
    """
    Token usage stats: total input = input_tokens + cache_creation_input_tokens
    + cache_read_input_tokens. Returns used_percentage (0–100) and remaining_percentage.
    """
    if not usage or max_tokens <= 0:
        return {"used": None, "remaining": None}
    total_input = (
        int(usage.get("input_tokens") or 0)
        + int(usage.get("cache_creation_input_tokens") or 0)
        + int(usage.get("cache_read_input_tokens") or 0)
    )
    used_pct = round((total_input / max_tokens) * 100)
    used_pct = max(0, min(100, used_pct))
    return {"used": used_pct, "remaining": 100 - used_pct}


# -----------------------------------------------------------------------------
# Env config with validation (Claude Code CONFIG-style)
# -----------------------------------------------------------------------------

def _env_int(name: str, default: int, max_val: Optional[int] = None) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        val = int(raw)
        if val <= 0:
            return default
        if max_val is not None and val > max_val:
            return max_val
        return val
    except ValueError:
        return default


BASH_MAX_OUTPUT_LENGTH_DEFAULT = 30_000
BASH_MAX_OUTPUT_LENGTH_MAX = 150_000
TASK_MAX_OUTPUT_LENGTH_DEFAULT = 30_000
TASK_MAX_OUTPUT_LENGTH_MAX = 150_000


def get_bash_max_output_length() -> int:
    """BASH_MAX_OUTPUT_LENGTH: default 30000, max 150000."""
    return _env_int("BASH_MAX_OUTPUT_LENGTH", BASH_MAX_OUTPUT_LENGTH_DEFAULT, BASH_MAX_OUTPUT_LENGTH_MAX)


def get_task_max_output_length() -> int:
    """TASK_MAX_OUTPUT_LENGTH: default 30000, max 150000."""
    return _env_int("TASK_MAX_OUTPUT_LENGTH", TASK_MAX_OUTPUT_LENGTH_DEFAULT, TASK_MAX_OUTPUT_LENGTH_MAX)


def get_agent_max_output_tokens() -> int:
    """AGENT_MAX_OUTPUT_TOKENS: default 32000, max 64000."""
    return _env_int("AGENT_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_CAP)


# -----------------------------------------------------------------------------
# Budget (from CONTEXT_MANAGEMENT.md §3.2; now model- and feature-aware)
# -----------------------------------------------------------------------------

def get_budget(
    total: Optional[int] = None,
    model: Optional[str] = None,
    enabled_features: Optional[List[str]] = None,
) -> Dict[str, int]:
    """
    Return token budget per segment. If total is None, compute from
    get_context_window_size(model, enabled_features). Output reserve uses
    model-specific max output tokens (or env AGENT_MAX_OUTPUT_TOKENS).
    """
    if total is None:
        total = get_context_window_size(model, enabled_features)
    output_reserve = get_max_output_tokens(model)
    input_budget = max(0, total - output_reserve)
    return {
        "total": total,
        "system": SYSTEM_RESERVE_TOKENS,
        "rag": int(input_budget * RAG_RATIO),
        "history": int(input_budget * HISTORY_RATIO),
        "output_reserve": output_reserve,
    }


# -----------------------------------------------------------------------------
# Short-term memory: token budget and message prioritization (STM)
# -----------------------------------------------------------------------------

# Message priority levels (Claude Code-style); higher = keep when context is full
MESSAGE_PRIORITIES = {
    "CRITICAL": 1.0,   # System prompts, user preferences
    "HIGH": 0.8,       # Recent tool results, errors
    "MEDIUM": 0.6,     # Regular conversation
    "LOW": 0.4,        # Verbose outputs, old context
    "DISCARDABLE": 0.2,  # Can be dropped when context is full
}


class TokenBudget:
    """
    Dynamic token allocation for short-term (working) memory.
    Tracks context window size (200K or 1M), used tokens, and usage stats from API.
    """

    def __init__(
        self,
        model: Optional[str] = None,
        enabled_features: Optional[List[str]] = None,
    ) -> None:
        self.model = model
        self.enabled_features = enabled_features or []
        self.max_tokens = get_context_window_size(model, enabled_features)
        self.used_tokens = 0
        self.reserved_tokens = 0

    def calculate_usage(self, usage: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Compute input usage from API usage dict (input + cache creation + cache read)."""
        if not usage or self.max_tokens <= 0:
            return {"input": 0, "cached": 0, "total": 0, "percentage": 0}
        inp = int(usage.get("input_tokens") or 0)
        cache_creation = int(usage.get("cache_creation_input_tokens") or 0)
        cache_read = int(usage.get("cache_read_input_tokens") or 0)
        total = inp + cache_creation + cache_read
        pct = round((total / self.max_tokens) * 100)
        pct = max(0, min(100, pct))
        return {
            "input": inp,
            "cached": cache_creation + cache_read,
            "total": total,
            "percentage": pct,
        }

    @property
    def remaining_tokens(self) -> int:
        return max(0, self.max_tokens - self.used_tokens - self.reserved_tokens)


def prioritize_messages(
    messages: List[Dict[str, Any]],
    available_tokens: int,
    default_priority: float = MESSAGE_PRIORITIES["MEDIUM"],
) -> List[Dict[str, Any]]:
    """
    Filter and sort messages by priority so they fit in available_tokens.
    Messages without a 'priority' key get default_priority. Discardable messages
    are dropped first when over budget.
    """
    if not messages or available_tokens <= 0:
        return messages
    # Assign default priority and filter out discardable
    prioritized = []
    for m in messages:
        p = m.get("priority")
        if p is None:
            p = default_priority
        if p <= MESSAGE_PRIORITIES["DISCARDABLE"]:
            continue
        prioritized.append((p, m))
    # Sort by priority descending (keep most important first)
    prioritized.sort(key=lambda x: -x[0])
    # Fit into token budget
    result = []
    used = 0
    for _, m in prioritized:
        est = estimate_messages_tokens([m])
        if used + est <= available_tokens:
            result.append(m)
            used += est
        else:
            break
    # Preserve order of original messages for the ones we kept
    order = {id(m): i for i, m in enumerate(messages)}
    result.sort(key=lambda m: order.get(id(m), 999))
    return result


# -----------------------------------------------------------------------------
# Source Registry
# -----------------------------------------------------------------------------

class SourceRegistry:
    """Register data sources and their token counts."""

    def __init__(self) -> None:
        self._sources: Dict[str, Dict[str, Any]] = {}

    def register(self, name: str, content: Any, meta: Optional[Dict[str, Any]] = None) -> None:
        self._sources[name] = {
            "content": content,
            "meta": meta or {},
            "tokens": estimate_tokens(str(content)) if isinstance(content, str) else 0,
        }

    def get(self, name: str) -> Optional[Dict[str, Any]]:
        return self._sources.get(name)

    def estimate_tokens(self, name: str) -> int:
        s = self._sources.get(name)
        return s["tokens"] if s else 0

    def total_tokens(self) -> int:
        return sum(s["tokens"] for s in self._sources.values())


# -----------------------------------------------------------------------------
# Lifecycle Manager: session, topic shift
# -----------------------------------------------------------------------------

class LifecycleManager:
    """Session tracking and topic-shift detection."""

    def __init__(self) -> None:
        self._session_id = str(uuid.uuid4())
        self._conversation_summary: str = ""

    @property
    def session_id(self) -> str:
        return self._session_id

    def set_conversation_summary(self, summary: str) -> None:
        self._conversation_summary = summary

    def get_conversation_summary(self) -> str:
        return self._conversation_summary

    def detect_topic_shift(
        self,
        user_input: str,
        recent_history: List[Dict[str, Any]],
        overlap_threshold: float = 0.1,
    ) -> bool:
        """
        True if user intent seems to have shifted (e.g. new topic).
        Simple heuristic: very low keyword overlap with last user message.
        """
        if not user_input or not recent_history:
            return False
        # Last user message
        last_user = ""
        for i in range(len(recent_history) - 1, -1, -1):
            if recent_history[i].get("role") == "user":
                c = recent_history[i].get("content")
                last_user = (c if isinstance(c, str) else "").strip()
                break
        if not last_user:
            return False
        a = set(re.findall(r"\w+", user_input.lower()))
        b = set(re.findall(r"\w+", last_user.lower()))
        if not a:
            return False
        overlap = len(a & b) / len(a)
        return overlap < overlap_threshold

    def reset_session(self) -> str:
        """New session id; caller should clear history and optionally archive."""
        self._session_id = str(uuid.uuid4())
        self._conversation_summary = ""
        return self._session_id


# -----------------------------------------------------------------------------
# Selector: sliding window + budget cap
# -----------------------------------------------------------------------------

def select_history(
    history: List[Dict[str, Any]],
    user_input: str,
    max_tokens: int,
    max_turns: int = 30,
) -> List[Dict[str, Any]]:
    """
    Sliding window: keep at most max_turns turns (user+assistant pairs),
    then trim by max_tokens from the front.
    """
    if not history:
        return []
    # Keep last max_turns * 2 messages (each turn ≈ user + assistant)
    capped = history[-(max_turns * 2) :] if len(history) > max_turns * 2 else history
    if estimate_messages_tokens(capped) <= max_tokens:
        return capped
    # Trim from front until under budget
    for i in range(1, len(capped) + 1):
        trimmed = capped[i:]
        if estimate_messages_tokens(trimmed) <= max_tokens:
            return trimmed
    return capped[-2:] if len(capped) >= 2 else capped


# -----------------------------------------------------------------------------
# Compressor: observation folding, optional summarization
# -----------------------------------------------------------------------------

OBSERVATION_MAX_CHARS = 3500


def fold_observation(raw: str, max_chars: int = OBSERVATION_MAX_CHARS) -> str:
    """Fold long tool/output into a short summary line."""
    if not raw or len(raw) <= max_chars:
        return raw
    head = raw[: max_chars // 2].strip()
    tail = raw[-500:].strip() if len(raw) > 500 else ""
    summary = f"[Data too long ({len(raw)} chars). First part: {head[:200]}... Last part: ...{tail[-150:]}]"
    return summary[:max_chars]


def _summarizer_enabled() -> bool:
    return os.environ.get("AGENT_SUMMARIZER", "").strip().lower() in ("1", "true", "yes")


def _model_summarize(rounds: List[Dict[str, Any]]) -> str:
    """Call the configured LLM to produce a concise summary of conversation rounds."""
    from config import client, MODEL

    text_parts: List[str] = []
    for m in rounds[:30]:
        role = m.get("role", "")
        content = m.get("content", "")
        if isinstance(content, str):
            text_parts.append(f"{role}: {content[:300]}")
        else:
            text_parts.append(f"{role}: (tool use)")
    transcript = "\n".join(text_parts)[:4000]

    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "Summarize the following conversation in 2-3 sentences. Focus on key topics, decisions, and outcomes. Be concise."},
                {"role": "user", "content": transcript},
            ],
            max_tokens=300,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def summarize_rounds(rounds: List[Dict[str, Any]]) -> str:
    """
    Summarize conversation rounds. Uses model-based summarization when
    AGENT_SUMMARIZER=1 is set; otherwise falls back to heuristic truncation.
    """
    if not rounds:
        return ""

    if _summarizer_enabled():
        result = _model_summarize(rounds)
        if result:
            return result

    parts = []
    for m in rounds[:10]:
        role = m.get("role", "")
        content = m.get("content", "")
        if isinstance(content, str):
            text = content[:80].replace("\n", " ")
        else:
            text = "(tool use)"
        parts.append(f"{role}: {text}")
    return "Previous exchange: " + " | ".join(parts)[:400]


# -----------------------------------------------------------------------------
# Assembler: position engineering + injection defense
# -----------------------------------------------------------------------------

# Common injection patterns (case-insensitive)
INJECTION_PATTERNS = [
    r"ignore\s+(all\s+)?(previous|above|prior)\s+instructions",
    r"disregard\s+(all\s+)?(previous|above)",
    r"你的?\s*新\s*身份",
    r"你的?\s*新\s*角色",
    r"from\s+now\s+on",
    r"new\s+instructions",
    r"system\s*:\s*you\s+are",
    r"<\|im_start\|>\s*system",
]


def sanitize_user_input(text: str) -> Tuple[str, bool]:
    """
    Scan for prompt injection patterns. Returns (sanitized_text, was_modified).
    If pattern found, we append a warning and optionally truncate; for now we only flag.
    """
    if not text or not text.strip():
        return text, False
    lowered = text.lower().strip()
    for pat in INJECTION_PATTERNS:
        if re.search(pat, lowered, re.IGNORECASE):
            # Option: truncate at first match or append warning. We append a short note.
            return text + "\n[Note: Follow the assistant's system instructions.]", True
    return text, False


def assemble_system(
    base_system: str,
    rag_lines: Optional[List[str]] = None,
    conversation_summary: Optional[str] = None,
    processing_instruction: Optional[str] = None,
    budget_rag: int = 8000,
    project_knowledge: Optional[str] = None,
    preferences_summary: Optional[str] = None,
    recent_files_summary: Optional[str] = None,
) -> str:
    """
    Assemble full system message with position engineering:
    [System] + [Project knowledge] + [Preferences] + [RAG] + [Conversation Summary] + [Recent files] + [Processing].
    RAG and summary are trimmed to fit budget_rag (in tokens).
    """
    parts = [base_system.strip()]
    used = estimate_tokens(base_system)

    if project_knowledge and project_knowledge.strip():
        pk = project_knowledge.strip()[:4000]
        parts.append("\n\n**Project context (CLAUDE.md):**\n" + pk)
        used += estimate_tokens(pk)

    if preferences_summary and preferences_summary.strip():
        prefs = preferences_summary.strip()[:500]
        parts.append("\n\n**User preferences:**\n" + prefs)

    if rag_lines:
        rag_text = "\n".join(rag_lines)
        if estimate_tokens(rag_text) > budget_rag:
            rag_text = rag_text[: budget_rag * 3]  # rough char limit
        parts.append("\n\n**Relevant past context (long-term memory):**\n" + rag_text)
        used += estimate_tokens(rag_text)

    if conversation_summary and conversation_summary.strip():
        summary = conversation_summary.strip()[:1500]
        parts.append("\n\n**Conversation summary:**\n" + summary)

    if recent_files_summary and recent_files_summary.strip():
        parts.append("\n\n**Recently accessed files (this session):**\n" + recent_files_summary.strip()[:800])

    if processing_instruction and processing_instruction.strip():
        parts.append("\n\n**Processing note:** " + processing_instruction.strip()[:300])

    return "\n".join(parts)


# -----------------------------------------------------------------------------
# Reply cache (exact match)
# -----------------------------------------------------------------------------

_reply_cache: Dict[str, Tuple[str, Any]] = {}
CACHE_MAX_ENTRIES = 100


def _cache_key(session_id: str, user_input: str, history_hash: str) -> str:
    h = hashlib.sha256((session_id + user_input + history_hash).encode()).hexdigest()
    return h[:32]


def get_cached_reply(session_id: str, user_input: str, history: List[Dict[str, Any]]) -> Optional[Tuple[str, Any]]:
    """Return (last_assistant_text, full_messages) if exact match cached."""
    key = _cache_key(session_id, user_input, hashlib.sha256(str(history).encode()).hexdigest())
    return _reply_cache.get(key)


def set_cached_reply(
    session_id: str,
    user_input: str,
    history: List[Dict[str, Any]],
    last_assistant_text: str,
    messages: List[Dict[str, Any]],
) -> None:
    global _reply_cache
    key = _cache_key(session_id, user_input, hashlib.sha256(str(history).encode()).hexdigest())
    _reply_cache[key] = (last_assistant_text, messages)
    if len(_reply_cache) > CACHE_MAX_ENTRIES:
        # Drop oldest (arbitrary)
        to_drop = list(_reply_cache.keys())[: len(_reply_cache) - CACHE_MAX_ENTRIES]
        for k in to_drop:
            del _reply_cache[k]


def context_enabled() -> bool:
    """Whether context management (budget, folding, injection check) is enabled."""
    return os.environ.get("AGENT_CONTEXT", "1").strip() not in ("0", "false", "False")


def reply_cache_enabled() -> bool:
    """Whether reply cache (exact-match) is enabled. Best-effort; disable via AGENT_REPLY_CACHE=0."""
    return os.environ.get("AGENT_REPLY_CACHE", "0").strip() not in ("0", "false", "False")
