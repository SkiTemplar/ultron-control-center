#!/usr/bin/env python3
"""
ULTRON v12.4 — Session Replay (Task 10C)

Appends structured events to ~/.ultron/sessions/YYYY-MM-DD/replay.jsonl.
Used by Stop hook to persist a lightweight replay trail per session.

Schema per event:
  ts, session_id, event_type, persona, mode, input_summary,
  output_summary, token_cost, duration_sec, outcome, notes

Commands:
    session_replay.py append <event_type> [opts]   Append one event
    session_replay.py show [--date YYYY-MM-DD]     Print today's (or date's) replay
    session_replay.py list                          List all session dates
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SESSIONS_DIR = Path.home() / ".ultron" / "sessions"

VALID_EVENT_TYPES = {
    "session_start", "session_end",
    "persona_invoked", "plugin_invoked",
    "tool_call", "memory_read", "memory_write",
    "dual_mode_start", "dual_mode_end",
    "error", "escalation", "user_signal",
}


def _session_dir(date_str: str | None = None) -> Path:
    if date_str is None:
        date_str = datetime.now().strftime("%Y-%m-%d")
    return SESSIONS_DIR / date_str


def _replay_path(date_str: str | None = None) -> Path:
    return _session_dir(date_str) / "replay.jsonl"


def append_event(
    event_type: str,
    *,
    session_id: str = "",
    persona: str = "",
    mode: str = "MEDIUM",
    input_summary: str = "",
    output_summary: str = "",
    token_cost: int = 0,
    duration_sec: float = 0.0,
    outcome: str = "success",
    notes: str = "",
) -> None:
    """Append one structured event to today's replay.jsonl."""
    if event_type not in VALID_EVENT_TYPES:
        event_type = "tool_call"  # safe default

    event = {
        "ts":             datetime.now(timezone.utc).isoformat(),
        "session_id":     session_id,
        "event_type":     event_type,
        "persona":        persona,
        "mode":           mode,
        "input_summary":  input_summary[:200] if input_summary else "",
        "output_summary": output_summary[:200] if output_summary else "",
        "token_cost":     token_cost,
        "duration_sec":   round(duration_sec, 2),
        "outcome":        outcome,
        "notes":          notes[:500] if notes else "",
    }

    replay = _replay_path()
    replay.parent.mkdir(parents=True, exist_ok=True)
    with replay.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def cmd_append(args) -> int:
    append_event(
        args.event_type,
        session_id=getattr(args, "session_id", ""),
        persona=getattr(args, "persona", ""),
        mode=getattr(args, "mode", "MEDIUM"),
        input_summary=getattr(args, "input", ""),
        output_summary=getattr(args, "output", ""),
        token_cost=getattr(args, "tokens", 0),
        duration_sec=getattr(args, "duration", 0.0),
        outcome=getattr(args, "outcome", "success"),
        notes=getattr(args, "notes", ""),
    )
    replay = _replay_path()
    print(f"[replay] Appended {args.event_type!r}  →  {replay}")
    return 0


def cmd_show(args) -> int:
    date_str = getattr(args, "date", None)
    replay = _replay_path(date_str)
    if not replay.exists():
        label = date_str or datetime.now().strftime("%Y-%m-%d")
        print(f"[replay] No replay for {label}")
        return 1

    lines = replay.read_text(encoding="utf-8").strip().splitlines()
    print(f"\nSession Replay  [{replay.parent.name}]  {len(lines)} events")
    print("=" * 70)
    for raw in lines:
        try:
            ev = json.loads(raw)
            ts = ev.get("ts", "")[:16].replace("T", " ")
            persona = ev.get("persona") or "-"
            mode = ev.get("mode", "?")
            etype = ev.get("event_type", "?")
            outcome = ev.get("outcome", "?")
            tokens = ev.get("token_cost", 0)
            summary = ev.get("input_summary", "") or ev.get("output_summary", "")
            print(f"  {ts}  [{etype:<20}]  persona={persona:<15} mode={mode:<6} "
                  f"outcome={outcome:<8} tokens={tokens}")
            if summary:
                print(f"    {summary[:80]}{'…' if len(summary) > 80 else ''}")
        except (json.JSONDecodeError, KeyError):
            print(f"  [malformed] {raw[:80]}")
    print()
    return 0


def cmd_list(_args) -> int:
    if not SESSIONS_DIR.exists():
        print("[replay] No sessions directory found.")
        return 1
    dates = sorted(
        [d.name for d in SESSIONS_DIR.iterdir()
         if d.is_dir() and (d / "replay.jsonl").exists()],
        reverse=True
    )
    if not dates:
        print("[replay] No replay files found yet.")
        return 0
    print(f"\nSession Replay Dates  ({len(dates)} total)")
    for date_str in dates[:20]:
        replay = _replay_path(date_str)
        count = len(replay.read_text(encoding="utf-8").strip().splitlines())
        print(f"  {date_str}  ({count} events)")
    if len(dates) > 20:
        print(f"  … and {len(dates) - 20} more")
    print()
    return 0


def main() -> int:
    import argparse
    p = argparse.ArgumentParser(description="ULTRON v12.4 Session Replay")
    sub = p.add_subparsers(dest="cmd", required=True)

    ap = sub.add_parser("append", help="Append one event to today's replay.jsonl")
    ap.add_argument("event_type", choices=sorted(VALID_EVENT_TYPES))
    ap.add_argument("--session-id", dest="session_id", default="")
    ap.add_argument("--persona", default="")
    ap.add_argument("--mode", default="MEDIUM")
    ap.add_argument("--input", default="")
    ap.add_argument("--output", default="")
    ap.add_argument("--tokens", type=int, default=0)
    ap.add_argument("--duration", type=float, default=0.0)
    ap.add_argument("--outcome", default="success")
    ap.add_argument("--notes", default="")

    sp = sub.add_parser("show", help="Print a session's replay")
    sp.add_argument("--date", default=None, help="YYYY-MM-DD (default: today)")

    sub.add_parser("list", help="List all session dates with replay files")

    args = p.parse_args()
    if args.cmd == "append": return cmd_append(args)
    if args.cmd == "show":   return cmd_show(args)
    if args.cmd == "list":   return cmd_list(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
