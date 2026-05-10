#!/usr/bin/env python3
"""
ULTRON v10.2/v10.4 - Marker-based "should I run?" helper.

Used by daily/weekly scripts that fire AT LOGIN to avoid duplicate runs
within the same period. Each script calls this BEFORE doing real work:

    from should_run import should_run_today, mark_ran_today
    if not should_run_today("ai_standup"):
        sys.exit(0)
    # ... do the work ...
    mark_ran_today("ai_standup")

Markers live at ~/.ultron/cockpit/last-run/<script>.marker (one line, ISO date).

v10.4 additions: gaming/pause gate. should_run_* return False if either:
  - ~/.ultron/cockpit/paused-until.txt exists with future ISO timestamp
  - any process from game-processes.txt is currently running
This protects RAM/CPU during gaming sessions without manual cron pausing.
"""
from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

COCKPIT_DIR = Path.home() / ".ultron" / "cockpit"
MARKER_DIR = COCKPIT_DIR / "last-run"
PAUSE_FILE = COCKPIT_DIR / "paused-until.txt"
GAME_PROCESSES_FILE = COCKPIT_DIR / "game-processes.txt"

# Default game processes (case-insensitive). Edit via `ultron games <add|remove>`
# or directly in game-processes.txt (one per line, # for comments).
#
# IMPORTANT (v10.4 fix): launchers like Steam/Epic/Battle.net are NOT in defaults.
# A launcher being open != actively gaming. Only ACTUAL game executables inhibit
# crons. User can add more via `ultron games add <process.exe>`.
DEFAULT_GAME_PROCESSES = [
    # USER's current games (extend via `ultron games add`):
    "rdr2.exe",                            # Red Dead Redemption 2
    "fc24.exe", "fifa24.exe",              # EA FC 24
    "cs2.exe",                             # Counter-Strike 2
    "leagueoflegends.exe",                 # League of Legends (the actual game, not client)
    "universesandbox.exe",                 # Universe Sandbox
]


def _marker_path(script_name: str) -> Path:
    MARKER_DIR.mkdir(parents=True, exist_ok=True)
    return MARKER_DIR / f"{script_name}.marker"


def _read_marker(script_name: str) -> datetime | None:
    p = _marker_path(script_name)
    if not p.exists():
        return None
    try:
        text = p.read_text(encoding="utf-8").strip()
        return datetime.fromisoformat(text)
    except (ValueError, OSError):
        return None


def _write_marker(script_name: str) -> None:
    p = _marker_path(script_name)
    p.write_text(datetime.now().isoformat(timespec="seconds"), encoding="utf-8")


def is_paused() -> tuple[bool, str]:
    """True if a manual pause is active. Returns (paused, reason)."""
    if not PAUSE_FILE.exists():
        return False, ""
    try:
        text = PAUSE_FILE.read_text(encoding="utf-8").strip()
        until = datetime.fromisoformat(text)
        if until > datetime.now():
            remaining = until - datetime.now()
            mins = int(remaining.total_seconds() / 60)
            return True, f"paused for {mins}min more (until {until.strftime('%H:%M')})"
        # Expired - clean up
        PAUSE_FILE.unlink()
        return False, ""
    except (ValueError, OSError):
        return False, ""


def _load_game_processes() -> list[str]:
    """User-configurable list at ~/.ultron/cockpit/game-processes.txt (one per line).
    Falls back to DEFAULT_GAME_PROCESSES if file missing."""
    if not GAME_PROCESSES_FILE.exists():
        return [p.lower() for p in DEFAULT_GAME_PROCESSES]
    try:
        lines = GAME_PROCESSES_FILE.read_text(encoding="utf-8").splitlines()
        custom = [line.strip().lower() for line in lines
                  if line.strip() and not line.strip().startswith("#")]
        return custom or [p.lower() for p in DEFAULT_GAME_PROCESSES]
    except OSError:
        return [p.lower() for p in DEFAULT_GAME_PROCESSES]


