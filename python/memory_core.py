"""
memory_core.py - Long-term memory store (PRD: episodic + semantic, retrieval, forgetting).

Implements:
- Episodic: concrete events (e.g. "user asked X, we did Y").
- Semantic: distilled insights (e.g. "user prefers Chinese", "tool X needs param Y").
- Retrieval: score = α·Recency + β·Importance + γ·Relevance (keyword-based relevance).
- Forgetting: garbage_collect by TTL and max_items.

Storage: uses optional MemoryStore (from storage abstraction); when None, uses file (MEMORY_FILE).
"""

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, TYPE_CHECKING

from config import WORKDIR

if TYPE_CHECKING:
    from storage.protocols import MemoryStore

# Set AGENT_MEMORY=0 to disable long-term memory (retrieve returns [], consolidate no-op)
MEMORY_ENABLED = os.environ.get("AGENT_MEMORY", "1").strip() not in ("0", "false", "False")

# Default storage under workspace so it persists across runs (used when _memory_store is None)
MEMORY_DIR = Path(os.environ.get("AGENT_MEMORY_DIR", str(WORKDIR / "data" / "memory")))
MEMORY_FILE = MEMORY_DIR / "memories.json"
PREFERENCES_FILE = Path(os.environ.get("AGENT_PREFERENCES_FILE", str(MEMORY_DIR / "preferences.json")))
PATTERNS_FILE = Path(os.environ.get("AGENT_PATTERNS_FILE", str(MEMORY_DIR / "patterns.json")))

# Optional store injected by get_storage_backend(); when set, load/save use it instead of file
_memory_store: Optional["MemoryStore"] = None


def set_memory_store(store: Optional["MemoryStore"]) -> None:
    """Inject MemoryStore (e.g. from get_default_memory_store()). File used when None."""
    global _memory_store
    _memory_store = store

# Short-term: max conversation turns to keep in context (sliding window)
MAX_HISTORY_TURNS = 30

# Long-term caps
MAX_MEMORY_ITEMS = 500
MAX_MEMORY_AGE_DAYS = 90

# Retrieval weights (α + β + γ = 1)
ALPHA_RECENCY = 0.25
BETA_IMPORTANCE = 0.35
GAMMA_RELEVANCE = 0.40


def _ensure_dir() -> None:
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)


def _load_memories() -> List[Dict[str, Any]]:
    if _memory_store is not None:
        return _memory_store.load()
    _ensure_dir()
    if not MEMORY_FILE.exists():
        return []
    try:
        with open(MEMORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def _save_memories(items: List[Dict[str, Any]]) -> None:
    sanitized = sanitize_for_storage(items)
    if _memory_store is not None:
        _memory_store.save(sanitized)
        return
    _ensure_dir()
    with open(MEMORY_FILE, "w", encoding="utf-8") as f:
        json.dump(sanitized, f, ensure_ascii=False, indent=2)


# -----------------------------------------------------------------------------
# Privacy: sensitive data detection and sanitization before storage
# -----------------------------------------------------------------------------

SENSITIVE_PATTERNS = [
    (re.compile(r"\b(api[_-]?key|apikey)\s*[:=]\s*[\w\-]+", re.I), "***"),
    (re.compile(r"\b(password|passwd|pwd)\s*[:=]\s*\S+", re.I), "***"),
    (re.compile(r"\b(token|secret|auth)\s*[:=]\s*[\w\-\.]+", re.I), "***"),
    (re.compile(r"\b(credit[_\s]?card|card\s*#?)\s*[:=]?\s*\d[\d\s\-]+", re.I), "***"),
]


def detect_sensitive_data(text: str) -> bool:
    """True if text appears to contain sensitive information."""
    if not text or not isinstance(text, str):
        return False
    lower = text.lower()
    return any(
        lower.find(p) >= 0
        for p in ("api_key", "api-key", "password", "token", "secret", "credential", "private_key")
    )


def sanitize_for_storage(data: Any) -> Any:
    """
    Return a deep copy of data with sensitive string values redacted.
    Used before persisting memories or session data.
    """
    if isinstance(data, dict):
        return {k: sanitize_for_storage(v) for k, v in data.items()}
    if isinstance(data, list):
        return [sanitize_for_storage(v) for v in data]
    if isinstance(data, str):
        out = data
        for pat, repl in SENSITIVE_PATTERNS:
            out = pat.sub(repl, out)
        return out
    return data


# -----------------------------------------------------------------------------
# Long-term memory: user preferences, project knowledge, learned patterns
# -----------------------------------------------------------------------------

def load_user_preferences() -> Dict[str, Any]:
    """
    Load persistent user preferences (LTM). Returns dict with model, permissions, etc.
    Defaults if file missing. Path: AGENT_PREFERENCES_FILE or data/memory/preferences.json.
    """
    path = PREFERENCES_FILE if PREFERENCES_FILE.is_absolute() else MEMORY_DIR / PREFERENCES_FILE.name
    if not path.exists():
        return {
            "model": os.environ.get("MODEL_ID", "gpt-4o"),
            "permissions": {},
            "features": [],
        }
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"model": os.environ.get("MODEL_ID", "gpt-4o"), "permissions": {}, "features": []}


