#!/usr/bin/env python3
"""ULTRON SessionStart hook — detect open loops in the cockpit.

Inspired by donchitos/Claude-Code-Game-Studios detect-gaps.sh (game-dev:
"you have code but no design docs"). Adapted to the ULTRON cockpit:

- skills on disk not in registry.json (drift)
- plans in-progress without an update in >7 days
- backups stale >14 days (mirror mtime)
- skills currently quarantined (security review pending)
- critical alerts un-acked for >24h

Output mode is controlled by:
- default (hook call): prints a human-readable block to stdout for Claude.
- --json: emits one JSON object for the Tauri Control Center to consume.

Always exits 0 — gaps are advisories, not failures.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~")))
ULTRON = HOME / ".ultron"
CLAUDE = HOME / ".claude"
SKILLS_DIR = CLAUDE / "skills"
REGISTRY = ULTRON / "skills" / "registry.json"
PLANS_JSON = ULTRON / "cockpit" / "PLANS.json"
ALERTS_JSONL = ULTRON / "alerts.jsonl"
BACKUP_ROOT_CFG = ULTRON / ".tmp" / "backup-root.txt"


@dataclass
class Gap:
    severity: str  # "info" | "warn" | "critical"
    category: str
    title: str
    detail: str
    suggestion: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


# --- Checks -----------------------------------------------------------------

def check_skill_registry_drift(gaps: list[Gap]) -> None:
    """Skills on disk not in registry.json (or vice-versa)."""
    if not SKILLS_DIR.is_dir():
        return
    on_disk: set[str] = {
        p.name for p in SKILLS_DIR.iterdir()
        if p.is_dir() and not p.name.startswith(".") and (p / "SKILL.md").exists()
    }
    if not REGISTRY.is_file():
        if on_disk:
            gaps.append(Gap(
                severity="warn",
                category="skills",
                title=f"Skills registry missing ({len(on_disk)} skill(s) on disk, no registry.json)",
                detail="The registry has never been built; the Skills tab will show nothing.",
                suggestion="Dashboard -> Maintenance -> Skill registry rebuild",
            ))
        return
    try:
        raw = REGISTRY.read_text(encoding="utf-8")
        reg = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return
    registered: set[str] = set()
    for key, entry in (reg.get("skills") or {}).items():
        name = (entry or {}).get("name") if isinstance(entry, dict) else None
        if isinstance(name, str):
            registered.add(name)
        else:
            tail = key.split("::", 1)[-1]
            if tail:
                registered.add(tail)
    missing = sorted(on_disk - registered)
    if missing:
        sample = ", ".join(missing[:5])
        more = f" (+{len(missing) - 5} more)" if len(missing) > 5 else ""
        gaps.append(Gap(
            severity="warn",
            category="skills",
            title=f"{len(missing)} skill(s) on disk not in registry",
            detail=f"Drift: {sample}{more}",
            suggestion="Dashboard -> Maintenance -> Skill registry rebuild",
        ))


def check_stale_plans(gaps: list[Gap], max_days: int = 7) -> None:
    if not PLANS_JSON.is_file():
        return
    try:
        plans = json.loads(PLANS_JSON.read_text(encoding="utf-8")).get("plans", [])
    except (OSError, json.JSONDecodeError):
        return
    now = _utc_now()
    stale: list[dict] = []
    for p in plans:
        if not isinstance(p, dict):
            continue
        if p.get("status") not in ("in-progress", "blocked"):
            continue
        upd = _parse_iso(p.get("updated_at") or p.get("created_at"))
        if upd is None:
            continue
        age_days = (now - upd).days
        if age_days > max_days:
            stale.append({"id": p.get("id"), "title": p.get("title", ""), "days": age_days})
    if stale:
        sample = "; ".join(f"{s['id']} ({s['days']}d)" for s in stale[:3])
        more = f" (+{len(stale) - 3} more)" if len(stale) > 3 else ""
        gaps.append(Gap(
            severity="info",
            category="plans",
            title=f"{len(stale)} plan(s) idle > {max_days} days",
            detail=f"{sample}{more}",
            suggestion="Plans tab — close, update or archive",
        ))


def check_quarantined_skills(gaps: list[Gap]) -> None:
    if not REGISTRY.is_file():
        return
    try:
        reg = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    quarantined: list[str] = []
    for entry in (reg.get("skills") or {}).values():
        if not isinstance(entry, dict):
            continue
        if entry.get("state") == "quarantined":
            name = entry.get("name") or "(unnamed)"
            quarantined.append(name)
    if quarantined:
        sample = ", ".join(sorted(quarantined)[:5])
        more = f" (+{len(quarantined) - 5} more)" if len(quarantined) > 5 else ""
        gaps.append(Gap(
            severity="warn",
            category="security",
            title=f"{len(quarantined)} skill(s) quarantined (security review pending)",
            detail=sample + more,
            suggestion="Skills tab -> Quarantined filter -> review findings, Allow anyway if trusted",
        ))


def check_unacked_critical_alerts(gaps: list[Gap], hours: int = 24) -> None:
    if not ALERTS_JSONL.is_file():
        return
    try:
        lines = ALERTS_JSONL.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return
    by_id: dict[str, dict] = {}
    standalone: list[dict] = []
    for raw in lines[-2000:]:
        raw = raw.strip()
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            continue
        rid = rec.get("id")
        if isinstance(rid, str):
            if rid not in by_id:
                by_id[rid] = dict(rec)
            elif rec.get("ack") is True:
                by_id[rid]["ack"] = True
        else:
            standalone.append(rec)
    now = _utc_now()
    open_critical = 0
    for rec in list(by_id.values()) + standalone:
        if rec.get("severity") not in ("critical", "blocking"):
            continue
        if rec.get("ack") is True:
            continue
        ts = _parse_iso(rec.get("ts") or rec.get("timestamp"))
        if ts is None:
            continue
        age_h = (now - ts).total_seconds() / 3600
        if age_h > hours:
            open_critical += 1
    if open_critical:
        gaps.append(Gap(
            severity="critical",
            category="alerts",
            title=f"{open_critical} critical alert(s) un-acked > {hours}h",
            detail="Open alerts that nobody's looked at.",
            suggestion="Notifications tab -> review or Clear all",
        ))


def check_backup_age(gaps: list[Gap], max_days: int = 14) -> None:
    root: Path | None = None
    if BACKUP_ROOT_CFG.is_file():
        try:
            root = Path(BACKUP_ROOT_CFG.read_text(encoding="utf-8").strip())
        except OSError:
            root = None
    if root is None:
        candidate = Path("D:/BACKUP")
        if candidate.exists():
            root = candidate
    if root is None or not root.exists():
        return
    newest_mtime = 0.0
    mirrors = 0
    for sub in root.iterdir():
        if sub.is_dir():
            mirrors += 1
            try:
                newest_mtime = max(newest_mtime, sub.stat().st_mtime)
            except OSError:
                continue
    if mirrors == 0:
        return
    age_days = (datetime.now().timestamp() - newest_mtime) / 86_400
    if age_days > max_days:
        gaps.append(Gap(
            severity="warn",
            category="backup",
            title=f"Backup mirrors stale ({int(age_days)}d since last refresh)",
            detail=f"{mirrors} mirror(s) in {root}",
            suggestion="Dashboard -> Maintenance -> Weekly backup",
        ))


# --- Output -----------------------------------------------------------------

def render_text(gaps: list[Gap]) -> str:
    if not gaps:
        return "[ULTRON detect-gaps] No open loops detected. Cockpit is clean."
    lines: list[str] = ["[ULTRON detect-gaps] Open loops to be aware of:"]
    for g in gaps:
        marker = {"critical": "!!!", "warn": "!! ", "info": "i  "}.get(g.severity, "?  ")
        lines.append(f"  {marker} [{g.category}] {g.title}")
        if g.detail:
            lines.append(f"      {g.detail}")
        if g.suggestion:
            lines.append(f"      -> {g.suggestion}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    args, _ = parser.parse_known_args()

    # Drain stdin in case Claude Code passed a payload (SessionStart provides one).
    try:
        _ = sys.stdin.read()
    except Exception:  # noqa: BLE001
        pass

    gaps: list[Gap] = []
    for fn in (
        check_skill_registry_drift,
        check_stale_plans,
        check_quarantined_skills,
        check_unacked_critical_alerts,
        check_backup_age,
    ):
        try:
            fn(gaps)
        except Exception as exc:  # noqa: BLE001 — one bad check shouldn't kill the rest
            sys.stderr.write(f"[detect_gaps] check {fn.__name__} failed: {exc}\n")

    if args.json:
        print(json.dumps({
            "generated_at": _utc_now().isoformat(timespec="seconds"),
            "count": len(gaps),
            "gaps": [g.to_dict() for g in gaps],
        }, ensure_ascii=False, indent=2))
    else:
        print(render_text(gaps))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        try:
            sys.stderr.write(f"[detect_gaps] non-fatal error: {exc}\n")
        except Exception:  # noqa: BLE001
            pass
        sys.exit(0)
