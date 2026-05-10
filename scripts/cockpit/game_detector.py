#!/usr/bin/env python3
"""
ULTRON v11.0 Cockpit - Game Session Detector (read-only logger).

Detects active game processes and logs session events to:
  ~/.ultron/sessions/<date>/game-sessions.jsonl

Does NOT kill processes or modify system state. Used for:
  - Dashboard "gaming now" indicator
  - Activity tracker enrichment (tag activity entries with game name)
  - Retrospective session summaries

Usage:
  game_detector.py status           Print current gaming state + active game
  game_detector.py log              Snapshot current state to JSONL (for cron)
  game_detector.py history [DATE]   Show game sessions for DATE (default: today)
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

sys.path.insert(0, str(Path(__file__).parent))
from should_run import _load_game_processes, is_gaming, is_paused  # noqa: E402

SESSIONS_ROOT = Path.home() / ".ultron" / "sessions"


def _sessions_file(date: str) -> Path:
    p = SESSIONS_ROOT / date
    p.mkdir(parents=True, exist_ok=True)
    return p / "game-sessions.jsonl"


def _detect_active_game() -> str | None:
    """Return the first matching game process name, or None."""
    import os
    import subprocess

    if os.name != "nt":
        return None
    targets = set(_load_game_processes())
    try:
        result = subprocess.run(
            ["tasklist", "/fo", "csv", "/nh"],
            capture_output=True, text=True, timeout=10,
            encoding="utf-8", errors="replace",
            creationflags=_WIN_HIDDEN)
        if result.returncode != 0:
            return None
        for line in result.stdout.splitlines():
            if line.startswith('"'):
                name = line.split(",", 1)[0].strip('"').lower()
                if name in targets:
                    return name
    except (subprocess.TimeoutExpired, OSError):
        pass
    return None


def _read_sessions(date: str) -> list[dict]:
    path = SESSIONS_ROOT / date / "game-sessions.jsonl"
    if not path.exists():
        return []
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return records


def cmd_status() -> int:
    gaming, reason = is_gaming()
    paused, pause_reason = is_paused()
    active = _detect_active_game()

    print(f"Gaming   : {'YES — ' + reason if gaming else 'no'}")
    print(f"Paused   : {'YES — ' + pause_reason if paused else 'no'}")
    print(f"Active   : {active or '(none)'}")
    return 2 if gaming else 0


def cmd_log() -> int:
    """Write one snapshot entry to today's game-sessions.jsonl."""
    gaming, reason = is_gaming()
    active = _detect_active_game() if gaming else None
    today = datetime.now().strftime("%Y-%m-%d")
    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "gaming": gaming,
        "game": active,
        "reason": reason,
    }
    path = _sessions_file(today)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    if gaming:
        print(f"[game-detector] Logged: {active} — {reason}")
    return 0


def cmd_history(date: str | None = None) -> int:
    if not date:
        date = datetime.now().strftime("%Y-%m-%d")
    records = _read_sessions(date)
    if not records:
        print(f"No game sessions recorded for {date}")
        return 0

    gaming_records = [r for r in records if r.get("gaming")]
    games_seen: dict[str, int] = {}
    for r in gaming_records:
        g = r.get("game") or "unknown"
        games_seen[g] = games_seen.get(g, 0) + 1

    print(f"Game sessions — {date}")
    print(f"  Total snapshots : {len(records)}")
    print(f"  Gaming snapshots: {len(gaming_records)}")
    if games_seen:
        print("  Games detected  :")
        for game, count in sorted(games_seen.items(), key=lambda x: -x[1]):
            print(f"    {game}: {count} snapshots (~{count * 10}min)")
    return 0


def main() -> int:
    import argparse
    p = argparse.ArgumentParser(description="ULTRON game session detector (read-only)")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("status", help="Print current gaming state")
    sub.add_parser("log", help="Snapshot current state to JSONL")
    hist = sub.add_parser("history", help="Show game sessions for a date")
    hist.add_argument("date", nargs="?", default=None, help="YYYY-MM-DD (default: today)")

    args = p.parse_args()
    if args.cmd == "status":
        return cmd_status()
    elif args.cmd == "log":
        return cmd_log()
    elif args.cmd == "history":
        return cmd_history(args.date)
    else:
        p.print_help()
        return 1


if __name__ == "__main__":
    sys.exit(main())
