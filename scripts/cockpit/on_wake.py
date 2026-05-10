#!/usr/bin/env python3
"""
ULTRON v12.2 Cockpit - On-wake orchestrator.

Replaces fixed-time cron triggers. Called by Task Scheduler on:
  - At logon (ULTRON-OnWake task)
  - On system resume from sleep (ULTRON-OnWakeResume task)

Waits 90s for system settle, then runs:
  - Memory bridge: ingest CC project memories into vault (always)
  - Wikilink repair: fix broken [[links]] in vault (Mondays only)
  - Morning window (5am-12pm): ai_standup + github_trending
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import COCKPIT_DIR  # noqa: E402

SKILL_ROOT = Path.home() / ".ultron"
SESSIONS_DIR = Path.home() / ".ultron" / "sessions"
SETTLE_SECONDS = int(os.environ.get("ULTRON_WAKE_SETTLE", "90"))


def _log(wake_log: Path, msg: str) -> None:
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        wake_log.parent.mkdir(parents=True, exist_ok=True)
        with open(wake_log, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _run(cmd: list[str], wake_log: Path, label: str) -> int:
    _log(wake_log, f"START {label}")
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300,
            cwd=SKILL_ROOT, creationflags=_WIN_HIDDEN,
        )
        if result.stdout.strip():
            _log(wake_log, f"  {result.stdout.strip()[:200]}")
        if result.returncode != 0 and result.stderr.strip():
            _log(wake_log, f"  STDERR: {result.stderr.strip()[:200]}")
        _log(wake_log, f"END {label} (exit={result.returncode})")
        return result.returncode
    except subprocess.TimeoutExpired:
        _log(wake_log, f"TIMEOUT {label}")
        return -1
    except Exception as e:
        _log(wake_log, f"ERROR {label}: {e}")
        return -2


def _uv(*args: str) -> list[str]:
    return ["uv", "run", "python", *args]


def run(settle: bool = True) -> int:
    today = datetime.now().strftime("%Y-%m-%d")
    wake_log = SESSIONS_DIR / today / "on-wake.log"
    hour = datetime.now().hour

    _log(wake_log, f"=== ON-WAKE (v11.0) hour={hour} ===")

    if settle:
        _log(wake_log, f"Settling for {SETTLE_SECONDS}s...")
        time.sleep(SETTLE_SECONDS)

    # Check inhibitors (gaming / paused)
    try:
        from should_run import is_gaming, is_paused
        paused, pwhy = is_paused()
        gaming, gwhy = is_gaming()
        if paused or gaming:
            reason = pwhy if paused else gwhy
            _log(wake_log, f"INHIBITED: {reason} — skipping morning scripts")
            return 0
    except ImportError:
        pass

    # Memory bridge: ingest CC project memories into vault (always, every wake)
    if (SKILL_ROOT / "scripts" / "cockpit" / "memory_bridge.py").exists():
        _run(_uv("scripts/cockpit/memory_bridge.py", "ingest"), wake_log, "memory_bridge")

    # Wikilink repair: fix broken [[...]] links in vault (Mondays only)
    if datetime.now().weekday() == 0:
        if (SKILL_ROOT / "scripts" / "cockpit" / "memory_bridge.py").exists():
            _run(_uv("scripts/cockpit/memory_bridge.py", "repair-wikilinks", "--fix"),
                 wake_log, "wikilink_repair")

    # Morning window: standup, trending (news is on-demand via TUI now)
    if 5 <= hour < 12:
        _log(wake_log, "Morning window — running daily scripts")
        _run(_uv("scripts/cockpit/ai_standup.py", "--from-cron"), wake_log, "ai_standup")
        if (SKILL_ROOT / "scripts" / "cockpit" / "github_trending.py").exists():
            _run(_uv("scripts/cockpit/github_trending.py", "--from-cron"), wake_log, "github_trending")
    else:
        _log(wake_log, f"Outside morning window (hour={hour}) — skipping daily scripts")

    _log(wake_log, "=== DONE ===")
    return 0


def main() -> int:
    import argparse
    p = argparse.ArgumentParser(description="ULTRON on-wake orchestrator")
    p.add_argument("--no-settle", action="store_true", help="Skip 90s settle wait (for testing)")
    args = p.parse_args()
    return run(settle=not args.no_settle)


if __name__ == "__main__":
    sys.exit(main())