def load_project_knowledge() -> Optional[str]:
    """
    Load project-specific knowledge from CLAUDE.md in workspace (LTM).
    Returns content or None if file does not exist.
    """
    claude_md = WORKDIR / "CLAUDE.md"
    if not claude_md.exists():
        return None
    try:
        return claude_md.read_text(encoding="utf-8").strip()
    except OSError:
        return None


def _load_patterns_raw() -> List[Dict[str, Any]]:
    """Load patterns list from file."""
    path = PATTERNS_FILE if PATTERNS_FILE.is_absolute() else MEMORY_DIR / PATTERNS_FILE.name
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save_patterns_raw(items: List[Dict[str, Any]]) -> None:
    path = PATTERNS_FILE if PATTERNS_FILE.is_absolute() else MEMORY_DIR / PATTERNS_FILE.name
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(sanitize_for_storage(items), f, ensure_ascii=False, indent=2)


def record_pattern(pattern: Dict[str, Any]) -> None:
    """
    Record a learned pattern (LTM). E.g. successful tool use, workflow step.
    pattern should have: type, and optionally name, frequency, last_used, context.
    """
    now = time.time()
    patterns = _load_patterns_raw()
    name = pattern.get("name") or pattern.get("type", "")
    existing = next((p for p in patterns if p.get("name") == name or p.get("type") == pattern.get("type") and p.get("context") == pattern.get("context")), None)
    if existing:
        existing["frequency"] = existing.get("frequency", 0) + 1
        existing["last_used"] = now
        for k, v in pattern.items():
            if k not in ("frequency", "last_used"):
                existing[k] = v
    else:
        patterns.append({
            **pattern,
            "frequency": pattern.get("frequency", 1),
            "last_used": pattern.get("last_used", now),
        })
    # Cap total patterns
    patterns.sort(key=lambda p: (-p.get("frequency", 0), -p.get("last_used", 0)))
    _save_patterns_raw(patterns[:500])


