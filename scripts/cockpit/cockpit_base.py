"""
ULTRON v12.2 Cockpit — Shared utilities for all cockpit scripts.

Provides:
- Path constants (single source of truth for cockpit dirs/files)
- Project dataclass (matches projects.json schema)
- Cockpit class (atomic JSON IO with backup, retention helpers)
- IDE detection heuristic (with explicit overrides from USER)

Used by: scan_projects.py · launch_project.py · ai_standup.py · retention.py · etc.
"""
from __future__ import annotations

import json
import shutil
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional


# ── Paths (single source of truth) ────────────────────────────────────────────

USER_HOME = Path.home()
COCKPIT_DIR = USER_HOME / ".ultron" / "cockpit"
ULTRON_SKILL_ROOT = USER_HOME / ".claude" / "skills" / "ultron"


def read_ultron_version() -> str:
    """SSOT for ULTRON version — parses `version:` field from SKILL.md frontmatter.
    Returns 'v?.?.?' if frontmatter unreadable so the TUI never crashes."""
    skill_md = ULTRON_SKILL_ROOT / "SKILL.md"
    try:
        with skill_md.open("r", encoding="utf-8") as f:
            in_frontmatter = False
            for line in f:
                stripped = line.strip()
                if stripped == "---":
                    if in_frontmatter:
                        break
                    in_frontmatter = True
                    continue
                if in_frontmatter and stripped.startswith("version:"):
                    return stripped.split(":", 1)[1].strip()
    except OSError:
        pass
    return "v?.?.?"

# Data files
PROJECTS_JSON = COCKPIT_DIR / "projects.json"
IDE_MAPPINGS_JSON = COCKPIT_DIR / "ide-mappings.json"
DEADLINES_JSON = COCKPIT_DIR / "deadlines.json"
# News
NEWS_DIR = COCKPIT_DIR / "news"
NEWS_ALERTS = NEWS_DIR / "ALERTS.md"
NEWS_ALERTS_ARCHIVE = NEWS_DIR / "ALERTS.archive.md"
NEWS_ALERTS_TTL_DAYS = 7
NEWS_SEEN = NEWS_DIR / "seen.json"

# Scan roots (where scanner looks for projects)
CARRERA_ROOT = USER_HOME / "CARRERA"
SCAN_ROOTS = [
    CARRERA_ROOT / "ASIGNATURAS",
    CARRERA_ROOT / "PROYECTOS_PERSONALES",
    CARRERA_ROOT / "proyectos",
    USER_HOME / ".claude" / "skills",  # ULTRON workspace
]

# Skills under ~/.claude/skills/ are NOT projects by default — they're skills.
# Only these whitelisted skill-IDs survive scanning as project entries (because
# they have actual code/scripts that warrant opening in an IDE). To add: append
# the slug. Personalidades + skills de apoyo NO entran aquí.
SKILLS_PROJECT_WHITELIST = {"ultron"}

# Skip patterns (don't recurse into these)
SKIP_DIR_NAMES = {
    "node_modules", ".cache", ".gradle", ".idea", ".vs", ".vscode",
    "dist", "build", "out", "target", "__pycache__", "venv", ".venv",
    "Library", "Temp", "Logs",  # Unity-generated
    "Intermediate", "Saved", "DerivedDataCache",  # UE5-generated
    "cmake-build-debug", "cmake-build-release",  # CLion
    ".gradle",  # Android
    "Pods", "DerivedData",  # iOS
    ".clone",    # git worktrees inside ~/.claude/skills/ — avoids detecting
    "worktrees", # worktree copies as duplicate projects
}

# Project marker files (any of these → it's a project root)
PROJECT_MARKERS = [
    "*.uproject",       # Unreal Engine
    "*.sln",            # Visual Studio solution
    "*.csproj",         # .NET project
    "*.vcxproj",        # Visual C++ project
    "package.json",     # Node.js / web
    "Cargo.toml",       # Rust
    "build.gradle",     # Android / Java
    "build.gradle.kts", # Android Kotlin
    "settings.gradle.kts",
    "pyproject.toml",   # Python modern
    "setup.py",         # Python legacy
    "go.mod",           # Go
    "Podfile",          # iOS
    "CMakeLists.txt",   # CMake
    "SKILL.md",         # ULTRON skills
]


