"""ULTRON v14 Sprint 5 Sub-pilar B — Doctor CLI v2.

Inspect the live ULTRON installation and surface drift, orphaned data,
stale caches, retention violations, blocking alerts, and token-overhead
regressions. The doctor only PROPOSES — it never deletes or rewrites
anything unless the user explicitly accepts a fix via ``--fix`` (which
prompts y/N for each finding individually).

DESIGN INVARIANTS
-----------------
1. **Read-mostly.** Default mode (and ``--dry-run``) never writes outside
   ``~/.ultron/.tmp/`` log/state files; the Findings list is computed
   from filesystem inspection only.
2. **Pure stdlib + optional yaml.** Same fallback contract as
   ``skill_manifest.py`` / ``mcp_health_check.py`` — if PyYAML is absent
   we use a tiny line-oriented parser tuned for ``doctor-rules.yaml``.
3. **Silent on --quiet.** Hooks/cron call us with ``--quiet --json``;
   no stdout chatter, only exit codes + the JSON file.
4. **Bounded runtime.** All detections short-circuit at limits (file
   counts, depth) so a clean setup completes in well under 2 seconds even
   when the vault has tens of thousands of entries.
5. **Atomic writes.** Anything we persist (fix log, last-run timestamp)
   uses tmp + flush + fsync + os.replace, mirroring alerts.py /
   mcp_health_check.py.
6. **Subprocess hygiene.** When ``--fix`` runs a command, it's via
   ``silent_exec.silent_run`` — no popup windows on Windows.

EXIT CODES
----------
- 0 : no findings, or only ``info`` findings, or ``--fix`` applied >=1 fix
- 1 : at least one ``warn`` finding (no blockings)
- 2 : at least one ``blocking`` finding

CLI
---
  python doctor.py                    full report
  python doctor.py --fix              interactive per-finding y/N
  python doctor.py --dry-run          alias for default mode
  python doctor.py --json             machine-readable output
  python doctor.py --health-check     compact MCP+ZTMSI+L0 view
  python doctor.py --token-audit      E1 gate: always-on overhead
  python doctor.py --quiet            no stdout, exit code only
"""
from __future__ import annotations

import argparse
import datetime as _dt
import io
import json
import os
import re
import sqlite3
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# Make sibling cockpit modules importable whether invoked via uv, plain
# python, or as a hook child.
_COCKPIT_DIR = Path(__file__).resolve().parent
if str(_COCKPIT_DIR) not in sys.path:
    sys.path.insert(0, str(_COCKPIT_DIR))

from silent_exec import silent_run  # noqa: E402

# alerts and token_budget are best-effort imports — the doctor must still
# produce a partial report if either is unavailable in a fresh checkout.
try:
    import alerts as _alerts  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001 — alerts bus is optional during checks
    _alerts = None  # type: ignore[assignment]

try:
    import token_budget as _token_budget  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001
    _token_budget = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ULTRON_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".ultron"
CLAUDE_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".claude"
SKILL_ROOT = CLAUDE_HOME / "skills" / "ultron"


def _claude_project_slug(path: Path) -> str:
    """Derive the Claude Code project-memory folder name for a given path.

    Claude stores per-project memory under `~/.claude/projects/<slug>/` where
    `<slug>` is the absolute path with path separators replaced by `--`
    (e.g. `C:\\Users\\alice` becomes `C--Users-alice`). This used to be
    hardcoded to one user's profile; we now derive it so the script works on
    any account."""
    s = str(path).replace("\\", "/").rstrip("/")
    # Drive separator: "C:" -> "C-"
    s = s.replace(":", "-")
    # Path separators: "/" -> "-"
    s = s.replace("/", "-")
    # Claude collapses leading `-` runs so e.g. "C-/Users" -> "C--Users".
    # Our transform already yields "C--Users-<user>", which matches.
    return s


ALERTS_FILE = ULTRON_HOME / "alerts.jsonl"
CONTEXT_MD = ULTRON_HOME / ".tmp" / "context.md"
MEMORY_MD = (
    CLAUDE_HOME
    / "projects"
    / _claude_project_slug(Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))))
    / "memory"
    / "MEMORY.md"
)
GLOBAL_CLAUDE_MD = CLAUDE_HOME / "CLAUDE.md"
BRAIN_DB = ULTRON_HOME / "brain_index" / "index.db"
MCP_HEALTH = ULTRON_HOME / ".tmp" / "mcp-health.json"
SETTINGS_JSON = CLAUDE_HOME / "settings.json"
MANIFEST_CACHE = ULTRON_HOME / "manifest.cache.json"
DOCTOR_RULES_YAML = ULTRON_HOME / "config" / "doctor-rules.yaml"
DOCTOR_FIX_LOG = ULTRON_HOME / ".tmp" / "doctor-fix-log.jsonl"
DEADWOOD_JSON = ULTRON_HOME / ".tmp" / "deadwood.json"

# Active-script search roots — the orphan detector greps for filenames
# under these paths to decide whether a top-level child of ~/.ultron/ is
# referenced anywhere. Keep this list short; large recursive scans dwarf
# the actual orphan check.
_REFERENCE_SEARCH_ROOTS = (
    SKILL_ROOT / "scripts" / "cockpit",
    SKILL_ROOT / "hooks",
    ULTRON_HOME / "hooks",
)

# Top-level entries inside ~/.ultron/ that are KNOWN to belong to ULTRON
# even if no script references them by name. Suppresses false positives.
_WELLKNOWN_ULTRON_DIRS = frozenset({
    "brain_index",
    ".tmp",
    "alerts.jsonl",
    "alerts",            # archive subdir
    "backups",
    "config",
    "knowledge",
    "vault",
    "archive",
    "telemetry",
    "cockpit",
    "docs",
    "plans",
    "hooks",
    "memory",
    "projects",
    "sessions",
    "skill_cache",
    "skill_discoveries",
    "ultron-vault",      # if symlinked here
})

# ---------------------------------------------------------------------------
# Defaults (overridden by ~/.ultron/config/doctor-rules.yaml when present)
# ---------------------------------------------------------------------------

_DEFAULT_RULES: dict[str, Any] = {
    "retention": {
        "session_logs_days": 30,
        "backups_days": 90,
        "telemetry_days": 180,
        "alerts_max_size_mb": 10,
    },
    "staleness": {
        "l0_max_hours": 4,
        "ztmsi_max_hours": 4,
    },
    "thresholds": {
        "token_overhead_tokens": 1500,
    },
    "auto_doctor": False,
}

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

SEVERITY_INFO = "info"
SEVERITY_WARN = "warn"
SEVERITY_BLOCKING = "blocking"
_SEVERITY_RANK = {SEVERITY_INFO: 0, SEVERITY_WARN: 1, SEVERITY_BLOCKING: 2}

VALID_CATEGORIES = (
    "orphan",
    "skill_drift",
    "hook_missing",
    "stale",
    "retention",
    "alert",
    "token",
    "integrity",
    "mcp",
    "deadwood",
    "skill_truncation",
    "cache",
    "backup",
)