def get_relevant_patterns(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    """Return patterns whose context/name match query (simple keyword overlap). Used for LTM retrieval."""
    if not query or not query.strip():
        return []
    words = set(_normalize_text(query))
    patterns = _load_patterns_raw()
    scored = []
    for p in patterns:
        ctx = (p.get("context") or "") + " " + (p.get("name") or "") + " " + (p.get("type") or "")
        ctx_words = set(_normalize_text(ctx))
        overlap = len(words & ctx_words) / max(1, len(words))
        scored.append((overlap, p))
    scored.sort(key=lambda x: -x[0])
    return [p for _, p in scored[:limit]]


def _normalize_text(text: str) -> List[str]:
    """Simple tokenization for relevance: lowercase, split on non-alnum."""
    text = (text or "").strip().lower()
    return [w for w in re.split(r"\W+", text) if len(w) > 1]


def _relevance_score(query: str, content: str) -> float:
    """0..1 overlap: Jaccard-like over word sets."""
    q_words = set(_normalize_text(query))
    c_words = set(_normalize_text(content))
    if not q_words:
        return 0.0
    overlap = len(q_words & c_words) / len(q_words)
    return min(1.0, overlap + 0.1 * len(q_words & c_words) / max(1, len(c_words)))


def _recency_score(created_ts: float, now: float) -> float:
    """Exponential decay by days. Newer = higher."""
    days_ago = (now - created_ts) / 86400
    return 0.99 ** days_ago


def write_event(content: str, importance: float = 0.5) -> None:
    """Write an episodic memory (concrete event)."""
    items = _load_memories()
    now = time.time()
    items.append({
        "id": str(uuid.uuid4()),
        "type": "episodic",
        "content": (content or "").strip()[:2000],
        "importance": max(0.0, min(1.0, importance)),
        "created_at": now,
        "last_accessed": now,
    })
    _save_memories(items)


def write_insight(content: str, importance: float = 0.6) -> None:
    """Write a semantic memory (distilled fact / preference)."""
    items = _load_memories()
    now = time.time()
    items.append({
        "id": str(uuid.uuid4()),
        "type": "semantic",
        "content": (content or "").strip()[:2000],
        "importance": max(0.0, min(1.0, importance)),
        "created_at": now,
        "last_accessed": now,
    })
    _save_memories(items)


def retrieve(
    query: str,
    k: int = 5,
    alpha: float = ALPHA_RECENCY,
    beta: float = BETA_IMPORTANCE,
    gamma: float = GAMMA_RELEVANCE,
) -> List[Tuple[str, float, Dict[str, Any]]]:
    """
    Retrieve top-k memories by score = α·Recency + β·Importance + γ·Relevance.
    Returns list of (content, score, raw_record). If memory disabled, returns [].
    """
    if not MEMORY_ENABLED:
        return []
    items = _load_memories()
    if not items:
        return []
    now = time.time()
    scored: List[Tuple[float, Dict[str, Any]]] = []
    for m in items:
        rec = _recency_score(m["created_at"], now)
        imp = m.get("importance", 0.5)
        rel = _relevance_score(query, m.get("content", ""))
        score = alpha * rec + beta * imp + gamma * rel
        scored.append((score, m))
    scored.sort(key=lambda x: -x[0])
    return [(s[1]["content"], s[0], s[1]) for s in scored[:k]]


def garbage_collect(
    max_items: int = MAX_MEMORY_ITEMS,
    max_age_days: float = MAX_MEMORY_AGE_DAYS,
) -> int:
    """Remove oldest and low-importance items. Returns number removed."""
    items = _load_memories()
    now = time.time()
    cutoff_ts = now - max_age_days * 86400
    # Keep: recent or important; drop rest, then cap by max_items
    kept = [m for m in items if m["created_at"] >= cutoff_ts or m.get("importance", 0) >= 0.7]
    kept.sort(key=lambda m: (-m.get("importance", 0), -m["created_at"]))
    kept = kept[:max_items]
    removed = len(items) - len(kept)
    _save_memories(kept)
    return removed


def consolidate_turn(
    user_message: str,
    assistant_summary: str,
    tool_calls_summary: Optional[List[Dict[str, Any]]] = None,
) -> None:
    """
    After a turn: write an episodic memory of the exchange and optionally record
    learned patterns from tool use (LTM). No-op if memory is disabled.
    tool_calls_summary: optional list of {"name": str, "success": bool} for pattern recording.
    """
    if not MEMORY_ENABLED:
        return
    if not (user_message or assistant_summary):
        return
    # One-line episodic summary
    content = f"User: {user_message[:200]}. Assistant: {assistant_summary[:300]}."
    write_event(content, importance=0.4)
    # Record high-level turn pattern for LTM
    record_pattern({
        "type": "turn",
        "name": "conversation_turn",
        "context": user_message[:150],
    })
    if tool_calls_summary:
        for tc in tool_calls_summary:
            if tc.get("success"):
                record_pattern({
                    "type": "tool_use",
                    "name": tc.get("name", "tool"),
                    "context": user_message[:100],
                })
    # Lightweight garbage collect every 10 writes (could be done in background)
    items = _load_memories()
    if len(items) > MAX_MEMORY_ITEMS:
        garbage_collect(max_items=MAX_MEMORY_ITEMS, max_age_days=MAX_MEMORY_AGE_DAYS)
