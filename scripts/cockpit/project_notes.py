#!/usr/bin/env python3
"""
ULTRON v10.7 Cockpit — Project notes (persistent, per-project).

Notes are stored in ~/.ultron/cockpit/notes/<project_id>.md
Each note is a timestamped fenced entry. The last N notes can be
injected into .claude/context.md for warm-start sessions (--resume).

Subcommands:
    save <id> <text>     Append timestamped note
    list <id> [--n N]    Print last N notes (default 10)
    export <id> [--n N]  Print as markdown block for context injection

Usage:
    python project_notes.py save ultron "stopped at MCP broker wiring"
    python project_notes.py list ultron
    python project_notes.py export ultron --n 5
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import COCKPIT_DIR, Cockpit  # noqa: E402

NOTES_DIR = COCKPIT_DIR / "notes"


def _notes_file(project_id: str) -> Path:
    return NOTES_DIR / f"{project_id}.md"


def _parse_notes(text: str) -> list[tuple[str, str]]:
    """Return [(timestamp, body), ...] from raw notes file content."""
    entries: list[tuple[str, str]] = []
    current_ts = ""
    current_lines: list[str] = []

    for line in text.splitlines():
        if line.startswith("**") and "**" in line[2:] and "—" in line:
            if current_ts:
                entries.append((current_ts, "\n".join(current_lines).strip()))
            current_ts = line
            current_lines = []
        elif line == "---":
            continue
        else:
            current_lines.append(line)

    if current_ts:
        entries.append((current_ts, "\n".join(current_lines).strip()))

    return entries


def cmd_save(project_id: str, text: str) -> int:
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    nf = _notes_file(project_id)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    entry = f"\n---\n**{ts}** — {text.strip()}\n"
    with nf.open("a", encoding="utf-8") as f:
        f.write(entry)
    print(f"[notes] saved note for {project_id} at {ts}")
    return 0


def cmd_list(project_id: str, n: int = 10) -> int:
    nf = _notes_file(project_id)
    if not nf.exists():
        print(f"[notes] no notes for {project_id}")
        return 0
    entries = _parse_notes(nf.read_text(encoding="utf-8"))
    for ts, body in entries[-n:]:
        print(f"  {ts}")
        if body:
            print(f"    {body}")
    print(f"\n[notes] {len(entries)} total for {project_id}")
    return 0


def cmd_delete(project_id: str, index: int) -> int:
    """Delete note by 1-based index (positive = from start, negative = from end)."""
    nf = _notes_file(project_id)
    if not nf.exists():
        print(f"[notes] no notes for {project_id}")
        return 1
    entries = _parse_notes(nf.read_text(encoding="utf-8"))
    if not entries:
        print(f"[notes] no notes for {project_id}")
        return 1
    # Convert to 0-based, support negative indexing
    try:
        if index == 0:
            raise IndexError
        idx = (index - 1) if index > 0 else index
        target_ts, target_body = entries[idx]
    except IndexError:
        print(f"[notes] index {index} out of range (1..{len(entries)})")
        return 1
    entries.pop(idx)
    # Rewrite the whole file
    nf.write_text("", encoding="utf-8")
    for ts, body in entries:
        entry = f"\n---\n{ts}\n"
        if body:
            entry += body + "\n"
        with nf.open("a", encoding="utf-8") as f:
            f.write(entry)
    print(f"[notes] deleted note {index} for {project_id}: {target_ts}")
    return 0


def cmd_export(project_id: str, n: int = 5) -> int:
    """Print a markdown fenced block suitable for context.md injection."""
    nf = _notes_file(project_id)
    if not nf.exists():
        return 0
    entries = _parse_notes(nf.read_text(encoding="utf-8"))
    if not entries:
        return 0
    recent = entries[-n:]
    print(f"## Session notes (last {len(recent)})\n")
    for ts, body in recent:
        line = ts
        if body:
            line += f"\n  {body}"
        print(line)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="ULTRON project notes")
    sub = p.add_subparsers(dest="cmd")

    sv = sub.add_parser("save")
    sv.add_argument("project_id")
    sv.add_argument("text", nargs="+")

    lv = sub.add_parser("list")
    lv.add_argument("project_id")
    lv.add_argument("--n", type=int, default=10)

    ev = sub.add_parser("export")
    ev.add_argument("project_id")
    ev.add_argument("--n", type=int, default=5)

    dv = sub.add_parser("delete", help="delete note by index (1=oldest, -1=newest)")
    dv.add_argument("project_id")
    dv.add_argument("index", type=int,
                    help="1-based index (positive=from start, negative=from end, e.g. -1=last)")

    args = p.parse_args()
    if not args.cmd:
        p.print_help()
        return 1

    Cockpit.ensure_dirs()

    if args.cmd == "save":
        return cmd_save(args.project_id, " ".join(args.text))
    if args.cmd == "list":
        return cmd_list(args.project_id, args.n)
    if args.cmd == "export":
        return cmd_export(args.project_id, args.n)
    if args.cmd == "delete":
        return cmd_delete(args.project_id, args.index)
    return 1


if __name__ == "__main__":
    sys.exit(main())
