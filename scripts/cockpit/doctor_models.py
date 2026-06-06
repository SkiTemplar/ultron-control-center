"""doctor_models — shared data model for ULTRON Doctor.

Contains: constants, Finding dataclass, Report dataclass, and the
lightweight helpers that are needed by both doctor_checks and
doctor_reporters (time utilities, atomic-write, JSONL append, size
helpers).

This module has NO import from other doctor_* siblings so it can be
imported in isolation by tests or external callers.
"""
from __future__ import annotations

import datetime as _dt
import io
import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Severity constants
# ---------------------------------------------------------------------------

SEVERITY_INFO = "info"
SEVERITY_WARN = "warn"
SEVERITY_BLOCKING = "blocking"
_SEVERITY_RANK: dict[str, int] = {
    SEVERITY_INFO: 0,
    SEVERITY_WARN: 1,
    SEVERITY_BLOCKING: 2,
}

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

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


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
        """Serialise to a plain dict suitable for JSON encoding."""
        d = asdict(self)
        d["fix_action"] = self.fix_action
        d["fix_command"] = list(self.fix_command) if self.fix_command else None
        return d


@dataclass
class Report:
    """Aggregated result of a doctor run."""

    findings: list[Finding] = field(default_factory=list)
    runtime_ms: int = 0

    def add(self, finding: Finding | None) -> None:
        """Append a finding, ignoring None."""
        if finding is not None:
            self.findings.append(finding)

    def extend(self, findings: list[Finding]) -> None:
        """Append multiple findings, ignoring None entries."""
        for f in findings:
            self.add(f)

    def by_severity(self, severity: str) -> list[Finding]:
        """Return all findings matching the given severity level."""
        return [f for f in self.findings if f.severity == severity]

    def worst_severity(self) -> str | None:
        """Return the highest-severity label found, or None if empty."""
        if not self.findings:
            return None
        return max(
            self.findings, key=lambda f: _SEVERITY_RANK.get(f.severity, 0)
        ).severity

    def to_dict(self) -> dict[str, Any]:
        """Serialise to a plain dict suitable for JSON encoding."""
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
# Shared utility helpers
# ---------------------------------------------------------------------------


def _now_utc_iso() -> str:
    """Return current UTC time as ISO-8601 string (second precision)."""
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
            pass
    os.replace(str(tmp), str(path))


def _append_jsonl(path: Path, record: dict[str, Any]) -> None:
    """Append a JSONL record atomically (O_APPEND single-write)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
    fd = os.open(
        str(path),
        os.O_WRONLY | os.O_APPEND | os.O_CREAT
        | (os.O_BINARY if hasattr(os, "O_BINARY") else 0),
        0o644,
    )
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)


def _file_age_hours(path: Path) -> float | None:
    """Return file age in hours, or None if the file does not exist."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    return (time.time() - mtime) / 3600.0


def _file_age_days(path: Path) -> float | None:
    """Return file age in days, or None if the file does not exist."""
    h = _file_age_hours(path)
    return None if h is None else h / 24.0


def _path_size_bytes(path: Path) -> int:
    """Return file size in bytes, or 0 on error."""
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
    """Format a byte count as a human-readable string (e.g. 1.4MB)."""
    f = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024.0:
            return f"{f:.1f}{unit}"
        f /= 1024.0
    return f"{f:.1f}PB"