# ── Project schema ────────────────────────────────────────────────────────────

@dataclass
class Project:
    """Single project entry in projects.json. Matches the JSON schema."""
    id: str                         # slug (kebab-case)
    name: str                       # human-friendly
    path: str                       # absolute path
    ide: str                        # Rider, VSCode, Webstorm, AndroidStudio, VisualStudio
    language: str                   # primary language
    type: str                       # game, web, mobile, academic, skill, library
    deadline: Optional[str] = None  # ISO date or null
    last_active: Optional[str] = None  # ISO date (most recent file mtime)
    status: str = "active"          # active, archived, auto-detected, paused
    tags: list = field(default_factory=list)      # MANUAL tags (user-owned, scanner never touches)
    auto_tags: list = field(default_factory=list) # AUTO tags (scanner-owned, refreshed every scan)


# ── Cockpit class — atomic JSON IO with backup ────────────────────────────────

class Cockpit:
    """Atomic, backup-aware reader/writer for cockpit JSON files."""

    @staticmethod
    def ensure_dirs():
        """Create all cockpit directories if missing."""
        COCKPIT_DIR.mkdir(parents=True, exist_ok=True)
        NEWS_DIR.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def read_json(path: Path, default=None):
        """Read JSON, return default if missing or invalid.

        Uses utf-8-sig to silently strip a UTF-8 BOM if present (PowerShell
        Set-Content -Encoding UTF8 always writes one in PS 5.1)."""
        if not path.exists():
            return default if default is not None else {}
        try:
            return json.loads(path.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, ValueError) as e:
            print(f"[cockpit] WARNING: {path.name} invalid JSON: {e}")
            return default if default is not None else {}

    @staticmethod
    def write_json(path: Path, data, *, backup: bool = True):
        """Write JSON atomically. Optionally back up the previous file (.bak)."""
        Cockpit.ensure_dirs()
        if backup and path.exists():
            shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))

        # Atomic write: write to temp, rename (POSIX rename is atomic; Windows is best-effort)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(data, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )
        tmp.replace(path)

    @staticmethod
    def append_jsonl(path: Path, entry: dict):
        """Append one line to a JSONL file."""
        Cockpit.ensure_dirs()
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    @staticmethod
    def rotate_jsonl(path: Path, *, retention_days: int = 30):
        """Drop entries older than retention_days from a JSONL file. Atomic via temp."""
        if not path.exists():
            return
        cutoff = datetime.now() - timedelta(days=retention_days)
        kept = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                ts = datetime.fromisoformat(entry.get("ts", ""))
                if ts >= cutoff:
                    kept.append(line)
            except (json.JSONDecodeError, ValueError):
                continue  # skip malformed lines
        tmp = path.with_suffix(".jsonl.tmp")
        tmp.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
        tmp.replace(path)


# ── IDE detection (with USER's explicit overrides) ─────────────────────────

