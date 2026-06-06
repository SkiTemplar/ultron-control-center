"""doctor_checks — all detection functions for ULTRON Doctor.

Each ``_check_*`` function accepts a rules dict (from ``doctor_rules.load_rules``)
and returns ``list[Finding]``. None of them write anything outside
``~/.ultron/.tmp/`` and only when an auto-fix is explicitly invoked.

The module-level tuples ``_SECURITY_DETECTORS`` and ``_ALL_DETECTORS``
are the canonical registries consumed by ``doctor_core.run_all_detections``.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime as _datetime
from datetime import timedelta as _timedelta
from datetime import timezone as _timezone
from pathlib import Path
from typing import Any

# Locate the cockpit directory so sibling imports work when the module is
# loaded directly (hooks, uv run, etc.).
_COCKPIT_DIR = Path(__file__).resolve().parent
if str(_COCKPIT_DIR) not in sys.path:
    sys.path.insert(0, str(_COCKPIT_DIR))

from doctor_models import (  # noqa: E402
    SEVERITY_BLOCKING,
    SEVERITY_INFO,
    SEVERITY_WARN,
    Finding,
    _file_age_days,
    _file_age_hours,
    _humanize_bytes,
    _path_size_bytes,
    _dir_size_bytes,
)

# Optional bus / token helpers — doctor must work without them.
try:
    import alerts as _alerts  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001
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

ALERTS_FILE = ULTRON_HOME / "alerts.jsonl"
CONTEXT_MD = ULTRON_HOME / ".tmp" / "context.md"
BRAIN_DB = ULTRON_HOME / "brain_index" / "index.db"
MCP_HEALTH = ULTRON_HOME / ".tmp" / "mcp-health.json"
SETTINGS_JSON = CLAUDE_HOME / "settings.json"
MANIFEST_CACHE = ULTRON_HOME / "manifest.cache.json"
DEADWOOD_JSON = ULTRON_HOME / ".tmp" / "deadwood.json"

_MEMORY_MD: Path | None = None


def _get_memory_md() -> Path:
    """Derive the project-specific MEMORY.md path (lazy, computed once)."""
    global _MEMORY_MD
    if _MEMORY_MD is None:
        home = Path(os.environ.get("USERPROFILE", os.path.expanduser("~")))
        slug = str(home).replace("\\", "/").rstrip("/").replace(":", "-").replace("/", "-")
        _MEMORY_MD = CLAUDE_HOME / "projects" / slug / "memory" / "MEMORY.md"
    return _MEMORY_MD


_GLOBAL_CLAUDE_MD = CLAUDE_HOME / "CLAUDE.md"

_REFERENCE_SEARCH_ROOTS = (
    SKILL_ROOT / "scripts" / "cockpit",
    SKILL_ROOT / "hooks",
    ULTRON_HOME / "hooks",
)

_WELLKNOWN_ULTRON_DIRS = frozenset({
    "brain_index",
    ".tmp",
    "alerts.jsonl",
    "alerts",
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
    "ultron-vault",
})

# ---------------------------------------------------------------------------
# Detection (a): orphan paths
# ---------------------------------------------------------------------------


def _check_orphan_paths(rules: dict[str, Any]) -> list[Finding]:
    """Top-level entries inside ~/.ultron/ with no script references and
    either >1MB or >30d old.
    """
    findings: list[Finding] = []
    if not ULTRON_HOME.exists():
        return findings
    try:
        children = list(ULTRON_HOME.iterdir())
    except OSError:
        return findings

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
        size = _path_size_bytes(child) if child.is_file() else _dir_size_bytes(child)
        age_days = _file_age_days(child) or 0.0
        if size <= 1024 * 1024 and age_days <= 30:
            continue
        needle = name.lower()
        if needle and needle in blob:
            continue
        findings.append(Finding(
            id=f"orphan_path:{name}",
            category="orphan",
            severity=SEVERITY_INFO,
            summary=f"Possible orphan path ~/.ultron/{name}",
            detail=(
                f"Path: {child}\n"
                f"Size: {_humanize_bytes(size)}\n"
                f"Age:  {age_days:.1f} days\n"
                f"No reference found in active scripts."
            ),
            fix_action=None,
            fix_command=None,
        ))
    return findings


# ---------------------------------------------------------------------------
# Detection (a2): empty directories and orphan files >30d without references
# ---------------------------------------------------------------------------


def _check_empty_dirs_and_orphan_files(rules: dict[str, Any]) -> list[Finding]:
    """Detect empty directories and loose files >30d old with no script references.

    Scans one level of depth inside ~/.ultron/ (excluding well-known dirs and
    hidden/temp paths). Reports as SEVERITY_INFO so the doctor never blocks.

    Args:
        rules: Rules dict from ``doctor_rules.load_rules`` (unused here but
            required by the detector protocol).

    Returns:
        A list of :class:`Finding` instances, one per problematic path.
    """
    findings: list[Finding] = []
    if not ULTRON_HOME.exists():
        return findings

    # Build a reference blob from active scripts (same approach as _check_orphan_paths).
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

    cutoff_days = 30.0
    cutoff_epoch = time.time() - cutoff_days * 86400.0

    _SKIP_PREFIXES = (".", "_")
    _SKIP_NAMES = frozenset({
        ".tmp", ".git", ".venv", "__pycache__",
        "node_modules", ".pytest_cache",
    })

    try:
        top_level = list(ULTRON_HOME.iterdir())
    except OSError:
        return findings

    for top in top_level:
        name = top.name
        if name in _WELLKNOWN_ULTRON_DIRS:
            continue
        if name in _SKIP_NAMES:
            continue
        if any(name.startswith(p) for p in _SKIP_PREFIXES):
            continue

        # --- Empty directory check ---
        if top.is_dir():
            try:
                children = list(top.iterdir())
            except OSError:
                children = []
            if not children:
                age_days = _file_age_days(top) or 0.0
                if age_days >= cutoff_days:
                    needle = name.lower()
                    if not (needle and needle in blob):
                        findings.append(Finding(
                            id=f"empty_dir:{name}",
                            category="orphan",
                            severity=SEVERITY_INFO,
                            summary=f"Empty directory ~/.ultron/{name} (age {age_days:.0f}d)",
                            detail=(
                                f"Path: {top}\n"
                                f"Age:  {age_days:.1f} days\n"
                                "Directory is empty and has no active script references."
                            ),
                            fix_action=None,
                            fix_command=None,
                        ))
            continue  # directories are handled above; files handled below

        # --- Loose file without references, >30d old ---
        if not top.is_file():
            continue
        try:
            mtime = top.stat().st_mtime
        except OSError:
            continue
        if mtime >= cutoff_epoch:
            continue
        needle = name.lower()
        if needle and needle in blob:
            continue
        age_days = _file_age_days(top) or 0.0
        size = _path_size_bytes(top)
        findings.append(Finding(
            id=f"orphan_file:{name}",
            category="orphan",
            severity=SEVERITY_INFO,
            summary=f"Possible orphan file ~/.ultron/{name} (age {age_days:.0f}d)",
            detail=(
                f"Path: {top}\n"
                f"Size: {_humanize_bytes(size)}\n"
                f"Age:  {age_days:.1f} days\n"
                "No reference found in active scripts."
            ),
            fix_action=None,
            fix_command=None,
        ))

    return findings


# ---------------------------------------------------------------------------
# Detection (b/c): skill drift
# ---------------------------------------------------------------------------


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
    """Return (active_names, deprecated_names) from manifest.cache.json + YAML."""
    active: set[str] = set()
    deprecated: set[str] = set()

    if MANIFEST_CACHE.exists():
        try:
            cache = json.loads(MANIFEST_CACHE.read_text(encoding="utf-8"))
            for entry in cache.get("skills", []):
                sid = entry.get("id")
                if isinstance(sid, str) and sid:
                    active.add(sid)
        except (OSError, json.JSONDecodeError):
            pass

    yaml_path = ULTRON_HOME / "skills.manifest.yaml"
    if yaml_path.exists():
        try:
            text = yaml_path.read_text(encoding="utf-8")
        except OSError:
            text = ""
        cur_name: str | None = None
        cur_dep: bool = False
        for raw in text.splitlines():
            s = raw.strip()
            if s.startswith("- name:"):
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
                cur_dep = v == "true"
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

    in_manifest_simple = {n for n in (active | deprecated) if ":" not in n}
    missing_from_manifest = sorted(on_disk - in_manifest_simple)
    for name in missing_from_manifest:
        findings.append(Finding(
            id=f"skill_drift:on-disk-not-manifest:{name}",
            category="skill_drift",
            severity=SEVERITY_WARN,
            summary=f"Skill '{name}' on disk but not in manifest",
            detail=(
                f"Skill directory: {CLAUDE_HOME / 'skills' / name}\n"
                f"Run `ultron manifest sync` to register it."
            ),
            fix_action="manifest_sync",
            fix_command=[sys.executable, str(_COCKPIT_DIR / "skill_manifest.py"), "sync"],
        ))

    in_manifest_local_active = {n for n in active if ":" not in n}
    missing_from_disk = sorted(in_manifest_local_active - on_disk)
    for name in missing_from_disk:
        findings.append(Finding(
            id=f"skill_drift:manifest-not-on-disk:{name}",
            category="skill_drift",
            severity=SEVERITY_WARN,
            summary=f"Skill '{name}' in manifest but not on disk",
            detail=(
                f"Manifest entry exists but no "
                f"{CLAUDE_HOME / 'skills' / name / 'SKILL.md'}.\n"
                f"Run `ultron manifest deprecate {name}` if intentional."
            ),
            fix_action=None,
            fix_command=None,
        ))
    return findings


# ---------------------------------------------------------------------------
# Detection (d): missing hook scripts
# ---------------------------------------------------------------------------


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
    """Extract the .py / .ps1 path from a hooks command string."""
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
            detail=(
                f"settings.json hook command: {cmd}\n"
                f"Resolved path: {p}\n"
                f"This hook will fail on every fire."
            ),
            fix_action=None,
            fix_command=None,
        ))
    return findings


# ---------------------------------------------------------------------------
# Detections (e/f): staleness
# ---------------------------------------------------------------------------


def _check_l0_stale(rules: dict[str, Any]) -> list[Finding]:
    """Detection (e): context.md older than rules.staleness.l0_max_hours."""
    regen_cmd = [sys.executable, str(_COCKPIT_DIR / "context_primer.py"), "generate"]
    if not CONTEXT_MD.exists():
        return [Finding(
            id="stale:l0:missing",
            category="stale",
            severity=SEVERITY_WARN,
            summary="L0 context.md is missing",
            detail=f"Expected: {CONTEXT_MD}\nRun context_primer.py generate to recreate.",
            fix_action="regen_context",
            fix_command=regen_cmd,
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
        fix_command=regen_cmd,
    )]


def _check_ztmsi_stale(rules: dict[str, Any]) -> list[Finding]:
    """Detection (f): brain index DB older than rules.staleness.ztmsi_max_hours."""
    build_cmd = [sys.executable, str(_COCKPIT_DIR / "brain_index.py"), "build"]
    if not BRAIN_DB.exists():
        return [Finding(
            id="stale:ztmsi:missing",
            category="stale",
            severity=SEVERITY_INFO,
            summary="Brain index database is missing",
            detail=f"Expected: {BRAIN_DB}\nRun brain_index.py build to create it.",
            fix_action="rebuild_index",
            fix_command=build_cmd,
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


# ---------------------------------------------------------------------------
# Detections (g/h/i/k): retention
# ---------------------------------------------------------------------------


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
        detail=(
            f"Total size: {_humanize_bytes(total_size)}\n"
            f"Examples:\n  "
            + "\n  ".join(str(p) for p in candidates[:5])
            + ("\n  ..." if len(candidates) > 5 else "")
        ),
        fix_action=None,
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
        detail=(
            "Examples:\n  "
            + "\n  ".join(str(p) for p in old_dirs[:5])
            + ("\n  ..." if len(old_dirs) > 5 else "")
        ),
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
        detail=(
            f"Total size: {_humanize_bytes(total)}\n"
            f"Examples:\n  "
            + "\n  ".join(str(p) for p in old_files[:5])
            + ("\n  ..." if len(old_files) > 5 else "")
        ),
        fix_action=None,
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
        detail=(
            f"Path: {ALERTS_FILE}\n"
            f"Run `ultron alerts purge --older-than 30d` to archive."
        ),
        fix_action="purge_alerts",
        fix_command=[
            sys.executable,
            str(_COCKPIT_DIR / "alerts.py"),
            "purge",
            "--older-than",
            "30d",
        ],
    )]


# ---------------------------------------------------------------------------
# Detection (j): unacked blocking alerts
# ---------------------------------------------------------------------------


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
    import datetime as _dt
    cutoff = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None) - _dt.timedelta(hours=24)
    cutoff_iso = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
    old = [r for r in unacked if isinstance(r.get("ts"), str) and r["ts"] < cutoff_iso]
    if not old:
        return []
    examples = "\n  ".join(
        f"{r.get('id', '?')} [{r.get('source', '?')}] {r.get('message', '')[:80]}"
        for r in old[:5]
    )
    return [Finding(
        id="alert:unacked_blocking_24h",
        category="alert",
        severity=SEVERITY_WARN,
        summary=f"{len(old)} blocking alert(s) unacked >24h",
        detail=f"Examples:\n  {examples}",
        fix_action=None,
        fix_command=None,
    )]


# ---------------------------------------------------------------------------
# Detection (l): token overhead
# ---------------------------------------------------------------------------


def measure_token_overhead() -> tuple[int, dict[str, int]]:
    """Sum tokens for the always-on context: context.md + MEMORY.md + CLAUDE.md.

    Returns:
        A tuple of (total_tokens, per_source_dict). Falls back to a
        chars/4 estimate if token_budget is not importable.
    """
    parts: dict[str, int] = {}
    for label, path in (
        ("context.md", CONTEXT_MD),
        ("MEMORY.md", _get_memory_md()),
        ("global CLAUDE.md", _GLOBAL_CLAUDE_MD),
    ):
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
        detail=(
            f"Breakdown:\n  {breakdown}\n"
            f"Trim context.md or MEMORY.md to bring total under the limit."
        ),
        fix_action=None,
        fix_command=None,
    )]


# ---------------------------------------------------------------------------
# Detection (m): MCP health
# ---------------------------------------------------------------------------


def _check_mcp_health(rules: dict[str, Any]) -> list[Finding]:
    """Detection (m): mcp-health.json shows degraded/missing entries."""
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
        if sev_label not in ("warn", "blocking"):
            continue
        findings.append(Finding(
            id=f"mcp:{name}:{status}",
            category="mcp",
            severity=SEVERITY_WARN if sev_label == "warn" else SEVERITY_BLOCKING,
            summary=f"MCP '{name}' status={status} (fallback severity={sev_label})",
            detail=(
                f"Last check: {data.get('checked_at', '?')}\n"
                f"Run `ultron mcp health` for live re-probe."
            ),
            fix_action="reprobe_mcp",
            fix_command=[sys.executable, str(_COCKPIT_DIR / "mcp_health_check.py"), "--quiet"],
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
        is_drift = f.finding_type == "drift"
        out.append(Finding(
            id=f"security:provenance:{f.finding_type}:{f.skill_name}",
            category="integrity",
            severity=sev,
            summary=f"Skill provenance -- {f.finding_type} on '{f.skill_name}'",
            detail=f.detail,
            fix_action="provenance_record" if is_drift else None,
            fix_command=(
                [sys.executable, str(_COCKPIT_DIR / "skill_provenance.py"), "record", f.skill_name]
                if is_drift
                else None
            ),
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
        sev = {
            "info": SEVERITY_INFO,
            "warn": SEVERITY_WARN,
            "blocking": SEVERITY_BLOCKING,
        }.get(f.severity, SEVERITY_INFO)
        out.append(Finding(
            id=f"security:settings:{f.finding_type}",
            category="integrity",
            severity=sev,
            summary=f"settings.json drift -- {f.finding_type}",
            detail=f.detail,
            fix_action="settings_snapshot" if sev == SEVERITY_WARN else None,
            fix_command=(
                [
                    sys.executable,
                    str(_COCKPIT_DIR / "settings_integrity.py"),
                    "snapshot",
                    "--trigger",
                    "auto",
                ]
                if sev == SEVERITY_WARN
                else None
            ),
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
            detail=(
                f"path: {f.path}:{f.line_number}\n"
                f"excerpt: {f.excerpt}\n"
                f"Rotate the credential and remove it from the file."
            ),
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
        sev_map = {"warn": SEVERITY_WARN, "quarantine": SEVERITY_WARN, "block": SEVERITY_BLOCKING}
        sev = sev_map.get(v.decision, SEVERITY_WARN)
        skill_name = Path(v.skill_path).name
        finding_lines = [
            f"path: {v.skill_path}",
            f"decision: {v.decision} (confidence={v.confidence})",
            f"findings: {len(v.findings)}",
        ]
        for f in v.findings[:5]:
            ln = f.line_number if f.line_number is not None else "?"
            waived_tag = ""
            if getattr(f, "waived", False):
                reason = getattr(f, "waived_reason", "") or ""
                waived_tag = f"  [WAIVED: {reason}]" if reason else "  [WAIVED]"
            finding_lines.append(
                f"  [{f.severity}] {f.rule_id} {f.pattern_name} line={ln}{waived_tag}"
            )
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


# ---------------------------------------------------------------------------
# Detection (D17): deadwood
# ---------------------------------------------------------------------------


def _check_deadwood(rules: dict[str, Any]) -> list[Finding]:
    """Detection (D17): surface findings from deadwood_scanner.py."""
    rebuild_cmd = [
        sys.executable,
        str(_COCKPIT_DIR / "deadwood_scanner.py"),
        "--json",
        "--report",
        "--quiet",
    ]

    if not DEADWOOD_JSON.exists():
        return [Finding(
            id="deadwood:missing",
            category="deadwood",
            severity=SEVERITY_INFO,
            summary="Deadwood scan has never been run",
            detail=(
                f"Expected: {DEADWOOD_JSON}\n"
                "Run deadwood_scanner.py --json --report to populate."
            ),
            fix_action="rebuild_deadwood",
            fix_command=rebuild_cmd,
        )]

    age_h = max(0.0, _file_age_hours(DEADWOOD_JSON) or 0.0)
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

    blockings = [f for f in raw if isinstance(f, dict) and f.get("severity") == "blocking"]
    warnings = [f for f in raw if isinstance(f, dict) and f.get("severity") == "warn"]
    findings: list[Finding] = []
    _SURFACE_LIMIT = 5
    for entry in blockings[:_SURFACE_LIMIT]:
        try:
            rel = str(Path(entry.get("file", "?")).relative_to(Path.home()))
        except (ValueError, TypeError):
            rel = str(entry.get("file", "?"))
        line_start = entry.get("line_start", 0)
        pattern = entry.get("pattern", "?")
        findings.append(Finding(
            id=f"deadwood:blocking:{rel}:L{line_start}:{pattern}",
            category="deadwood",
            severity=SEVERITY_BLOCKING,
            summary=f"Deadwood blocking: {pattern} at {rel}:L{line_start}",
            detail=(entry.get("snippet", "") + f"\nFields: {entry.get('fields', {})}"),
            fix_action="review_deadwood_block",
            fix_command=None,
        ))
    if len(blockings) > _SURFACE_LIMIT:
        findings.append(Finding(
            id="deadwood:blocking:overflow",
            category="deadwood",
            severity=SEVERITY_BLOCKING,
            summary=f"+{len(blockings) - _SURFACE_LIMIT} more blocking deadwood findings",
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
            detail=(
                "Top patterns: "
                + ", ".join(sorted({w.get("pattern", "?") for w in warnings}))
                + "\nSee ~/.ultron/audits/deadwood-baseline.md."
            ),
            fix_action=None,
            fix_command=None,
        ))
    return findings


# ---------------------------------------------------------------------------
# Detection (D18): skill truncation
# ---------------------------------------------------------------------------


def _count_skills_on_disk() -> dict[str, int]:
    """Walk skill directories and bucket SKILL.md hits by namespace."""
    home = Path.home()
    root_dir = home / ".claude" / "skills"
    plugin_dir = home / ".claude" / "plugins"
    counts: dict[str, int] = {"root": 0, "plugin": 0, "bundle": 0}

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
            if "cache" in skill_md.parts:
                continue
            counts["plugin"] += 1

    counts["total"] = counts["root"] + counts["plugin"] + counts["bundle"]
    return counts


def _check_skill_truncation(rules: dict[str, Any]) -> list[Finding]:
    """Detection (D18): warn when the skill catalog is large enough to trigger truncation."""
    threshold = int(rules.get("thresholds", {}).get("skill_truncation_warn_at", 200))
    counts = _count_skills_on_disk()
    if counts["total"] <= threshold:
        return []
    return [Finding(
        id="skill_truncation:over_threshold",
        category="skill_truncation",
        severity=SEVERITY_WARN,
        summary=(
            f"Skill catalog ({counts['total']}) exceeds truncation threshold ({threshold})"
        ),
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


# ---------------------------------------------------------------------------
# Detection D22: per-block token budgets
# ---------------------------------------------------------------------------


def _check_token_block_budgets(rules: dict[str, Any]) -> list[Finding]:
    """Detection D22: per-block tokens vs token_baseline DEFAULT_BUDGETS."""
    try:
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
    except Exception as exc:  # noqa: BLE001
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


# ---------------------------------------------------------------------------
# Detection D24: cache hit rate
# ---------------------------------------------------------------------------


def _check_cache_hit_rate(rules: dict[str, Any]) -> list[Finding]:
    """Detection D24: prompt cache hit rate over the recent window."""
    try:
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
    except Exception as exc:  # noqa: BLE001
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
            f"D24 cache hit rate {status.get('hit_rate', 0) * 100:.1f}% "
            f"over {status.get('turns_observed', 0)} turns "
            f"({status.get('window_days', 14)}d) -- verdict {verdict}"
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


# ---------------------------------------------------------------------------
# Detection D25: backup freshness
# ---------------------------------------------------------------------------


def _check_backup_freshness(rules: dict[str, Any]) -> list[Finding]:
    """Detection D25: warn when last weekly backup is stale."""
    status_file = Path.home() / ".ultron" / ".tmp" / "backup-last-run.json"
    if not status_file.exists():
        return [Finding(
            id="backup:never_run",
            category="backup",
            severity=SEVERITY_INFO,
            summary="D25 weekly backup has never run",
            detail=(
                "Run `~/.ultron/scripts/backup/weekly-backup.ps1` manually or "
                "register the ONLOGON Task Scheduler entry."
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
        last = _datetime.fromisoformat(str(last_run_raw))
        if last.tzinfo is None:
            last = last.replace(tzinfo=_timezone.utc)
    except (TypeError, ValueError):
        return [Finding(
            id="backup:status_malformed",
            category="backup",
            severity=SEVERITY_INFO,
            summary="D25 backup status has unparseable last_run",
            detail=f"last_run={last_run_raw!r}",
        )]
    age = _datetime.now(_timezone.utc) - last
    if age <= _timedelta(days=7):
        return []
    severity = SEVERITY_BLOCKING if age > _timedelta(days=30) else SEVERITY_WARN
    return [Finding(
        id=f"backup:stale:{int(age.days)}d",
        category="backup",
        severity=severity,
        summary=f"D25 weekly backup is {age.days}d old (>7d threshold)",
        detail=(
            f"Last backup: {last_run_raw}. Run "
            f"`~/.ultron/scripts/backup/weekly-backup.ps1` or check Task "
            f"Scheduler entry. >30d is blocking -- your data is at risk."
        ),
    )]


# ---------------------------------------------------------------------------
# Detector registries
# ---------------------------------------------------------------------------

_SECURITY_DETECTORS = (
    _check_skill_provenance_drift,
    _check_settings_integrity,
    _check_secrets_in_state,
    _check_skill_security_scans,
)

_ALL_DETECTORS = (
    _check_orphan_paths,
    _check_empty_dirs_and_orphan_files,
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