@dataclass(frozen=True)
class Finding:
    """One issue surfaced by the doctor.

    ``id`` must be stable across runs so callers can dedupe / track fixed
    findings over time. ``fix_command`` is the exact argv silent_run will
    execute when the user accepts the fix (None means "no auto-fix").
    """
    id: str
    category: str
    severity: str
    summary: str
    detail: str
    fix_action: str | None = None
    fix_command: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        # Keep optional fields explicit in JSON output.
        d["fix_action"] = self.fix_action
        d["fix_command"] = list(self.fix_command) if self.fix_command else None
        return d


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    runtime_ms: int = 0

    def add(self, finding: Finding | None) -> None:
        if finding is not None:
            self.findings.append(finding)

    def extend(self, findings: list[Finding]) -> None:
        for f in findings:
            self.add(f)

    def by_severity(self, severity: str) -> list[Finding]:
        return [f for f in self.findings if f.severity == severity]

    def worst_severity(self) -> str | None:
        if not self.findings:
            return None
        return max(self.findings, key=lambda f: _SEVERITY_RANK.get(f.severity, 0)).severity

    def to_dict(self) -> dict[str, Any]:
        return {
            "generated_at": _now_utc_iso(),
            "runtime_ms": int(self.runtime_ms),
            "summary": {
                "total": len(self.findings),
                "info": len(self.by_severity(SEVERITY_INFO)),
                "warn": len(self.by_severity(SEVERITY_WARN)),
                "blocking": len(self.by_severity(SEVERITY_BLOCKING)),
            },
            "findings": [f.to_dict() for f in self.findings],
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_utc_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _atomic_write_text(path: Path, text: str) -> None:
    """Write *text* to *path* atomically (tmp + flush + fsync + os.replace)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        try:
            os.fsync(fh.fileno())
        except OSError:
            # Fsync isn't supported on every filesystem (mocks, FAT32);
            # the in-memory flush above is the realistic guarantee.
            pass
    os.replace(str(tmp), str(path))


def _append_jsonl(path: Path, record: dict[str, Any]) -> None:
    """Append a JSONL record. Idempotent re: parent directory creation."""
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
    # O_APPEND on Windows + POSIX gives single-write atomicity for tiny lines.
    fd = os.open(str(path),
                 os.O_WRONLY | os.O_APPEND | os.O_CREAT
                 | (os.O_BINARY if hasattr(os, "O_BINARY") else 0),
                 0o644)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)


def _file_age_hours(path: Path) -> float | None:
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    return (time.time() - mtime) / 3600.0


def _file_age_days(path: Path) -> float | None:
    h = _file_age_hours(path)
    return None if h is None else h / 24.0


def _path_size_bytes(path: Path) -> int:
    try:
        return int(path.stat().st_size)
    except OSError:
        return 0


def _dir_size_bytes(path: Path, max_files: int = 5000) -> int:
    """Sum the size of files under *path*, bounded to *max_files* entries."""
    total = 0
    seen = 0
    try:
        for child in path.rglob("*"):
            if seen >= max_files:
                break
            try:
                if child.is_file():
                    total += child.stat().st_size
                    seen += 1
            except OSError:
                continue
    except OSError:
        return total
    return total


def _humanize_bytes(n: int) -> str:
    f = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024.0:
            return f"{f:.1f}{unit}"
        f /= 1024.0
    return f"{f:.1f}PB"


# ---------------------------------------------------------------------------
# Rules loader
# ---------------------------------------------------------------------------

def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Merge override into a copy of base — recursive on dict values only."""
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


_RULES_SCALAR_RE = re.compile(r"^([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$")


def _coerce_scalar(value: str) -> Any:
    """Coerce a YAML scalar string to int/float/bool/None/string."""
    v = value.strip()
    if not v:
        return None
    low = v.lower()
    if low == "null" or low == "~":
        return None
    if low == "true":
        return True
    if low == "false":
        return False
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        return v[1:-1]
    try:
        if "." in v:
            return float(v)
        return int(v)
    except ValueError:
        return v


def _parse_rules_yaml_fallback(text: str) -> dict[str, Any]:
    """Tiny stdlib parser tuned for the doctor-rules.yaml schema.

    Only supports the exact shape we ship: a top-level mapping with
    optional nested mappings (one level deep) of scalar values. Indentation
    is two spaces. Lines starting with # are comments.
    """
    out: dict[str, Any] = {}
    current_section: str | None = None
    current_indent = 0
    for raw in text.splitlines():
        line = raw.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            # top-level: either a scalar or a section header
            if stripped.endswith(":"):
                key = stripped[:-1].strip()
                out[key] = {}
                current_section = key
                current_indent = 0
                continue
            m = _RULES_SCALAR_RE.match(stripped)
            if m:
                out[m.group(1)] = _coerce_scalar(m.group(2))
                current_section = None
            continue
        # indented line — must belong to the current section
        if current_section is None:
            continue
        m = _RULES_SCALAR_RE.match(stripped)
        if m:
            section_dict = out.setdefault(current_section, {})
            if isinstance(section_dict, dict):
                section_dict[m.group(1)] = _coerce_scalar(m.group(2))
    return out


def load_rules(path: Path = DOCTOR_RULES_YAML) -> dict[str, Any]:
    """Return the merged rules dict (defaults + user overrides)."""
    if not path.exists():
        return dict(_DEFAULT_RULES)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return dict(_DEFAULT_RULES)
    parsed: dict[str, Any]
    try:
        import yaml  # type: ignore[import-not-found]
        loaded = yaml.safe_load(text)
        parsed = loaded if isinstance(loaded, dict) else {}
    except ImportError:
        parsed = _parse_rules_yaml_fallback(text)
    except Exception:
        # Malformed user YAML — fall back to defaults silently. Doctor's
        # job is to report problems, not crash on its own config.
        parsed = {}
    return _deep_merge(_DEFAULT_RULES, parsed)


# ---------------------------------------------------------------------------
# Detections (each returns list[Finding])
# ---------------------------------------------------------------------------

def _check_orphan_paths(rules: dict[str, Any]) -> list[Finding]:
    """Detection (a): top-level entries inside ~/.ultron/ with no script
    references and either >1MB or >30d old.
    """
    findings: list[Finding] = []
    if not ULTRON_HOME.exists():
        return findings
    try:
        children = list(ULTRON_HOME.iterdir())
    except OSError:
        return findings

    # Build a string blob of every active script's content, lowercased,
    # so the orphan check is one substring search per child.
    blob_parts: list[str] = []
    for root in _REFERENCE_SEARCH_ROOTS:
        if not root.exists():
            continue
        try:
            for f in root.rglob("*"):
                if not f.is_file():
                    continue
                if f.suffix.lower() not in (".py", ".ps1", ".yaml", ".yml", ".json", ".md"):
                    continue
                try:
                    blob_parts.append(f.read_text(encoding="utf-8", errors="ignore").lower())
                except OSError:
                    continue
        except OSError:
            continue
    blob = "\n".join(blob_parts)

    for child in children:
        name = child.name
        if name in _WELLKNOWN_ULTRON_DIRS:
            continue
        # Orphans must be either >1MB OR >30d old.
        size = _path_size_bytes(child) if child.is_file() else _dir_size_bytes(child)
        age_days = _file_age_days(child) or 0.0
        if size <= 1024 * 1024 and age_days <= 30:
            continue
        # Heuristic reference check: is the basename mentioned anywhere
        # in active script directories?
        needle = name.lower()
        if needle and needle in blob:
            continue
        findings.append(Finding(
            id=f"orphan_path:{name}",
            category="orphan",
            severity=SEVERITY_INFO,
            summary=f"Possible orphan path ~/.ultron/{name}",
            detail=(f"Path: {child}\n"
                    f"Size: {_humanize_bytes(size)}\n"
                    f"Age:  {age_days:.1f} days\n"
                    f"No reference found in active scripts."),
            fix_action=None,  # Never auto-delete; user must inspect manually.
            fix_command=None,
        ))
    return findings


def _scan_skill_dirs() -> set[str]:
    """Return the set of skill directory names that contain a SKILL.md."""
    out: set[str] = set()
    skills_root = CLAUDE_HOME / "skills"
    if not skills_root.exists():
        return out
    try:
        for d in skills_root.iterdir():
            if not d.is_dir():
                continue
            if d.name.startswith(".") or d.name == "__pycache__":
                continue
            if (d / "SKILL.md").exists():
                out.add(d.name)
    except OSError:
        return out
    return out


def _load_manifest_names() -> tuple[set[str], set[str]]:
    """Return (active_names, deprecated_names) from manifest.cache.json + YAML.

    The cache.json only contains non-deprecated entries (skill_manifest
    contract). To know about deprecated entries we also peek at the YAML
    via the same fallback path skill_manifest uses.
    """
    active: set[str] = set()
    deprecated: set[str] = set()

    # Cache (active only)
    if MANIFEST_CACHE.exists():
        try:
            cache = json.loads(MANIFEST_CACHE.read_text(encoding="utf-8"))
            for entry in cache.get("skills", []):
                sid = entry.get("id")
                if isinstance(sid, str) and sid:
                    active.add(sid)
        except (OSError, json.JSONDecodeError):
            pass

    # YAML for deprecated entries
    yaml_path = ULTRON_HOME / "skills.manifest.yaml"
    if yaml_path.exists():
        try:
            text = yaml_path.read_text(encoding="utf-8")
        except OSError:
            text = ""
        # Scan for 'name:' and 'deprecated: true' lines as a pair.
        # Robust enough without yaml — entries are emitted block-style.
        cur_name: str | None = None
        cur_dep: bool = False
        for raw in text.splitlines():
            s = raw.strip()
            if s.startswith("- name:"):
                # flush previous
                if cur_name and cur_dep:
                    deprecated.add(cur_name)
                cur_name = s.split(":", 1)[1].strip().strip("'\"")
                cur_dep = False
            elif s.startswith("name:"):
                if cur_name and cur_dep:
                    deprecated.add(cur_name)
                cur_name = s.split(":", 1)[1].strip().strip("'\"")
                cur_dep = False
            elif s.startswith("deprecated:"):
                v = s.split(":", 1)[1].strip().lower()
                cur_dep = (v == "true")
        if cur_name and cur_dep:
            deprecated.add(cur_name)

    return active, deprecated


def _check_skill_drift(rules: dict[str, Any]) -> list[Finding]:
    """Detections (b) and (c): on-disk vs manifest drift."""
    findings: list[Finding] = []
    on_disk = _scan_skill_dirs()
    active, deprecated = _load_manifest_names()
    if not on_disk and not active:
        return findings

    # Wellknown skills (plugin / persona / built-in) won't have a SKILL.md
    # in ~/.claude/skills/. Filter the drift-A check to entries whose name
    # has no namespace prefix (no ':') — those are the candidates for an
    # actual on-disk SKILL.md.
    in_manifest_simple = {n for n in (active | deprecated) if ":" not in n}

    # (b) on disk but not in manifest
    missing_from_manifest = sorted(on_disk - in_manifest_simple)
    for name in missing_from_manifest:
        findings.append(Finding(
            id=f"skill_drift:on-disk-not-manifest:{name}",
            category="skill_drift",
            severity=SEVERITY_WARN,
            summary=f"Skill '{name}' on disk but not in manifest",
            detail=(f"Skill directory: {CLAUDE_HOME / 'skills' / name}\n"
                    f"Run `ultron manifest sync` to register it."),
            fix_action="manifest_sync",
            fix_command=[sys.executable, str(_COCKPIT_DIR / "skill_manifest.py"), "sync"],
        ))

    # (c) in manifest (active, non-deprecated) but not on disk — only for
    # entries that look like a local skill (no namespace prefix).
    in_manifest_local_active = {n for n in active if ":" not in n}
    missing_from_disk = sorted(in_manifest_local_active - on_disk)
    for name in missing_from_disk:
        findings.append(Finding(
            id=f"skill_drift:manifest-not-on-disk:{name}",
            category="skill_drift",
            severity=SEVERITY_WARN,
            summary=f"Skill '{name}' in manifest but not on disk",
            detail=(f"Manifest entry exists but no {CLAUDE_HOME / 'skills' / name / 'SKILL.md'}.\n"
                    f"Run `ultron manifest deprecate {name}` if intentional."),
            fix_action=None,  # User decides whether to deprecate or restore.
            fix_command=None,
        ))
    return findings


def _walk_hook_commands(node: Any, out: list[str]) -> None:
    """Recursively collect every 'command' string from settings.json hooks."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "command" and isinstance(v, str):
                out.append(v)
            else:
                _walk_hook_commands(v, out)
    elif isinstance(node, list):
        for item in node:
            _walk_hook_commands(item, out)


def _extract_script_path(command: str) -> str | None:
    """Extract the .py / .ps1 path from a hooks command string.

    Hooks store the full command line including interpreter, e.g.:
      "C:/.../python.exe C:/.../hook.py"
      "PowerShell -File C:/.../hook.ps1"
    We grab the last token ending in .py or .ps1 (case-insensitive).
    Tokens may be quoted; unwrap matching quotes.
    """
    tokens = command.split()
    for tok in reversed(tokens):
        cleaned = tok.strip().strip('"').strip("'")
        low = cleaned.lower()
        if low.endswith(".py") or low.endswith(".ps1"):
            return cleaned
    return None


def _check_hook_scripts_missing(rules: dict[str, Any]) -> list[Finding]:
    """Detection (d): a hook command references a script that doesn't exist."""
    findings: list[Finding] = []
    if not SETTINGS_JSON.exists():
        return findings
    try:
        data = json.loads(SETTINGS_JSON.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return findings
    hooks = data.get("hooks") if isinstance(data, dict) else None
    if not hooks:
        return findings
    commands: list[str] = []
    _walk_hook_commands(hooks, commands)
    for cmd in commands:
        path_str = _extract_script_path(cmd)
        if not path_str:
            continue
        p = Path(path_str)
        if p.exists():
            continue
        findings.append(Finding(
            id=f"hook_missing:{path_str}",
            category="hook_missing",
            severity=SEVERITY_BLOCKING,
            summary=f"Hook references missing script: {p.name}",
            detail=(f"settings.json hook command: {cmd}\n"
                    f"Resolved path: {p}\n"
                    f"This hook will fail on every fire."),
            fix_action=None,  # User must edit settings.json or restore the script.
            fix_command=None,
        ))
    return findings


def _check_l0_stale(rules: dict[str, Any]) -> list[Finding]:
    """Detection (e): context.md older than rules.staleness.l0_max_hours."""
    if not CONTEXT_MD.exists():
        return [Finding(
            id="stale:l0:missing",
            category="stale",
            severity=SEVERITY_WARN,
            summary="L0 context.md is missing",
            detail=(f"Expected: {CONTEXT_MD}\n"
                    f"Run context_primer.py generate to recreate."),
            fix_action="regen_context",
            fix_command=[sys.executable, str(_COCKPIT_DIR / "context_primer.py"), "generate"],
        )]
    age_h = _file_age_hours(CONTEXT_MD) or 0.0
    limit = float(rules.get("staleness", {}).get("l0_max_hours", 4))
    if age_h <= limit:
        return []
    return [Finding(
        id="stale:l0",
        category="stale",
        severity=SEVERITY_WARN,
        summary=f"L0 context.md is {age_h:.1f}h old (limit {limit}h)",
        detail=f"Path: {CONTEXT_MD}\nRun context_primer.py generate to refresh.",
        fix_action="regen_context",
        fix_command=[sys.executable, str(_COCKPIT_DIR / "context_primer.py"), "generate"],
    )]


def _check_ztmsi_stale(rules: dict[str, Any]) -> list[Finding]:
    """Detection (f): brain index DB older than rules.staleness.ztmsi_max_hours."""
    if not BRAIN_DB.exists():
        return [Finding(
            id="stale:ztmsi:missing",
            category="stale",
            severity=SEVERITY_INFO,
            summary="Brain index database is missing",
            detail=(f"Expected: {BRAIN_DB}\n"
                    f"Run brain_index.py build to create it."),
            fix_action="rebuild_index",
            fix_command=[sys.executable, str(_COCKPIT_DIR / "brain_index.py"), "build"],
        )]
    age_h = _file_age_hours(BRAIN_DB) or 0.0
    limit = float(rules.get("staleness", {}).get("ztmsi_max_hours", 4))
    if age_h <= limit:
        return []
    return [Finding(
        id="stale:ztmsi",
        category="stale",
        severity=SEVERITY_INFO,
        summary=f"Brain index is {age_h:.1f}h old (limit {limit}h)",
        detail=f"Path: {BRAIN_DB}\nRun brain_index.py update for incremental refresh.",
        fix_action="update_index",
        fix_command=[sys.executable, str(_COCKPIT_DIR / "brain_index.py"), "update"],
    )]


def _check_session_logs(rules: dict[str, Any]) -> list[Finding]:
    """Detection (g): session log files older than retention.session_logs_days."""
    days = int(rules.get("retention", {}).get("session_logs_days", 30))
    cutoff = time.time() - days * 86400
    candidates: list[Path] = []
    total_size = 0

    auto_dir = Path.home() / ".ultron-vault" / "50_SESSIONS_LOG"
    if auto_dir.exists():
        try:
            for f in auto_dir.glob("auto-*.md"):
                try:
                    if f.stat().st_mtime < cutoff:
                        candidates.append(f)
                        total_size += f.stat().st_size
                except OSError:
                    continue
        except OSError:
            pass

    cc_projects = CLAUDE_HOME / "projects"
    if cc_projects.exists():
        try:
            for f in cc_projects.glob("*/sessions/*.jsonl"):
                try:
                    if f.stat().st_mtime < cutoff:
                        candidates.append(f)
                        total_size += f.stat().st_size
                except OSError:
                    continue
        except OSError:
            pass

    if not candidates:
        return []
    return [Finding(
        id=f"retention:session_logs:>{days}d",
        category="retention",
        severity=SEVERITY_INFO,
        summary=f"{len(candidates)} session log(s) older than {days}d",
        detail=(f"Total size: {_humanize_bytes(total_size)}\n"
                f"Examples:\n  " +
                "\n  ".join(str(p) for p in candidates[:5]) +
                ("\n  ..." if len(candidates) > 5 else "")),
        fix_action=None,  # User decides archival policy.
        fix_command=None,
    )]


def _check_backup_snapshots(rules: dict[str, Any]) -> list[Finding]:
    """Detection (h): backup snapshots older than retention.backups_days."""
    days = int(rules.get("retention", {}).get("backups_days", 90))
    cutoff = time.time() - days * 86400
    backups_dir = ULTRON_HOME / "backups"
    if not backups_dir.exists():
        return []
    old_dirs: list[Path] = []
    try:
        for d in backups_dir.iterdir():
            if not d.is_dir():
                continue
            try:
                if d.stat().st_mtime < cutoff:
                    old_dirs.append(d)
            except OSError:
                continue
    except OSError:
        return []
    if not old_dirs:
        return []
    return [Finding(
        id=f"retention:backups:>{days}d",
        category="retention",
        severity=SEVERITY_INFO,
        summary=f"{len(old_dirs)} backup snapshot(s) older than {days}d",
        detail=("Examples:\n  " +
                "\n  ".join(str(p) for p in old_dirs[:5]) +
                ("\n  ..." if len(old_dirs) > 5 else "")),
        fix_action=None,
        fix_command=None,
    )]


def _check_telemetry(rules: dict[str, Any]) -> list[Finding]:
    """Detection (i): telemetry JSONL files older than retention.telemetry_days."""
    days = int(rules.get("retention", {}).get("telemetry_days", 180))
    cutoff = time.time() - days * 86400
    tele_dir = ULTRON_HOME / "telemetry"
    if not tele_dir.exists():
        return []
    old_files: list[Path] = []
    total = 0
    try:
        for f in tele_dir.rglob("*.jsonl"):
            try:
                st = f.stat()
                if st.st_mtime < cutoff:
                    old_files.append(f)
                    total += st.st_size
            except OSError:
                continue
    except OSError:
        return []
    if not old_files:
        return []
    return [Finding(
        id=f"retention:telemetry:>{days}d",
        category="retention",
        severity=SEVERITY_INFO,
        summary=f"{len(old_files)} telemetry file(s) older than {days}d",
        detail=(f"Total size: {_humanize_bytes(total)}\n"
                f"Examples:\n  " +
                "\n  ".join(str(p) for p in old_files[:5]) +
                ("\n  ..." if len(old_files) > 5 else "")),
        fix_action=None,
        fix_command=None,
    )]


def _check_unacked_blocking_alerts(rules: dict[str, Any]) -> list[Finding]:
    """Detection (j): unacked blocking alerts >24h old."""
    if _alerts is None:
        return []
    try:
        unacked = _alerts.read_unacked(severity_min="blocking")
    except Exception:  # noqa: BLE001
        return []
    if not unacked:
        return []
    cutoff = (_dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
              - _dt.timedelta(hours=24))
    cutoff_iso = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
    old = [r for r in unacked
           if isinstance(r.get("ts"), str) and r["ts"] < cutoff_iso]
    if not old:
        return []
    examples = "\n  ".join(
        f"{r.get('id','?')} [{r.get('source','?')}] {r.get('message','')[:80]}"
        for r in old[:5]
    )
    return [Finding(
        id="alert:unacked_blocking_24h",
        category="alert",
        severity=SEVERITY_WARN,
        summary=f"{len(old)} blocking alert(s) unacked >24h",
        detail=f"Examples:\n  {examples}",
        fix_action=None,  # Acking is a deliberate user action.
        fix_command=None,
    )]


def _check_alerts_file_size(rules: dict[str, Any]) -> list[Finding]:
    """Detection (k): alerts.jsonl size > retention.alerts_max_size_mb."""
    if not ALERTS_FILE.exists():
        return []
    max_mb = float(rules.get("retention", {}).get("alerts_max_size_mb", 10))
    size = _path_size_bytes(ALERTS_FILE)
    if size <= max_mb * 1024 * 1024:
        return []
    return [Finding(
        id="retention:alerts_size",
        category="retention",
        severity=SEVERITY_WARN,
        summary=f"alerts.jsonl is {_humanize_bytes(size)} (limit {max_mb}MB)",
        detail=(f"Path: {ALERTS_FILE}\n"
                f"Run `ultron alerts purge --older-than 30d` to archive."),
        fix_action="purge_alerts",
        fix_command=[sys.executable, str(_COCKPIT_DIR / "alerts.py"),
                     "purge", "--older-than", "30d"],
    )]


def measure_token_overhead() -> tuple[int, dict[str, int]]:
    """Sum tokens for the always-on context: context.md + MEMORY.md + global CLAUDE.md.

    Returns (total_tokens, per-source mapping). Falls back to a manual
    chars/4 estimate if token_budget isn't importable.
    """
    parts: dict[str, int] = {}
    for label, path in (("context.md", CONTEXT_MD),
                        ("MEMORY.md", MEMORY_MD),
                        ("global CLAUDE.md", GLOBAL_CLAUDE_MD)):
        if not path.exists():
            parts[label] = 0
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            parts[label] = 0
            continue
        if _token_budget is not None:
            parts[label] = _token_budget.measure(text)
        else:
            parts[label] = len(text) // 4
    return sum(parts.values()), parts


def _check_token_overhead(rules: dict[str, Any]) -> list[Finding]:
    """Detection (l): combined always-on context > thresholds.token_overhead_tokens."""
    limit = int(rules.get("thresholds", {}).get("token_overhead_tokens", 1500))
    total, parts = measure_token_overhead()
    if total <= limit:
        return []
    breakdown = "\n  ".join(f"{name}: {tok} tok" for name, tok in parts.items())
    return [Finding(
        id="token:overhead",
        category="token",
        severity=SEVERITY_WARN,
        summary=f"Always-on token overhead {total} tok > limit {limit} tok",
        detail=f"Breakdown:\n  {breakdown}\n"
               f"Trim context.md or MEMORY.md to bring total under the limit.",
        fix_action=None,
        fix_command=None,
    )]


def _check_mcp_health(rules: dict[str, Any]) -> list[Finding]:
    """Detection (m): mcp-health.json shows degraded/missing entries with
    severity warn+ in mcp-fallbacks.yaml.
    """
    if not MCP_HEALTH.exists():
        return []
    try:
        data = json.loads(MCP_HEALTH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    results = data.get("results", {}) if isinstance(data, dict) else {}
    if not isinstance(results, dict):
        return []
    bad = {k: v for k, v in results.items() if v in ("degraded", "missing")}
    if not bad:
        return []
    # Read fallbacks for severity classification.
    fallbacks_path = ULTRON_HOME / "config" / "mcp-fallbacks.yaml"
    severities: dict[str, str] = {}
    if fallbacks_path.exists():
        try:
            text = fallbacks_path.read_text(encoding="utf-8")
        except OSError:
            text = ""
        cur_name: str | None = None
        for raw in text.splitlines():
            s = raw.strip()
            if s.startswith("- mcp_name:"):
                cur_name = s.split(":", 1)[1].strip().strip("'\"")
            elif cur_name and s.startswith("alert_severity:"):
                sev = s.split(":", 1)[1].strip().strip("'\"").lower()
                severities[cur_name] = sev
    findings: list[Finding] = []
    for name, status in sorted(bad.items()):
        sev_label = severities.get(name, "info")
        # Bubble up only warn/blocking entries — info MCPs (e.g. nice-to-have
        # search providers) are surfaced via the alerts bus already.
        if sev_label not in ("warn", "blocking"):
            continue
        findings.append(Finding(
            id=f"mcp:{name}:{status}",
            category="mcp",
            severity=SEVERITY_WARN if sev_label == "warn" else SEVERITY_BLOCKING,
            summary=f"MCP '{name}' status={status} (fallback severity={sev_label})",
            detail=(f"Last check: {data.get('checked_at','?')}\n"
                    f"Run `ultron mcp health` for live re-probe."),
            fix_action="reprobe_mcp",
            fix_command=[sys.executable, str(_COCKPIT_DIR / "mcp_health_check.py"),
                         "--quiet"],
        ))
    return findings


# ---------------------------------------------------------------------------
# S5-C Security detectors (N, O, P, Q)
# ---------------------------------------------------------------------------

def _check_skill_provenance_drift(rules: dict[str, Any]) -> list[Finding]:
    """Detection (N): provenance drift / missing records / missing skills."""
    try:
        import skill_provenance as _provenance  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        return []
    try:
        prov_findings = _provenance.verify_integrity()
    except Exception as exc:  # noqa: BLE001
        return [Finding(
            id="security:provenance_error",
            category="integrity",
            severity=SEVERITY_WARN,
            summary=f"skill_provenance.verify_integrity crashed: {type(exc).__name__}",
            detail=f"Exception: {exc!r}",
        )]
    out: list[Finding] = []
    for f in prov_findings:
        sev = SEVERITY_WARN if f.severity == "warn" else SEVERITY_BLOCKING
        # Drift findings auto-repair via `skill_provenance.py record <skill>`.
        # missing_skill / missing_record require human judgment (delete vs reinstall).
        is_drift = f.finding_type == "drift"
        out.append(Finding(
            id=f"security:provenance:{f.finding_type}:{f.skill_name}",
            category="integrity",
            severity=sev,
            summary=f"Skill provenance — {f.finding_type} on '{f.skill_name}'",
            detail=f.detail,
            fix_action="provenance_record" if is_drift else None,
            fix_command=[sys.executable,
                         str(_COCKPIT_DIR / "skill_provenance.py"),
                         "record", f.skill_name] if is_drift else None,
        ))
    return out


def _check_settings_integrity(rules: dict[str, Any]) -> list[Finding]:
    """Detection (O): settings.json drift vs last authorized snapshot."""
    try:
        import settings_integrity as _si  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        return []
    try:
        findings = _si.verify()
    except Exception as exc:  # noqa: BLE001
        return [Finding(
            id="security:settings_integrity_error",
            category="integrity",
            severity=SEVERITY_WARN,
            summary=f"settings_integrity.verify crashed: {type(exc).__name__}",
            detail=f"Exception: {exc!r}",
        )]
    out: list[Finding] = []
    for f in findings:
        sev = {"info": SEVERITY_INFO, "warn": SEVERITY_WARN,
               "blocking": SEVERITY_BLOCKING}.get(f.severity, SEVERITY_INFO)
        out.append(Finding(
            id=f"security:settings:{f.finding_type}",
            category="integrity",
            severity=sev,
            summary=f"settings.json drift — {f.finding_type}",
            detail=f.detail,
            fix_action="settings_snapshot" if sev == SEVERITY_WARN else None,
            fix_command=[sys.executable,
                         str(_COCKPIT_DIR / "settings_integrity.py"),
                         "snapshot", "--trigger", "auto"]
                        if sev == SEVERITY_WARN else None,
        ))
    return out


def _check_secrets_in_state(rules: dict[str, Any]) -> list[Finding]:
    """Detection (P): secrets in config/logs."""
    try:
        import secrets_scanner as _ss  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        return []
    try:
        findings = _ss.scan_paths()
    except Exception as exc:  # noqa: BLE001
        return [Finding(
            id="security:secrets_scanner_error",
            category="integrity",
            severity=SEVERITY_WARN,
            summary=f"secrets_scanner crashed: {type(exc).__name__}",
            detail=f"Exception: {exc!r}",
        )]
    out: list[Finding] = []
    for f in findings:
        sev = SEVERITY_BLOCKING if f.severity == "blocking" else SEVERITY_WARN
        out.append(Finding(
            id=f"security:secret:{f.rule_id}:{Path(f.path).name}:{f.line_number}",
            category="integrity",
            severity=sev,
            summary=f"Possible secret ({f.label}) in {Path(f.path).name}",
            detail=(f"path: {f.path}:{f.line_number}\n"
                    f"excerpt: {f.excerpt}\n"
                    f"Rotate the credential and remove it from the file."),
            fix_action=None,
            fix_command=None,
        ))
    return out


def _check_skill_security_scans(rules: dict[str, Any]) -> list[Finding]:
    """Detection (Q): installed skills failing security scan."""
    try:
        import skill_sync_security as _sss  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        return []
    try:
        verdicts = _sss.scan_all_installed()
    except Exception as exc:  # noqa: BLE001
        return [Finding(
            id="security:skill_scan_error",
            category="integrity",
            severity=SEVERITY_WARN,
            summary=f"skill_sync_security crashed: {type(exc).__name__}",
            detail=f"Exception: {exc!r}",
        )]
    out: list[Finding] = []
    for v in verdicts:
        if v.decision == "allow":
            continue
        sev_map = {"warn": SEVERITY_WARN, "quarantine": SEVERITY_WARN,
                   "block": SEVERITY_BLOCKING}
        sev = sev_map.get(v.decision, SEVERITY_WARN)
        skill_name = Path(v.skill_path).name
        finding_lines = [
            f"path: {v.skill_path}",
            f"decision: {v.decision} (confidence={v.confidence})",
            f"findings: {len(v.findings)}",
        ]
        for f in v.findings[:5]:
            ln = f.line_number if f.line_number is not None else "?"
            # F06: surface waiver info in detail so the user understands
            # why a decision was downgraded.
            waived_tag = ""
            if getattr(f, "waived", False):
                reason = getattr(f, "waived_reason", "") or ""
                waived_tag = f"  [WAIVED: {reason}]" if reason else "  [WAIVED]"
            finding_lines.append(f"  [{f.severity}] {f.rule_id} "
                                  f"{f.pattern_name} line={ln}{waived_tag}")
        if len(v.findings) > 5:
            finding_lines.append(f"  ... and {len(v.findings) - 5} more")
        out.append(Finding(
            id=f"security:skill_scan:{skill_name}",
            category="integrity",
            severity=sev,
            summary=f"Skill '{skill_name}' security scan: {v.decision}",
            detail="\n".join(finding_lines),
            fix_action=None,
            fix_command=None,
        ))
    return out


_SECURITY_DETECTORS = (
    _check_skill_provenance_drift,
    _check_settings_integrity,
    _check_secrets_in_state,
    _check_skill_security_scans,
)


def _check_deadwood(rules: dict[str, Any]) -> list[Finding]:
    """Detection (D17): surface findings from deadwood_scanner.py.

    Reads ~/.ultron/.tmp/deadwood.json (atomic JSON sidecar produced by
    `deadwood_scanner --json`). Behaviour:

    - Missing or unreadable -> ONE info finding suggesting a fresh scan.
    - Stale (mtime older than rules.staleness.deadwood_max_hours,
      default 24h) -> ONE info finding suggesting a refresh.
    - Fresh: emit one BLOCKING finding per blocking entry (capped at 5
      surfaced individually; remainder folded into one summary), plus
      ONE aggregate WARN when there are non-blocking warnings. INFO
      findings from the scanner are not surfaced — they are the
      canonical record kept in the audit report itself.
    """
    rebuild_cmd = [sys.executable,
                   str(_COCKPIT_DIR / "deadwood_scanner.py"),
                   "--json", "--report", "--quiet"]

    if not DEADWOOD_JSON.exists():
        return [Finding(
            id="deadwood:missing",
            category="deadwood",
            severity=SEVERITY_INFO,
            summary="Deadwood scan has never been run",
            detail=(f"Expected: {DEADWOOD_JSON}\n"
                    "Run deadwood_scanner.py --json --report to populate."),
            fix_action="rebuild_deadwood",
            fix_command=rebuild_cmd,
        )]

    age_h = _file_age_hours(DEADWOOD_JSON) or 0.0
    # L2: clock skew can make a freshly-written file look future-dated.
    # Don't print "-3.0h old" — clamp the display to 0 and treat as fresh.
    age_h = max(0.0, age_h)
    limit = float(rules.get("staleness", {}).get("deadwood_max_hours", 24))
    if age_h > limit:
        return [Finding(
            id="deadwood:stale",
            category="deadwood",
            severity=SEVERITY_INFO,
            summary=f"Deadwood scan is {age_h:.1f}h old (limit {limit}h)",
            detail=f"Path: {DEADWOOD_JSON}\nRefresh with deadwood_scanner.",
            fix_action="rebuild_deadwood",
            fix_command=rebuild_cmd,
        )]

    try:
        raw = json.loads(DEADWOOD_JSON.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [Finding(
            id="deadwood:unreadable",
            category="deadwood",
            severity=SEVERITY_WARN,
            summary="Deadwood JSON sidecar is unreadable",
            detail=f"Path: {DEADWOOD_JSON}\nError: {exc!r}",
            fix_action="rebuild_deadwood",
            fix_command=rebuild_cmd,
        )]

    if not isinstance(raw, list):
        return [Finding(
            id="deadwood:malformed",
            category="deadwood",
            severity=SEVERITY_WARN,
            summary="Deadwood JSON sidecar has unexpected shape",
            detail=f"Expected list, got {type(raw).__name__}.",
            fix_action="rebuild_deadwood",
            fix_command=rebuild_cmd,
        )]

    blockings = [f for f in raw if isinstance(f, dict)
                 and f.get("severity") == "blocking"]
    warnings = [f for f in raw if isinstance(f, dict)
                and f.get("severity") == "warn"]

    findings: list[Finding] = []
    SURFACE_LIMIT = 5
    for entry in blockings[:SURFACE_LIMIT]:
        try:
            rel = str(Path(entry.get("file", "?"))
                      .relative_to(Path.home()))
        except (ValueError, TypeError):
            rel = str(entry.get("file", "?"))
        line_start = entry.get("line_start", 0)
        pattern = entry.get("pattern", "?")
        findings.append(Finding(
            id=f"deadwood:blocking:{rel}:L{line_start}:{pattern}",
            category="deadwood",
            severity=SEVERITY_BLOCKING,
            summary=f"Deadwood blocking: {pattern} at {rel}:L{line_start}",
            detail=(entry.get("snippet", "")
                    + f"\nFields: {entry.get('fields', {})}"),
            fix_action="review_deadwood_block",
            fix_command=None,
        ))
    if len(blockings) > SURFACE_LIMIT:
        findings.append(Finding(
            id="deadwood:blocking:overflow",
            category="deadwood",
            severity=SEVERITY_BLOCKING,
            summary=(f"+{len(blockings) - SURFACE_LIMIT} more blocking "
                     f"deadwood findings"),
            detail="See ~/.ultron/audits/deadwood-baseline.md for full list.",
            fix_action=None,
            fix_command=None,
        ))

    if warnings:
        findings.append(Finding(
            id="deadwood:warn:summary",
            category="deadwood",
            severity=SEVERITY_WARN,
            summary=f"Deadwood: {len(warnings)} warn-level finding(s)",
            detail=("Top patterns: "
                    + ", ".join(sorted({w.get("pattern", "?")
                                         for w in warnings}))
                    + "\nSee ~/.ultron/audits/deadwood-baseline.md."),
            fix_action=None,
            fix_command=None,
        ))

    return findings


def _count_skills_on_disk() -> dict[str, int]:
    """Walk skill directories and bucket SKILL.md hits by namespace.

    Returns a dict with keys ``root``, ``plugin``, ``bundle``, ``total``.
    Cheap I/O — short-circuits on missing roots so a stripped install
    still produces a partial-but-useful number.
    """
    home = Path.home()
    root_dir = home / ".claude" / "skills"
    plugin_dir = home / ".claude" / "plugins"
    counts = {"root": 0, "plugin": 0, "bundle": 0}

    if root_dir.exists():
        for skill_md in root_dir.rglob("SKILL.md"):
            try:
                rel = skill_md.relative_to(root_dir)
            except ValueError:
                continue
            depth = len(rel.parts) - 1
            counts["bundle" if depth >= 2 else "root"] += 1

    if plugin_dir.exists():
        for skill_md in plugin_dir.rglob("SKILL.md"):
            # L4: marketplaces/ vs cache/ duplicate the same SKILL.md.
            # Skip cache/ so the count reflects the active install.
            if "cache" in skill_md.parts:
                continue
            counts["plugin"] += 1

    counts["total"] = counts["root"] + counts["plugin"] + counts["bundle"]
    return counts


def _check_skill_truncation(rules: dict[str, Any]) -> list[Finding]:
    """Detection (D18): warn when the skill catalog is large enough that
    the Claude Code harness will truncate descriptions in the system
    prompt under the configured ``skillListingBudgetFraction``.

    The harness rule of thumb: at the default 1% fraction, roughly
    120 skills get full descriptions before truncation kicks in. Beyond
    that, intent-routing by description silently degrades. The detector
    emits a single WARN with the catalog breakdown and a pointer to the
    audit recommendations doc.
    """
    threshold = int(rules.get("thresholds", {})
                          .get("skill_truncation_warn_at", 200))
    counts = _count_skills_on_disk()
    if counts["total"] <= threshold:
        return []
    return [Finding(
        id="skill_truncation:over_threshold",
        category="skill_truncation",
        severity=SEVERITY_WARN,
        summary=(f"Skill catalog ({counts['total']}) exceeds truncation "
                 f"threshold ({threshold})"),
        detail=(
            f"Counts: root={counts['root']}, "
            f"plugin={counts['plugin']}, bundle={counts['bundle']}.\n"
            "Harness drops descriptions for skills beyond the "
            "skillListingBudgetFraction window (default 1% of context). "
            "Names remain visible; intent-by-description degrades.\n"
            "Mitigation options + recommended actions in "
            "~/.ultron/audits/skill-truncation-2026-05-07.md."
        ),
        fix_action="review_skill_truncation",
        fix_command=None,
    )]


def _check_token_block_budgets(rules: dict[str, Any]) -> list[Finding]:
    """Detection D22 (v14.4 P5): per-block tokens vs token_baseline DEFAULT_BUDGETS.

    Warns when any of context_md / MEMORY_md / claude_md_global / skill_listing
    blocks exceeds its declared soft budget. Read-only; never blocking.
    """
    try:
        sys.path.insert(0, str(_COCKPIT_DIR))
        import token_baseline as tb
    except Exception as exc:
        return [Finding(
            id="cache:token_baseline_unavailable",
            category="token",
            severity=SEVERITY_INFO,
            summary=f"D22 skipped: token_baseline import failed ({exc!r})",
            detail="Install dependencies via `uv pip install tiktoken`.",
        )]
    try:
        measurements = tb.measure_session_start()
    except Exception as exc:
        return [Finding(
            id="cache:token_baseline_error",
            category="token",
            severity=SEVERITY_INFO,
            summary=f"D22 skipped: measurement failed ({exc!r})",
            detail="Run `uv run python scripts/cockpit/token_baseline.py snapshot` for diagnostics.",
        )]
    budgets = tb.DEFAULT_BUDGETS
    findings: list[Finding] = []
    for block in measurements:
        name = block.get("name")
        tokens = int(block.get("tokens") or 0)
        budget = budgets.get(name)
        if budget is None or tokens <= budget:
            continue
        over = tokens - budget
        findings.append(Finding(
            id=f"token:budget:{name}",
            category="token",
            severity=SEVERITY_WARN,
            summary=f"D22 {name} {tokens} tok > soft budget {budget} (+{over})",
            detail=(
                f"Block {name} exceeds its DEFAULT_BUDGETS limit by {over} tok. "
                f"For MEMORY.md/context.md/CLAUDE.md run `uv run python "
                f"scripts/cockpit/memory_dedupe.py status` then `dryrun`. "
                f"For skill_listing run `skill_lazy_loader.py status` and consider "
                f"lowering top_n."
            ),
            fix_action=None,
            fix_command=None,
        ))
    return findings


def _check_cache_hit_rate(rules: dict[str, Any]) -> list[Finding]:
    """Detection D24 (v14.4 P5): prompt cache hit rate over the recent window.

    Wraps `cache_telemetry.detector_status()`. Tri-level verdict:
      pass         → no finding
      warn         → SEVERITY_WARN
      blocking     → SEVERITY_BLOCKING
      insufficient → SEVERITY_INFO (no signal)
    """
    try:
        sys.path.insert(0, str(_COCKPIT_DIR))
        import cache_telemetry as ct
    except Exception as exc:
        return [Finding(
            id="cache:telemetry_unavailable",
            category="cache",
            severity=SEVERITY_INFO,
            summary=f"D24 skipped: cache_telemetry import failed ({exc!r})",
            detail="cache_telemetry.py landed in v14.4 P2; verify scripts/cockpit/.",
        )]
    try:
        status = ct.detector_status()
    except Exception as exc:
        return [Finding(
            id="cache:telemetry_error",
            category="cache",
            severity=SEVERITY_INFO,
            summary=f"D24 skipped: telemetry compute failed ({exc!r})",
            detail="Run `uv run python scripts/cockpit/cache_telemetry.py budget` to debug.",
        )]
    verdict = status.get("verdict", "insufficient")
    if verdict == "pass":
        return []
    severity_map = {
        "warn": SEVERITY_WARN,
        "blocking": SEVERITY_BLOCKING,
        "insufficient": SEVERITY_INFO,
    }
    severity = severity_map.get(verdict, SEVERITY_INFO)
    return [Finding(
        id=f"cache:hit_rate:{verdict}",
        category="cache",
        severity=severity,
        summary=(
            f"D24 cache hit rate {status.get('hit_rate', 0)*100:.1f}% "
            f"over {status.get('turns_observed', 0)} turns "
            f"({status.get('window_days', 14)}d) — verdict {verdict}"
        ),
        detail=(
            "Hit rate is computed from ~/.claude/projects/<encoded>/<session>.jsonl "
            "transcripts. Drop typically signals churn in MEMORY.md or context.md "
            "(run `memory_dedupe.py dryrun`) or recent skill listing changes (run "
            "`skill_lazy_loader.py status`)."
        ),
        fix_action=None,
        fix_command=None,
    )]


def _check_backup_freshness(rules: dict[str, Any]) -> list[Finding]:
    """Detection D25 (v14.7 BACKUP-WATCH): warn when last weekly backup is stale.

    Reads ~/.ultron/.tmp/backup-last-run.json (written by weekly-backup.ps1).
    WARN if last_run > 7d, BLOCKING if > 30d (data at risk).
    """
    status_file = Path.home() / ".ultron" / ".tmp" / "backup-last-run.json"
    if not status_file.exists():
        return [Finding(
            id="backup:never_run",
            category="backup",
            severity=SEVERITY_INFO,
            summary="D25 weekly backup has never run",
            detail=(
                "Run `~/.ultron/scripts/backup/weekly-backup.ps1` manually or "
                "register the ONLOGON Task Scheduler entry. Spec at "
                "~/.claude/projects/.../memory/project_weekly_backup.md."
            ),
        )]
    try:
        data = json.loads(status_file.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return [Finding(
            id="backup:status_unreadable",
            category="backup",
            severity=SEVERITY_INFO,
            summary=f"D25 backup status file unreadable ({exc!r})",
            detail=str(status_file),
        )]
    last_run_raw = data.get("last_run")
    try:
        from datetime import datetime as _dt
        last = _dt.fromisoformat(str(last_run_raw))
        if last.tzinfo is None:
            from datetime import timezone as _tz
            last = last.replace(tzinfo=_tz.utc)
    except (TypeError, ValueError):
        return [Finding(
            id="backup:status_malformed",
            category="backup",
            severity=SEVERITY_INFO,
            summary="D25 backup status has unparseable last_run",
            detail=f"last_run={last_run_raw!r}",
        )]
    from datetime import datetime as _dt2, timezone as _tz2, timedelta as _td
    age = _dt2.now(_tz2.utc) - last
    if age <= _td(days=7):
        return []
    severity = SEVERITY_BLOCKING if age > _td(days=30) else SEVERITY_WARN
    return [Finding(
        id=f"backup:stale:{int(age.days)}d",
        category="backup",
        severity=severity,
        summary=f"D25 weekly backup is {age.days}d old (>7d threshold)",
        detail=(
            f"Last backup: {last_run_raw}. Run "
            f"`~/.ultron/scripts/backup/weekly-backup.ps1` or check Task "
            f"Scheduler entry. >30d is blocking — your data is at risk."
        ),
    )]


_ALL_DETECTORS = (
    _check_orphan_paths,
    _check_skill_drift,
    _check_hook_scripts_missing,
    _check_l0_stale,
    _check_ztmsi_stale,
    _check_session_logs,
    _check_backup_snapshots,
    _check_telemetry,
    _check_unacked_blocking_alerts,
    _check_alerts_file_size,
    _check_token_overhead,
    _check_token_block_budgets,
    _check_cache_hit_rate,
    _check_backup_freshness,
    _check_mcp_health,
    _check_deadwood,
    _check_skill_truncation,
) + _SECURITY_DETECTORS


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def run_all_detections(rules: dict[str, Any] | None = None,
                        detectors: tuple = _ALL_DETECTORS) -> Report:
    """Run every detector in `detectors` (default: all) and return a ``Report``."""
    if rules is None:
        rules = load_rules()
    rep = Report()
    t0 = time.perf_counter()
    for det in detectors:
        try:
            rep.extend(det(rules))
        except Exception as exc:  # noqa: BLE001 — one detector should not crash the run
            rep.add(Finding(
                id=f"integrity:detector_error:{det.__name__}",
                category="integrity",
                severity=SEVERITY_WARN,
                summary=f"Detector {det.__name__} crashed: {type(exc).__name__}",
                detail=f"Exception: {exc!r}",
                fix_action=None,
                fix_command=None,
            ))
    rep.runtime_ms = int((time.perf_counter() - t0) * 1000)
    return rep


# ---------------------------------------------------------------------------
# Output formatters
# ---------------------------------------------------------------------------

def format_human(report: Report) -> str:
    """Pretty multi-line human report. ASCII only — Windows cp1252 safe."""
    buf = io.StringIO()
    buf.write("ULTRON DOCTOR REPORT\n")
    buf.write("====================\n")
    buf.write(f"generated: {_now_utc_iso()}\n")
    buf.write(f"runtime:   {report.runtime_ms} ms\n")
    n = len(report.findings)
    nb = len(report.by_severity(SEVERITY_BLOCKING))
    nw = len(report.by_severity(SEVERITY_WARN))
    ni = len(report.by_severity(SEVERITY_INFO))
    buf.write(f"summary:   {n} finding(s) "
              f"(blocking={nb} warn={nw} info={ni})\n\n")
    if not report.findings:
        buf.write("OK -- no findings.\n")
        return buf.getvalue()
    # Group by severity for readability (blocking first).
    for sev in (SEVERITY_BLOCKING, SEVERITY_WARN, SEVERITY_INFO):
        items = report.by_severity(sev)
        if not items:
            continue
        buf.write(f"[{sev.upper()}] ({len(items)})\n")
        buf.write("-" * 80 + "\n")
        for f in items:
            buf.write(f"  - id:       {f.id}\n")
            buf.write(f"    category: {f.category}\n")
            buf.write(f"    summary:  {f.summary}\n")
            for line in f.detail.splitlines():
                buf.write(f"    | {line}\n")
            if f.fix_action:
                buf.write(f"    fix:      {f.fix_action}\n")
            buf.write("\n")
    return buf.getvalue()


def format_health_check(report: Report) -> str:
    """Compact health view: MCP + ZTMSI + L0 status."""
    buf = io.StringIO()
    buf.write("ULTRON HEALTH CHECK\n")
    buf.write("===================\n")
    # MCP
    mcp_findings = [f for f in report.findings if f.category == "mcp"]
    if not mcp_findings:
        buf.write("  MCP servers : OK\n")
    else:
        buf.write(f"  MCP servers : {len(mcp_findings)} issue(s)\n")
        for f in mcp_findings:
            buf.write(f"    - {f.summary}\n")
    # ZTMSI
    z_findings = [f for f in report.findings if f.id.startswith("stale:ztmsi")]
    if not z_findings:
        buf.write("  Brain index : OK\n")
    else:
        buf.write(f"  Brain index : {z_findings[0].summary}\n")
    # L0
    l0_findings = [f for f in report.findings if f.id.startswith("stale:l0")]
    if not l0_findings:
        buf.write("  L0 context  : OK\n")
    else:
        buf.write(f"  L0 context  : {l0_findings[0].summary}\n")
    return buf.getvalue()


def format_token_audit() -> str:
    """E1 gate output: always-on overhead vs limit."""
    buf = io.StringIO()
    rules = load_rules()
    limit = int(rules.get("thresholds", {}).get("token_overhead_tokens", 1500))
    total, parts = measure_token_overhead()
    buf.write("ULTRON TOKEN AUDIT (E1)\n")
    buf.write("=======================\n")
    for name, tok in parts.items():
        buf.write(f"  {name:<24} {tok:>6} tok\n")
    buf.write(f"  {'-'*32}\n")
    buf.write(f"  {'TOTAL':<24} {total:>6} tok\n")
    buf.write(f"  {'LIMIT':<24} {limit:>6} tok\n")
    status = "PASS" if total <= limit else "FAIL"
    buf.write(f"  {'STATUS':<24} {status:>6}\n")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# --fix workflow
# ---------------------------------------------------------------------------

def _confirm(prompt: str) -> bool:
    """Read a y/N answer from stdin. Default N. EOF/KeyboardInterrupt → N."""
    try:
        ans = input(prompt).strip().lower()
    except (EOFError, KeyboardInterrupt):
        return False
    return ans in ("y", "yes")


def _gate_fix_invocation(yes_flag: bool) -> bool:
    """F08 fix: TTY gate for --fix. Refuses to run without --yes when
    stdin is piped (non-interactive). Returns True iff fixes may proceed.

    The --yes flag MUST be explicit on the command line — never read from
    env vars or config files — so an attacker who can write to settings
    cannot bypass the interactive prompt.
    """
    if not sys.stdin.isatty():
        if not yes_flag:
            print("[doctor --fix] requires interactive terminal or "
                  "explicit --yes flag", file=sys.stderr)
            return False
    return True


def apply_fixes_interactively(report: Report, *,
                                stdout: Any = None,
                                yes_all: bool = False) -> int:
    """Walk every Finding with a non-None fix_command, prompt y/N, run if y.

    Returns the count of fixes actually applied. Each accepted fix is
    appended to ~/.ultron/.tmp/doctor-fix-log.jsonl.
    """
    if stdout is None:
        stdout = sys.stdout
    applied = 0
    for f in report.findings:
        if not f.fix_command:
            continue
        print(f"\n[{f.severity.upper()}] {f.summary}", file=stdout)
        for line in f.detail.splitlines():
            print(f"  {line}", file=stdout)
        cmd_str = " ".join(str(t) for t in f.fix_command)
        print(f"  Proposed fix ({f.fix_action}):\n    {cmd_str}", file=stdout)
        # F08: when --yes is passed in non-interactive mode, accept all.
        if yes_all:
            print("  --yes provided, accepting fix.", file=stdout)
        elif not _confirm("  Apply this fix? [y/N]: "):
            print("  Skipped.", file=stdout)
            continue
        rc = _run_fix(f)
        applied += 1 if rc == 0 else 0
        _append_jsonl(DOCTOR_FIX_LOG, {
            "ts": _now_utc_iso(),
            "finding_id": f.id,
            "fix_action": f.fix_action,
            "fix_command": list(f.fix_command),
            "exit_code": rc,
        })
        print(f"  -> exit={rc}", file=stdout)
    return applied


def _run_fix(f: Finding) -> int:
    """Execute a Finding.fix_command via silent_run and return its exit code."""
    if not f.fix_command:
        return 0
    try:
        proc = silent_run(list(f.fix_command), timeout=120)
        return int(proc.returncode)
    except Exception:  # noqa: BLE001
        return -1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _exit_code_for(report: Report) -> int:
    worst = report.worst_severity()
    if worst == SEVERITY_BLOCKING:
        return 2
    if worst == SEVERITY_WARN:
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="doctor.py",
        description="ULTRON doctor — inspect installation, surface drift/staleness/retention.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--fix", action="store_true",
                      help="Interactive per-finding fix prompts (y/N each).")
    mode.add_argument("--dry-run", action="store_true",
                      help="Report only, never write (default behavior).")
    mode.add_argument("--health-check", action="store_true",
                      help="Compact view of MCP + ZTMSI + L0 staleness.")
    mode.add_argument("--token-audit", action="store_true",
                      help="E1 gate: always-on token overhead.")
    mode.add_argument("--security", action="store_true",
                      help="S5-C: only run security detectors (provenance, "
                           "settings drift, secrets, skill scans).")

    parser.add_argument("--json", action="store_true",
                        help="Print JSON report (overrides human format).")
    parser.add_argument("--quiet", action="store_true",
                        help="Suppress all stdout (exit code only).")
    parser.add_argument("--rules", type=str, default=None,
                        help="Path to alternate doctor-rules.yaml (default: ~/.ultron/config/doctor-rules.yaml)")
    # F08 fix: explicit non-interactive opt-in for --fix. Must be passed
    # on the command line — NEVER read from env vars or config files.
    parser.add_argument("--yes", action="store_true",
                        help="Accept every proposed fix (only for non-interactive --fix invocations).")

    args = parser.parse_args(argv)

    rules_path = Path(args.rules) if args.rules else DOCTOR_RULES_YAML
    rules = load_rules(rules_path)

    # --token-audit doesn't run all detectors, just the token measure.
    if args.token_audit:
        if args.json:
            total, parts = measure_token_overhead()
            limit = int(rules.get("thresholds", {}).get("token_overhead_tokens", 1500))
            payload = {"total": total, "limit": limit, "parts": parts,
                       "status": "pass" if total <= limit else "fail"}
            if not args.quiet:
                print(json.dumps(payload, ensure_ascii=False, indent=2))
            return 0 if total <= limit else 1
        if not args.quiet:
            print(format_token_audit(), end="")
        total, _ = measure_token_overhead()
        limit = int(rules.get("thresholds", {}).get("token_overhead_tokens", 1500))
        return 0 if total <= limit else 1

    if args.security:
        report = run_all_detections(rules, detectors=_SECURITY_DETECTORS)
        if args.json:
            if not args.quiet:
                print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        elif not args.quiet:
            print(format_human(report), end="")
        return _exit_code_for(report)

    report = run_all_detections(rules)

    if args.health_check:
        if args.json:
            if not args.quiet:
                payload = {
                    "generated_at": _now_utc_iso(),
                    "mcp": [f.to_dict() for f in report.findings if f.category == "mcp"],
                    "ztmsi": [f.to_dict() for f in report.findings
                              if f.id.startswith("stale:ztmsi")],
                    "l0": [f.to_dict() for f in report.findings
                           if f.id.startswith("stale:l0")],
                }
                print(json.dumps(payload, ensure_ascii=False, indent=2))
        elif not args.quiet:
            print(format_health_check(report), end="")
        # E4 fix: exit code reflects only health-check-relevant findings (MCP,
        # ZTMSI, L0 staleness). A degraded MCP with a wired fallback exits 1
        # (warn), not 2 (blocking) — other detector issues don't block this gate.
        hc_findings = [
            f for f in report.findings
            if f.category == "mcp"
            or f.id.startswith("stale:ztmsi")
            or f.id.startswith("stale:l0")
        ]
        return _exit_code_for(Report(findings=hc_findings))

    if args.fix:
        # F08 fix: TTY gate. Refuses non-interactive runs unless --yes
        # is on the command line.
        if not _gate_fix_invocation(args.yes):
            return 2
        # Apply fixes interactively. Even in --quiet we keep stderr/stdin
        # (would not make sense to suppress confirmation prompts).
        applied = apply_fixes_interactively(report, yes_all=args.yes)
        if applied > 0:
            return 0
        return _exit_code_for(report)

    if args.json:
        if not args.quiet:
            print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        else:
            # --quiet --json still emits something useful: write to a
            # well-known file so the caller can pick it up.
            try:
                _atomic_write_text(
                    ULTRON_HOME / ".tmp" / "doctor-weekly.json",
                    json.dumps(report.to_dict(), ensure_ascii=False, indent=2),
                )
            except OSError:
                pass
    elif not args.quiet:
        print(format_human(report), end="")

    return _exit_code_for(report)


if __name__ == "__main__":
    raise SystemExit(main())