# Path-pattern → IDE rules. Order matters (first match wins).
# USER's explicit preferences from his answer:
#   UE5/C++ games → Rider
#   Unity/C# games → UnityHub
#   Web → Webstorm
#   OrbitalDB → AndroidStudio
#   Resto + Python → Visual Studio / VSCode
IDE_RULES = [
    # Game engines (highest specificity)
    {"contains": "Unreal Engine",       "ide": "Rider",     "lang": "C++", "type": "game"},
    {"glob_in_path": "*.uproject",      "ide": "Rider",     "lang": "C++", "type": "game"},
    {"has_dir": "Assets/Scenes",        "ide": "UnityHub",  "lang": "C#",  "type": "game"},  # Unity
    {"has_file": "ProjectSettings/ProjectVersion.txt", "ide": "UnityHub", "lang": "C#", "type": "game"},  # Unity
    {"name_eq": "Unity IA_Template",    "ide": "UnityHub",  "lang": "C#",  "type": "game"},

    # Mobile
    {"name_eq": "OrbitalDB",            "ide": "AndroidStudio", "lang": "Kotlin", "type": "mobile"},
    {"has_file": "build.gradle.kts",    "ide": "AndroidStudio", "lang": "Kotlin", "type": "mobile"},
    {"has_file": "build.gradle",        "ide": "AndroidStudio", "lang": "Java",   "type": "mobile"},
    {"has_file": "Podfile",             "ide": "Xcode",         "lang": "Swift",  "type": "mobile"},

    # Web (Webstorm preferred per USER)
    {"has_file_with_dep": ("package.json", ["next", "react", "vue", "svelte", "astro", "nuxt"]),
        "ide": "Webstorm", "lang": "TypeScript", "type": "web"},
    {"has_file": "package.json",        "ide": "Webstorm", "lang": "JavaScript", "type": "web"},

    # Native / systems (CLion before VisualStudio — CMakeLists.txt is the primary CLion marker)
    {"has_file": "CMakeLists.txt",      "ide": "CLion",        "lang": "C++", "type": "native"},
    {"has_file": "*.sln",               "ide": "VisualStudio", "lang": "C++", "type": "native"},
    {"has_file": "*.vcxproj",           "ide": "VisualStudio", "lang": "C++", "type": "native"},
    {"has_file": "Cargo.toml",          "ide": "VSCode",       "lang": "Rust", "type": "native"},
    {"has_file": "go.mod",              "ide": "VSCode",       "lang": "Go", "type": "native"},

    # Python
    {"has_file": "pyproject.toml",      "ide": "VSCode", "lang": "Python", "type": "library"},
    {"has_file": "setup.py",            "ide": "VSCode", "lang": "Python", "type": "library"},

    # ULTRON skills (markdown-driven)
    {"has_file": "SKILL.md",            "ide": "VSCode", "lang": "Markdown", "type": "skill"},
]


def detect_ide(path: Path, project_name: str = "") -> tuple[str, str, str]:
    """Returns (ide, language, type) for a given project path.

    Default fallback: VSCode / unknown / library.
    """
    path_str = str(path)

    for rule in IDE_RULES:
        # name_eq: exact project name match (USER's overrides)
        if "name_eq" in rule and project_name == rule["name_eq"]:
            return rule["ide"], rule["lang"], rule["type"]

        # contains: substring in full path
        if "contains" in rule and rule["contains"] in path_str:
            return rule["ide"], rule["lang"], rule["type"]

        # has_file: file exists at project root (supports glob)
        if "has_file" in rule:
            pattern = rule["has_file"]
            if "*" in pattern:
                if list(path.glob(pattern)):
                    return rule["ide"], rule["lang"], rule["type"]
            elif (path / pattern).exists():
                return rule["ide"], rule["lang"], rule["type"]

        # has_dir: directory exists at project root
        if "has_dir" in rule and (path / rule["has_dir"]).is_dir():
            return rule["ide"], rule["lang"], rule["type"]

        # glob_in_path: pattern matches anywhere in subtree (used for *.uproject)
        if "glob_in_path" in rule:
            if list(path.rglob(rule["glob_in_path"])):
                return rule["ide"], rule["lang"], rule["type"]

        # has_file_with_dep: file exists AND has specific dependency (web heuristic)
        if "has_file_with_dep" in rule:
            fname, deps_to_check = rule["has_file_with_dep"]
            fpath = path / fname
            if fpath.exists():
                try:
                    pkg = json.loads(fpath.read_text(encoding="utf-8"))
                    all_deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
                    if any(d in all_deps for d in deps_to_check):
                        return rule["ide"], rule["lang"], rule["type"]
                except (json.JSONDecodeError, OSError):
                    pass

    return "VSCode", "unknown", "library"


def slug(name: str) -> str:
    """Convert project name to kebab-case slug."""
    import re
    s = re.sub(r"[^\w\s-]", "", name).strip().lower()
    return re.sub(r"[-\s]+", "-", s)
