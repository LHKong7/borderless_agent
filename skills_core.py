"""
skills_core.py - Skill loading and management.

Storage: uses optional SkillStore (from storage abstraction) when provided;
otherwise loads from skills_dir (file-based). File remains default.
"""

import re
from pathlib import Path
from typing import Any, Dict, List, Optional, TYPE_CHECKING

from config import SKILLS_DIR

if TYPE_CHECKING:
    from storage.protocols import SkillStore


class SkillLoader:
    """
    Loads and manages skills from SKILL.md files or from a SkillStore.

    A skill is a FOLDER containing:
    - SKILL.md (required): YAML frontmatter + markdown instructions
    - scripts/ (optional): Helper scripts the model can run
    - references/ (optional): Additional documentation
    - assets/ (optional): Templates, files for output

    When store is provided, list_skills / get_descriptions / get_skill_content use the store;
    otherwise they use the file tree under skills_dir.
    """

    def __init__(
        self,
        skills_dir: Optional[Path] = None,
        store: Optional["SkillStore"] = None,
    ) -> None:
        self.skills_dir = Path(skills_dir or SKILLS_DIR)
        self._store = store
        self.skills: Dict[str, Dict[str, Any]] = {}
        if self._store is None:
            self.load_skills()

    def set_store(self, store: Optional["SkillStore"]) -> None:
        """Switch to a different store (e.g. from get_storage_backend()). Clears file cache when using store."""
        self._store = store
        if store is not None:
            self.skills.clear()
        else:
            self.load_skills()

    def parse_skill_md(self, path: Path) -> Dict[str, Any] | None:
        """
        Parse a SKILL.md file into metadata and body.

        Returns dict with: name, description, body, path, dir
        Returns None if file doesn't match format.
        """
        content = path.read_text()

        # Match YAML frontmatter between --- markers
        match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
        if not match:
            return None

        frontmatter, body = match.groups()

        # Parse YAML-like frontmatter (simple key: value)
        metadata: Dict[str, str] = {}
        for line in frontmatter.strip().split("\n"):
            if ":" in line:
                key, value = line.split(":", 1)
                metadata[key.strip()] = value.strip().strip("\"'")

        # Require name and description
        if "name" not in metadata or "description" not in metadata:
            return None

        return {
            "name": metadata["name"],
            "description": metadata["description"],
            "body": body.strip(),
            "path": path,
            "dir": path.parent,
        }

    def load_skills(self) -> None:
        """
        Scan skills directory and load all valid SKILL.md files.

        Only loads metadata at startup - body is loaded on-demand.
        This keeps the initial context lean.
        """
        if not self.skills_dir.exists():
            return

        for skill_dir in self.skills_dir.iterdir():
            if not skill_dir.is_dir():
                continue

            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue

            skill = self.parse_skill_md(skill_md)
            if skill:
                self.skills[skill["name"]] = skill

    def get_descriptions(self) -> str:
        """
        Generate skill descriptions for system prompt.
        """
        if self._store is not None:
            names = self._store.list_skills()
            if not names:
                return "(no skills available)"
            lines = []
            for name in names:
                skill = self._store.get_skill(name)
                desc = (skill.get("description", "")) if skill else ""
                lines.append(f"- {name}: {desc}")
            return "\n".join(lines)
        if not self.skills:
            return "(no skills available)"
        return "\n".join(
            f"- {name}: {skill['description']}"
            for name, skill in self.skills.items()
        )

    def get_skill_content(self, name: str) -> Optional[str]:
        """
        Get full skill content for injection.
        """
        if self._store is not None:
            skill = self._store.get_skill(name)
            if not skill:
                return None
            content = f"# Skill: {skill['name']}\n\n{skill.get('body', '')}"
            # Resource hints: from store dict (e.g. "resources" list) or "dir" Path
            resources: List[str] = []
            if "resources" in skill and isinstance(skill["resources"], list):
                resources = [str(r) for r in skill["resources"]]
            elif "dir" in skill:
                try:
                    dir_path = Path(skill["dir"]) if not isinstance(skill["dir"], Path) else skill["dir"]
                    for folder, label in [
                        ("scripts", "Scripts"),
                        ("references", "References"),
                        ("assets", "Assets"),
                    ]:
                        folder_path = dir_path / folder
                        if folder_path.exists():
                            files = list(folder_path.glob("*"))
                            if files:
                                resources.append(f"{label}: {', '.join(f.name for f in files)}")
                except (TypeError, OSError):
                    pass
            if resources:
                content += "\n\n**Available resources:**\n"
                content += "\n".join(f"- {r}" for r in resources)
            return content

        if name not in self.skills:
            return None
        skill = self.skills[name]
        content = f"# Skill: {skill['name']}\n\n{skill['body']}"
        resources = []
        for folder, label in [
            ("scripts", "Scripts"),
            ("references", "References"),
            ("assets", "Assets"),
        ]:
            folder_path = skill["dir"] / folder
            if folder_path.exists():
                files = list(folder_path.glob("*"))
                if files:
                    resources.append(f"{label}: {', '.join(f.name for f in files)}")
        if resources:
            content += f"\n\n**Available resources in {skill['dir']}:**\n"
            content += "\n".join(f"- {r}" for r in resources)
        return content

    def list_skills(self) -> List[str]:
        """Return list of available skill names."""
        if self._store is not None:
            return self._store.list_skills()
        return list(self.skills.keys())


# Global skill loader instance
SKILLS = SkillLoader(SKILLS_DIR)