def is_gaming() -> tuple[bool, str]:
    """True if any known game/launcher process is running. Returns (gaming, reason).
    Windows-only: uses `tasklist /fo csv` (no external deps)."""
    if os.name != "nt":
        return False, ""
    targets = set(_load_game_processes())
    try:
        # tasklist is fast (~50ms) and doesn't need elevation
        result = subprocess.run(
            ["tasklist", "/fo", "csv", "/nh"],
            capture_output=True, text=True, timeout=10,
            encoding="utf-8", errors="replace",
            creationflags=_WIN_HIDDEN,
        )
        if result.returncode != 0:
            return False, ""
        running = set()
        for line in result.stdout.splitlines():
            # CSV: "name.exe","PID","Console","1","Mem"
            if line.startswith('"'):
                name = line.split(",", 1)[0].strip('"').lower()
                running.add(name)
        matches = targets & running
        if matches:
            return True, f"gaming detected ({', '.join(sorted(matches)[:3])})"
        return False, ""
    except (subprocess.TimeoutExpired, OSError):
        return False, ""


def gaming_or_paused() -> tuple[bool, str]:
    """Composite check: True if either pause active or gaming detected.
    Returns (skip_run, reason). Cron jobs use this to bail early."""
    paused, why = is_paused()
    if paused:
        return True, why
    gaming, why = is_gaming()
    if gaming:
        return True, why
    return False, ""


def should_run_today(script_name: str) -> bool:
    """True if the script has NOT run today (calendar day, local time)
    AND no gaming/pause is active."""
    skip, why = gaming_or_paused()
    if skip:
        print(f"[should_run] Skipping {script_name}: {why}")
        return False
    last = _read_marker(script_name)
    if last is None:
        return True
    return last.date() < datetime.now().date()


def should_run_this_week(script_name: str, weekday_target: int = 6) -> bool:
    """True if the script has NOT run this week AND today >= target weekday
    AND no gaming/pause is active.

    weekday_target: 0=Mon, 6=Sun. Default Sunday for weekly tasks.
    Logic: only fire from the target day onwards, and only once per week.
    """
    skip, why = gaming_or_paused()
    if skip:
        print(f"[should_run] Skipping {script_name}: {why}")
        return False
    today = datetime.now()
    if today.weekday() < weekday_target:
        return False
    last = _read_marker(script_name)
    if last is None:
        return True
    # Same week if both fall in [Mon..Sun] of the same calendar week
    days_diff = (today.date() - last.date()).days
    if days_diff >= 7:
        return True
    # Same week if last was earlier in the same week
    last_monday = last.date() - timedelta(days=last.weekday())
    today_monday = today.date() - timedelta(days=today.weekday())
    return last_monday < today_monday


def should_run_weekday(script_name: str) -> bool:
    """True if it's Mon-Fri AND the script has NOT run today AND not gaming/paused."""
    if datetime.now().weekday() >= 5:  # Sat, Sun
        return False
    return should_run_today(script_name)


def pause_for(hours: float, reason: str = "") -> Path:
    """Write paused-until marker for N hours from now. Returns the marker path."""
    COCKPIT_DIR.mkdir(parents=True, exist_ok=True)
    until = datetime.now() + timedelta(hours=hours)
    PAUSE_FILE.write_text(until.isoformat(timespec="seconds"), encoding="utf-8")
    return PAUSE_FILE


def resume() -> bool:
    """Remove pause marker. Returns True if there was a pause to remove."""
    if PAUSE_FILE.exists():
        PAUSE_FILE.unlink()
        return True
    return False


def mark_ran_today(script_name: str) -> None:
    """Record that the script ran successfully now."""
    _write_marker(script_name)


