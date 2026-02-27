"""
Storage abstraction: file and cloud backends for Session, Memory, Skill, Context.

Usage:
  - Backend selection: set AGENT_STORAGE_BACKEND=file (default) or cloud.
  - File: uses AGENT_SESSION_DIR, AGENT_MEMORY_DIR, AGENT_SKILLS_DIR, AGENT_CONTEXT_DIR.
  - Cloud (S3-compatible): set AGENT_STORAGE_BUCKET; optional AGENT_S3_ENDPOINT, AGENT_STORAGE_REGION;
    credentials via AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or IAM.

  get_storage_backend() returns the backend for the current config.
  SessionManager, memory_core, skills_core accept optional store args; when omitted they use
  the default backend from get_storage_backend().
"""

import os
from pathlib import Path
from typing import Optional

from storage.protocols import (
    ContextStore,
    MemoryStore,
    SessionStore,
    SkillStore,
    StorageBackend,
)

_default_backend: Optional[StorageBackend] = None


def get_storage_backend(
    backend: Optional[str] = None,
    session_dir: Optional[Path] = None,
    memory_file: Optional[Path] = None,
    skills_dir: Optional[Path] = None,
    context_dir: Optional[Path] = None,
) -> StorageBackend:
    """
    Return storage backend. backend defaults to AGENT_STORAGE_BACKEND env ('file' or 'cloud').
    For 'file', optional dir/path overrides; for 'cloud', env AGENT_STORAGE_BUCKET etc. are used.
    """
    global _default_backend
    choice = (backend or os.environ.get("AGENT_STORAGE_BACKEND", "file")).strip().lower()
    if choice == "cloud":
        from storage.cloud_backend import create_cloud_backend
        _default_backend = create_cloud_backend()
    else:
        from storage.file_backend import create_file_backend
        _default_backend = create_file_backend(
            session_dir=session_dir,
            memory_file=memory_file,
            skills_dir=skills_dir,
            context_dir=context_dir,
        )
    return _default_backend


def get_default_session_store() -> SessionStore:
    """Session store from default backend (file if not set)."""
    global _default_backend
    if _default_backend is None:
        get_storage_backend()
    assert _default_backend is not None
    return _default_backend.session_store


def get_default_memory_store() -> MemoryStore:
    """Memory store from default backend."""
    global _default_backend
    if _default_backend is None:
        get_storage_backend()
    assert _default_backend is not None
    return _default_backend.memory_store


def get_default_skill_store() -> SkillStore:
    """Skill store from default backend."""
    global _default_backend
    if _default_backend is None:
        get_storage_backend()
    assert _default_backend is not None
    return _default_backend.skill_store


def get_default_context_store() -> ContextStore:
    """Context store from default backend."""
    global _default_backend
    if _default_backend is None:
        get_storage_backend()
    assert _default_backend is not None
    return _default_backend.context_store


__all__ = [
    "StorageBackend",
    "SessionStore",
    "MemoryStore",
    "SkillStore",
    "ContextStore",
    "get_storage_backend",
    "get_default_session_store",
    "get_default_memory_store",
    "get_default_skill_store",
    "get_default_context_store",
]
