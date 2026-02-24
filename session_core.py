"""
session_core.py - Session manager: lifecycle, conversation history, persistence.

Responsibilities:
- Manage user session lifecycle (create, restore, switch, archive)
- Maintain conversation history per session
- Persist sessions via storage abstraction (file or cloud); file is default.
"""

import json
import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, TYPE_CHECKING

from config import WORKDIR

if TYPE_CHECKING:
    from storage.protocols import SessionStore

# Storage under workspace so it persists across runs (used when store is None)
SESSION_DIR = Path(os.environ.get("AGENT_SESSION_DIR", str(WORKDIR / "data" / "sessions")))
SESSION_STATE_ACTIVE = "active"
SESSION_STATE_ARCHIVED = "archived"


@dataclass
class Session:
    """Single user session: id, state, history, optional context."""

    id: str
    state: str = SESSION_STATE_ACTIVE
    history: List[Dict[str, Any]] = field(default_factory=list)
    context: Dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Session":
        return cls(
            id=data["id"],
            state=data.get("state", SESSION_STATE_ACTIVE),
            history=data.get("history", []),
            context=data.get("context", {}),
            created_at=data.get("created_at", time.time()),
            updated_at=data.get("updated_at", time.time()),
        )


class SessionManager:
    """
    Manages user sessions: in-memory map, active session, create/restore, persistence.
    Uses optional SessionStore (from storage abstraction); when None, uses file-based storage.
    """

    def __init__(
        self,
        storage_dir: Optional[Path] = None,
        store: Optional["SessionStore"] = None,
    ) -> None:
        self._storage_dir = Path(storage_dir or SESSION_DIR)
        self._store = store
        self._sessions: Dict[str, Session] = {}
        self._active_session_id: Optional[str] = None
        if self._store is None:
            self._ensure_storage_dir()

    def _ensure_storage_dir(self) -> None:
        self._storage_dir.mkdir(parents=True, exist_ok=True)

    def _session_file(self, session_id: str) -> Path:
        return self._storage_dir / f"{session_id}.json"

    @property
    def sessions(self) -> Dict[str, Session]:
        """All in-memory sessions (id -> Session)."""
        return self._sessions

    @property
    def active_session(self) -> Optional[Session]:
        """Currently active session, or None."""
        if self._active_session_id is None:
            return None
        return self._sessions.get(self._active_session_id)

    def create_session(
        self,
        *,
        context: Optional[Dict[str, Any]] = None,
        load_conversation_history: bool = False,
    ) -> Session:
        """
        Create a new session. Optionally load previous conversation history from storage
        (e.g. last session) into this one; normally starts with empty history.
        """
        session_id = str(uuid.uuid4())
        history: List[Dict[str, Any]] = []
        if load_conversation_history:
            # Optional: load last active session's history as starting point
            last = self._load_latest_from_disk()
            if last:
                history = last.get("history", [])[:50]
        session = Session(
            id=session_id,
            state=SESSION_STATE_ACTIVE,
            history=history,
            context=context or {},
        )
        self._sessions[session_id] = session
        self._active_session_id = session_id
        self.save_session(session)
        return session

    def restore_session(self, session_id: str) -> Optional[Session]:
        """
        Restore a session from storage. Loads from disk if not already in memory.
        Returns the Session or None if not found.
        """
        if session_id in self._sessions:
            self._active_session_id = session_id
            return self._sessions[session_id]
        data = self._load_from_disk(session_id)
        if not data:
            return None
        session = Session.from_dict(data)
        self._sessions[session_id] = session
        self._active_session_id = session_id
        return session

    def set_active_session(self, session_id: str) -> Optional[Session]:
        """Set active session by id. Returns Session if found, else None."""
        if session_id not in self._sessions:
            restored = self.restore_session(session_id)
            return restored
        self._active_session_id = session_id
        return self._sessions[session_id]

    def get_active_session(self) -> Optional[Session]:
        """Return the current active session."""
        return self.active_session

    def record_file_access(self, path: str) -> None:
        """
        Mid-term memory: record a file read for the active session.
        Updates context["recent_files"] (path, access_count, last_accessed); keeps top 100.
        """
        active = self.active_session
        if not active or not path or not path.strip():
            return
        now = time.time()
        recent = list(active.context.get("recent_files") or [])
        path = path.strip()
        found = False
        for f in recent:
            if f.get("path") == path:
                f["access_count"] = f.get("access_count", 0) + 1
                f["last_accessed"] = now
                found = True
                break
        if not found:
            recent.append({"path": path, "access_count": 1, "last_accessed": now})
        recent.sort(key=lambda x: (-x.get("access_count", 0), -x.get("last_accessed", 0)))
        active.context["recent_files"] = recent[:100]

    def save_session(self, session: Session) -> None:
        """Persist a single session (file or cloud via store). Sanitizes sensitive data before storing."""
        session.updated_at = time.time()
        data = session.to_dict()
        try:
            from memory_core import sanitize_for_storage
            data = sanitize_for_storage(data)
        except ImportError:
            pass
        if self._store is not None:
            self._store.put(session.id, data)
            return
        self._ensure_storage_dir()
        path = self._session_file(session.id)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def save_active(self) -> None:
        """Persist the active session to disk."""
        s = self.active_session
        if s:
            self.save_session(s)

    def _load_from_disk(self, session_id: str) -> Optional[Dict[str, Any]]:
        if self._store is not None:
            return self._store.get(session_id)
        path = self._session_file(session_id)
        if not path.exists():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return None

    def _load_latest_from_disk(self) -> Optional[Dict[str, Any]]:
        """Load most recently updated session (for load_conversation_history)."""
        if self._store is not None:
            summaries = self._store.list_summaries(limit=1)
            if not summaries:
                return None
            return self._store.get(summaries[0]["id"])
        self._ensure_storage_dir()
        latest: Optional[Tuple[float, Dict[str, Any]]] = None
        for path in self._storage_dir.glob("*.json"):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                updated = data.get("updated_at", 0)
                if latest is None or updated > latest[0]:
                    latest = (updated, data)
            except (json.JSONDecodeError, OSError):
                continue
        return latest[1] if latest else None

    def list_session_ids(self) -> List[str]:
        """Return session ids from store or disk (and in-memory)."""
        ids = set(self._sessions.keys())
        if self._store is not None:
            ids.update(self._store.list_ids())
        elif self._storage_dir.exists():
            for path in self._storage_dir.glob("*.json"):
                ids.add(path.stem)
        return sorted(ids)

    def list_sessions_summary(self, limit: int = 20) -> List[Dict[str, Any]]:
        """
        Return recent sessions as dicts with {id, updated_at, turns, state}.
        Sorted by updated_at descending, capped to *limit*.
        """
        if self._store is not None:
            return self._store.list_summaries(limit=limit)
        entries: List[Dict[str, Any]] = []
        seen: set = set()

        for sid, session in self._sessions.items():
            entries.append({
                "id": sid,
                "updated_at": session.updated_at,
                "turns": len([m for m in session.history if m.get("role") == "user"]),
                "state": session.state,
            })
            seen.add(sid)

        if self._storage_dir.exists():
            for path in self._storage_dir.glob("*.json"):
                sid = path.stem
                if sid in seen:
                    continue
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    entries.append({
                        "id": sid,
                        "updated_at": data.get("updated_at", 0),
                        "turns": len([m for m in data.get("history", []) if m.get("role") == "user"]),
                        "state": data.get("state", "unknown"),
                    })
                except (json.JSONDecodeError, OSError):
                    continue

        entries.sort(key=lambda e: e["updated_at"], reverse=True)
        return entries[:limit]

    def archive_session(self, session_id: str) -> bool:
        """Mark session as archived; returns True if found."""
        s = self._sessions.get(session_id) or (
            Session.from_dict(d) if (d := self._load_from_disk(session_id)) else None
        )
        if s is None:
            return False
        s.state = SESSION_STATE_ARCHIVED
        self._sessions[session_id] = s
        self.save_session(s)
        if self._active_session_id == session_id:
            self._active_session_id = None
        return True