# CLI for manual testing/inspection
if __name__ == "__main__":
    import sys

    USAGE = (
        "Usage: should_run.py <action> [args]\n"
        "  Marker actions:\n"
        "    check <name> [<frequency>]  : print should_run result\n"
        "    mark <name>                 : write marker as 'now'\n"
        "    reset <name>                : remove marker\n"
        "    frequencies: today, weekday, weekly_sun, weekly_mon, weekly_fri\n"
        "  Pause actions (RAM-saving for gaming):\n"
        "    pause [<hours>]             : pause all crons for N hours (default 4)\n"
        "    resume                      : clear pause marker\n"
        "    status                      : show pause + gaming detection state\n"
        "  Game process list (auto-detection):\n"
        "    games list                  : show configured game processes\n"
        "    games add <process.exe>     : add to detection list\n"
        "    games remove <process.exe>  : remove from list\n"
        "    games reset                 : restore default list\n"
    )

    if len(sys.argv) < 2:
        print(USAGE)
        sys.exit(1)

    action = sys.argv[1]

    if action == "check":
        if len(sys.argv) < 3:
            print("check requires <name>")
            sys.exit(1)
        name = sys.argv[2]
        freq = sys.argv[3] if len(sys.argv) > 3 else "today"
        if freq == "today":
            print(should_run_today(name))
        elif freq == "weekday":
            print(should_run_weekday(name))
        elif freq.startswith("weekly_"):
            day = {"weekly_sun": 6, "weekly_mon": 0, "weekly_fri": 4}.get(freq, 6)
            print(should_run_this_week(name, weekday_target=day))
        else:
            print("unknown frequency")
            sys.exit(1)

    elif action == "mark":
        if len(sys.argv) < 3:
            print("mark requires <name>")
            sys.exit(1)
        mark_ran_today(sys.argv[2])
        print(f"Marked {sys.argv[2]} as ran now")

    elif action == "reset":
        if len(sys.argv) < 3:
            print("reset requires <name>")
            sys.exit(1)
        p = _marker_path(sys.argv[2])
        if p.exists():
            p.unlink()
            print(f"Reset {sys.argv[2]}")
        else:
            print(f"{sys.argv[2]} had no marker")

    elif action == "pause":
        hours = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0
        path = pause_for(hours)
        until = (datetime.now() + timedelta(hours=hours)).strftime("%H:%M")
        print(f"[pause] Cockpit paused until {until} ({hours}h). Marker: {path}")
        print("[pause] All cron jobs will skip until then. Run 'ultron resume' to clear.")

    elif action == "resume":
        if resume():
            print("[resume] Pause cleared - cron jobs will run normally.")
        else:
            print("[resume] No active pause.")

    elif action == "status":
        paused, pwhy = is_paused()
        gaming, gwhy = is_gaming()
        print(f"Paused : {'YES - ' + pwhy if paused else 'no'}")
        print(f"Gaming : {'YES - ' + gwhy if gaming else 'no'}")
        skip = paused or gaming
        print(f"Effect : cron jobs will {'SKIP' if skip else 'RUN'}")
        if not paused and not gaming:
            sys.exit(0)
        sys.exit(2)  # 2 = "active inhibitor present"

    elif action == "games":
        sub = sys.argv[2] if len(sys.argv) > 2 else "list"
        current = _load_game_processes()
        if sub == "list":
            src = "custom" if GAME_PROCESSES_FILE.exists() else "default"
            print(f"Game processes ({src}, {len(current)} entries):")
            for p in sorted(current):
                print(f"  {p}")
        elif sub == "add":
            if len(sys.argv) < 4:
                print("games add requires <process.exe>")
                sys.exit(1)
            new = sys.argv[3].lower()
            if new in current:
                print(f"Already present: {new}")
            else:
                current.append(new)
                COCKPIT_DIR.mkdir(parents=True, exist_ok=True)
                GAME_PROCESSES_FILE.write_text("\n".join(sorted(current)) + "\n",
                                                encoding="utf-8")
                print(f"Added: {new}")
        elif sub == "remove":
            if len(sys.argv) < 4:
                print("games remove requires <process.exe>")
                sys.exit(1)
            target = sys.argv[3].lower()
            if target not in current:
                print(f"Not in list: {target}")
                sys.exit(1)
            current.remove(target)
            COCKPIT_DIR.mkdir(parents=True, exist_ok=True)
            GAME_PROCESSES_FILE.write_text("\n".join(sorted(current)) + "\n",
                                            encoding="utf-8")
            print(f"Removed: {target}")
        elif sub == "reset":
            if GAME_PROCESSES_FILE.exists():
                GAME_PROCESSES_FILE.unlink()
                print("Reset to default list (custom file deleted)")
            else:
                print("Already using default list")
        else:
            print(f"Unknown games action: {sub}")
            sys.exit(1)

    else:
        print(f"Unknown action: {action}")
        print(USAGE)
        sys.exit(1)
