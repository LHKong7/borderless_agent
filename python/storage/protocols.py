"""
Storage protocols: abstract interfaces for Session, Memory, Skill, and Context stores.

Backends (file, cloud) implement these protocols. Callers (session_core, memory_core,
skills_core) use the injected store; default is file-based when no store is passed.
"""

from typing import Any, Dict, List, Optional, Protocol, runtime_checkable


@runtime_checkable
class SessionStore(Protocol):
    """Persist and load session documents by session_id."""

    def get(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Load session dict (id, state, history, context, created_at, updated_at)."""
        ...

    def put(self, session_id: str, data: Dict[str, Any]) -> None:
        """Save full session dict."""
        ...

    def list_summaries(self, limit: int = 20) -> List[Dict[str, Any]]:
        """Return list of {id, updated_at, turns, state}, sorted by updated_at desc."""
        ...

    def list_ids(self) -> List[str]:
        """Return all known session ids."""
        ...


@runtime_checkable
class MemoryStore(Protocol):
    """Persist and load the single list of memory items (episodic + semantic)."""

    def load(self) -> List[Dict[str, Any]]:
        """Load all memory items."""
        ...

    def save(self, items: List[Dict[str, Any]]) -> None:
        """Replace all memory items."""
        ...


@runtime_checkable
class SkillStore(Protocol):
    """Read-only store of skills: list names and get skill content dict."""

    def list_skills(self) -> List[str]:
        """Return skill names."""
        ...

    def get_skill(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Return skill dict with at least: name, description, body.
        Optional: dir (Path-like), path, for file backend resource hints.
        """
        ...


@runtime_checkable
class ContextStore(Protocol):
    """Per-session context blob (e.g. conversation_summary); can be merged with session.context."""

    def get(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Load context dict for session."""
        ...

    def set(self, session_id: str, data: Dict[str, Any]) -> None:
        """Save context dict for session."""
        ...


class StorageBackend:
    """Bundle of all four stores; factory returns this."""

    def __init__(
        self,
        session_store: SessionStore,
        memory_store: MemoryStore,
        skill_store: SkillStore,
        context_store: ContextStore,
    ):
        self.session_store = session_store
        self.memory_store = memory_store
        self.skill_store = skill_store
        self.context_store = context_store
