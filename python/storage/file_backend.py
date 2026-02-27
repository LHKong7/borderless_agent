"""
File-backed storage: sessions as JSON files, memory as one JSON file, skills from directory, context as JSON per session.
"""

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import WORKDIR
from storage.protocols import StorageBackend

# Default paths (env overrides in config / callers)
DEFAULT_SESSION_DIR = Path(os.environ.get("AGENT_SESSION_DIR", str(WORKDIR / "data" / "sessions")))
DEFAULT_MEMORY_DIR = Path(os.environ.get("AGENT_MEMORY_DIR", str(WORKDIR / "data" / "memory")))
DEFAULT_MEMORY_FILE = DEFAULT_MEMORY_DIR / "memories.json"
DEFAULT_SKILLS_DIR = Path(os.environ.get("AGENT_SKILLS_DIR", str(WORKDIR / "skills")))
DEFAULT_CONTEXT_DIR = Path(os.environ.get("AGENT_CONTEXT_DIR", str(WORKDIR / "data" / "context")))


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _json_read(path: Path) -> Optional[Any]:
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _json_write(path: Path, data: Any) -> None:
    _ensure_dir(path.parent)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


class FileSessionStore:
    def __init__(self, storage_dir: Optional[Path] = None) -> None:
        self._dir = Path(storage_dir or DEFAULT_SESSION_DIR)

    def _path(self, session_id: str) -> Path:
        return self._dir / f"{session_id}.json"

    def get(self, session_id: str) -> Optional[Dict[str, Any]]:
        return _json_read(self._path(session_id))

    def put(self, session_id: str, data: Dict[str, Any]) -> None:
        _ensure_dir(self._dir)
        _json_write(self._path(session_id), data)

    def list_ids(self) -> List[str]:
        ids = set()
        if self._dir.exists():
            for p in self._dir.glob("*.json"):
                ids.add(p.stem)
        return sorted(ids)

    def list_summaries(self, limit: int = 20) -> List[Dict[str, Any]]:
        entries: List[Dict[str, Any]] = []
        seen: set = set()
        if self._dir.exists():
            for path in self._dir.glob("*.json"):
                sid = path.stem
                if sid in seen:
                    continue
                data = _json_read(path)
                if not data:
                    continue
                entries.append({
                    "id": sid,
                    "updated_at": data.get("updated_at", 0),
                    "turns": len([m for m in data.get("history", []) if m.get("role") == "user"]),
                    "state": data.get("state", "active"),
                })
                seen.add(sid)
        entries.sort(key=lambda e: e["updated_at"], reverse=True)
        return entries[:limit]


class FileMemoryStore:
    def __init__(self, memory_file: Optional[Path] = None) -> None:
        self._path = Path(memory_file or DEFAULT_MEMORY_FILE)

    def load(self) -> List[Dict[str, Any]]:
        data = _json_read(self._path)
        return list(data) if isinstance(data, list) else []

    def save(self, items: List[Dict[str, Any]]) -> None:
        _json_write(self._path, items)


class FileSkillStore:
    """Load skills from SKILL.md files under a directory."""

    def __init__(self, skills_dir: Optional[Path] = None) -> None:
        self._dir = Path(skills_dir or DEFAULT_SKILLS_DIR)
        self._cache: Dict[str, Dict[str, Any]] = {}

    def _parse_skill_md(self, path: Path) -> Optional[Dict[str, Any]]:
        if not path.exists():
            return None
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            return None
        match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
        if not match:
            return None
        frontmatter, body = match.groups()
        metadata: Dict[str, str] = {}
        for line in frontmatter.strip().split("\n"):
            if ":" in line:
                key, value = line.split(":", 1)
                metadata[key.strip()] = value.strip().strip("\"'")
        if "name" not in metadata or "description" not in metadata:
            return None
        return {
            "name": metadata["name"],
            "description": metadata["description"],
            "body": body.strip(),
            "path": path,
            "dir": path.parent,
        }

    def list_skills(self) -> List[str]:
        self._cache.clear()
        if not self._dir.exists():
            return []
        out: List[str] = []
        for skill_dir in self._dir.iterdir():
            if not skill_dir.is_dir():
                continue
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue
            skill = self._parse_skill_md(skill_md)
            if skill:
                self._cache[skill["name"]] = skill
                out.append(skill["name"])
        return out

    def get_skill(self, name: str) -> Optional[Dict[str, Any]]:
        if not self._cache and self._dir.exists():
            self.list_skills()
        return self._cache.get(name)


class FileContextStore:
    def __init__(self, context_dir: Optional[Path] = None) -> None:
        self._dir = Path(context_dir or DEFAULT_CONTEXT_DIR)

    def _path(self, session_id: str) -> Path:
        return self._dir / f"{session_id}.json"

    def get(self, session_id: str) -> Optional[Dict[str, Any]]:
        data = _json_read(self._path(session_id))
        return data if isinstance(data, dict) else None

    def set(self, session_id: str, data: Dict[str, Any]) -> None:
        _json_write(self._path(session_id), data)


def create_file_backend(
    session_dir: Optional[Path] = None,
    memory_file: Optional[Path] = None,
    skills_dir: Optional[Path] = None,
    context_dir: Optional[Path] = None,
) -> StorageBackend:
    return StorageBackend(
        session_store=FileSessionStore(session_dir),
        memory_store=FileMemoryStore(memory_file),
        skill_store=FileSkillStore(skills_dir),
        context_store=FileContextStore(context_dir),
    )
