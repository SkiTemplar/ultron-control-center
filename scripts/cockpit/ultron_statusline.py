#!/usr/bin/env python3
"""ULTRON Claude Code statusline.

Wired into ~/.claude/settings.json as the `statusLine.command`. Claude Code
invokes this each turn and renders the single line we print at the bottom
of the conversation. The whole script must finish quickly (<200ms typical)
or the statusline lags.

Format:
  ULTRON [MODE] | alerts:N | last:<skill> | vault:Nh

Skips silently when any data source is missing (no exceptions reach the
caller — a broken statusline must never disrupt a session).
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~")))
ULTRON = HOME / ".ultron"
MODE_FILE = ULTRON / ".tmp" / "mode.json"
SESSION_FILE = ULTRON / ".tmp" / "current-session.json"
ALERTS = ULTRON / "alerts.jsonl"
VAULT_PRIMER = ULTRON / ".tmp" / "context.md"


def _mode() -> str:
    try:
        if MODE_FILE.is_file():
            data = json.loads(MODE_FILE.read_text(encoding="utf-8"))
            m = (data.get("mode") or "").upper()
            if m in ("LOW", "MEDIUM", "HIGH", "ULTRA"):
                return m
    except (OSError, json.JSONDecodeError):
        pass
    return "MEDIUM"


def _alerts_count() -> int:
    if not ALERTS.is_file():
        return 0
    try:
        lines = ALERTS.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return 0
    by_id: dict[str, dict] = {}
    n_anon = 0
    for raw in lines[-1500:]:
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
            sev = rec.get("severity")
            if sev in ("warn", "critical", "blocking") and not rec.get("ack"):
                if rec.get("message"):
                    n_anon += 1
    open_count = sum(
        1 for rec in by_id.values()
        if rec.get("severity") in ("warn", "critical", "blocking") and not rec.get("ack")
    )
    return open_count + n_anon


def _last_skill() -> str:
    today = datetime.now().strftime("%Y-%m-%d")
    log = ULTRON / "sessions" / today / "routing.jsonl"
    if not log.is_file():
        return ""
    try:
        lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    for raw in reversed(lines[-200:]):
        raw = raw.strip()
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if rec.get("tool") == "Skill" and rec.get("target"):
            return str(rec["target"])[:24]
    return ""


def _vault_age_hours() -> int | None:
    if not VAULT_PRIMER.is_file():
        return None
    try:
        mtime = VAULT_PRIMER.stat().st_mtime
    except OSError:
        return None
    return int((datetime.now().timestamp() - mtime) / 3600)


def main() -> int:
    # Statusline receives a JSON object on stdin (session info). We don't
    # need it, but draining keeps Claude Code from blocking on the pipe.
    try:
        _ = sys.stdin.read()
    except Exception:  # noqa: BLE001
        pass

    parts: list[str] = ["ULTRON"]
    mode = _mode()
    parts.append(f"[{mode}]")
    alerts = _alerts_count()
    if alerts > 0:
        parts.append(f"alerts:{alerts}")
    last = _last_skill()
    if last:
        parts.append(f"last:{last}")
    age = _vault_age_hours()
    if age is not None and age > 0:
        parts.append(f"vault:{age}h")

    print(" | ".join(parts))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        # Statusline must NEVER raise to caller.
        sys.exit(0)
