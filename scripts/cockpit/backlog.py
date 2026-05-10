#!/usr/bin/env python3
"""ULTRON Backlog CLI — manage ~/.ultron/roadmap/{backlog,decisions}.yaml.

Commands:
    backlog list [--pending] [--sprint X] [--priority P0-P3] [--status S]
    backlog show <id>
    backlog add "<title>" [--sprint X] [--priority P2] [--tags a,b,c]
    backlog start <id>
    backlog done <id> [--decision D-XXX]
    backlog cancel <id>

    decision list [--recent] [--affects U-XXX]
    decision show <id>
    decision add "<title>" --chosen "..." [--alt "..."]* [--why "..."]

Plus:
    summary              one-line overview (counts by status/sprint)
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

try:
    import yaml
except ImportError:
    print("[backlog] PyYAML required. Install: uv pip install pyyaml", file=sys.stderr)
    sys.exit(2)


ROADMAP_DIR = Path.home() / ".ultron" / "roadmap"
BACKLOG_FILE = ROADMAP_DIR / "backlog.yaml"
DECISIONS_FILE = ROADMAP_DIR / "decisions.yaml"

VALID_STATUS = {"ideated", "spec", "ready", "in_progress", "done", "cancelled"}
VALID_PRIORITY = {"P0", "P1", "P2", "P3"}

STATUS_GLYPH = {
    "ideated": "○",
    "spec": "◐",
    "ready": "☐",
    "in_progress": "▶",
    "done": "✓",
    "cancelled": "✗",
}

PRIORITY_COLOR = {
    "P0": "\033[91m",  # red
    "P1": "\033[93m",  # yellow
    "P2": "\033[96m",  # cyan
    "P3": "\033[90m",  # grey
}
RESET = "\033[0m"


def _load(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema_version": 1, "items" if "backlog" in path.name else "decisions": []}
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _save(path: Path, data: dict[str, Any]) -> None:
    data["last_updated"] = dt.date.today().isoformat()
    with path.open("w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True, width=100)


def _next_id(items: list[dict], prefix: str) -> str:
    """Return next sequential ID like U-046 or D-012."""
    nums = []
    for it in items:
        sid = it.get("id", "")
        if sid.startswith(f"{prefix}-"):
            try:
                nums.append(int(sid.split("-")[1]))
            except (ValueError, IndexError):
                pass
    next_num = (max(nums) + 1) if nums else 1
    return f"{prefix}-{next_num:03d}"


def _find(items: list[dict], item_id: str) -> dict | None:
    for it in items:
        if it.get("id") == item_id:
            return it
    return None


def _fmt_item_line(item: dict, color: bool = True) -> str:
    glyph = STATUS_GLYPH.get(item.get("status", "ideated"), "?")
    pri = item.get("priority", "P?")
    sprint = item.get("sprint") or "-"
    title = item.get("title", "")
    iid = item.get("id", "?")
    if color:
        c = PRIORITY_COLOR.get(pri, "")
        return f"  {glyph} {c}{iid}{RESET} [{pri}] [{sprint}]  {title}"
    return f"  {glyph} {iid} [{pri}] [{sprint}]  {title}"


# ─── Commands: backlog ────────────────────────────────────────────────────────

def cmd_backlog_list(args) -> int:
    data = _load(BACKLOG_FILE)
    items = data.get("items", [])

    filtered = items
    if args.pending:
        filtered = [i for i in filtered if i.get("status") not in ("done", "cancelled")]
    if args.sprint:
        filtered = [i for i in filtered if i.get("sprint") == args.sprint]
    if args.priority:
        filtered = [i for i in filtered if i.get("priority") == args.priority]
    if args.status:
        filtered = [i for i in filtered if i.get("status") == args.status]

    # Group by sprint
    by_sprint: dict[str, list] = {}
    for it in filtered:
        sp = it.get("sprint") or "(backlog)"
        by_sprint.setdefault(sp, []).append(it)

    color = sys.stdout.isatty()
    total = len(filtered)
    print(f"ULTRON Backlog — {total} item(s)")
    for sp in sorted(by_sprint.keys()):
        print(f"\n[{sp}]")
        for it in sorted(by_sprint[sp], key=lambda x: (x.get("priority", "P9"), x.get("id"))):
            print(_fmt_item_line(it, color))
    return 0


def cmd_backlog_show(args) -> int:
    data = _load(BACKLOG_FILE)
    item = _find(data.get("items", []), args.id)
    if not item:
        print(f"[backlog] not found: {args.id}", file=sys.stderr)
        return 1
    print(yaml.safe_dump(item, sort_keys=False, allow_unicode=True, width=100))
    return 0


def cmd_backlog_add(args) -> int:
    data = _load(BACKLOG_FILE)
    items = data.setdefault("items", [])
    new_id = _next_id(items, "U")
    today = dt.date.today().isoformat()

    item: dict[str, Any] = {
        "id": new_id,
        "title": args.title,
        "status": args.status,
        "priority": args.priority,
        "sprint": args.sprint,
        "created": today,
    }
    if args.tags:
        item["tags"] = [t.strip() for t in args.tags.split(",") if t.strip()]
    if args.description:
        item["description"] = args.description

    items.append(item)
    _save(BACKLOG_FILE, data)
    print(f"[backlog] added {new_id}: {args.title}")
    return 0


def cmd_backlog_start(args) -> int:
    data = _load(BACKLOG_FILE)
    item = _find(data.get("items", []), args.id)
    if not item:
        print(f"[backlog] not found: {args.id}", file=sys.stderr)
        return 1
    item["status"] = "in_progress"
    item["started"] = dt.date.today().isoformat()
    _save(BACKLOG_FILE, data)
    print(f"[backlog] {args.id} → in_progress")
    return 0


def cmd_backlog_done(args) -> int:
    data = _load(BACKLOG_FILE)
    item = _find(data.get("items", []), args.id)
    if not item:
        print(f"[backlog] not found: {args.id}", file=sys.stderr)
        return 1
    item["status"] = "done"
    item["completed"] = dt.date.today().isoformat()
    if args.decision:
        related = item.setdefault("related_decisions", [])
        if args.decision not in related:
            related.append(args.decision)
    _save(BACKLOG_FILE, data)
    print(f"[backlog] {args.id} → done")
    return 0


def cmd_backlog_cancel(args) -> int:
    data = _load(BACKLOG_FILE)
    item = _find(data.get("items", []), args.id)
    if not item:
        print(f"[backlog] not found: {args.id}", file=sys.stderr)
        return 1
    item["status"] = "cancelled"
    item["completed"] = dt.date.today().isoformat()
    if args.reason:
        item.setdefault("notes", "")
        item["notes"] = (item["notes"] + f"\n\nCancelled {item['completed']}: {args.reason}").strip()
    _save(BACKLOG_FILE, data)
    print(f"[backlog] {args.id} → cancelled")
    return 0


# ─── Commands: decisions ──────────────────────────────────────────────────────

def cmd_decision_list(args) -> int:
    data = _load(DECISIONS_FILE)
    decisions = data.get("decisions", [])

    if args.recent:
        decisions = sorted(decisions, key=lambda x: x.get("date", ""), reverse=True)[:10]
    if args.affects:
        decisions = [d for d in decisions if args.affects in (d.get("affects") or [])]

    color = sys.stdout.isatty()
    for d in decisions:
        did = d.get("id", "?")
        date = d.get("date", "?")
        title = d.get("title", "")
        c = "\033[95m" if color else ""  # magenta
        print(f"  {c}{did}{RESET if color else ''}  ({date})  {title}")
    print(f"\n{len(decisions)} decision(s)")
    return 0


def cmd_decision_show(args) -> int:
    data = _load(DECISIONS_FILE)
    decision = _find(data.get("decisions", []), args.id)
    if not decision:
        print(f"[decision] not found: {args.id}", file=sys.stderr)
        return 1
    print(yaml.safe_dump(decision, sort_keys=False, allow_unicode=True, width=100))
    return 0


def cmd_decision_add(args) -> int:
    data = _load(DECISIONS_FILE)
    decisions = data.setdefault("decisions", [])
    new_id = _next_id(decisions, "D")
    today = dt.date.today().isoformat()

    decision: dict[str, Any] = {
        "id": new_id,
        "date": today,
        "title": args.title,
        "chosen": args.chosen,
    }
    if args.alt:
        decision["alternatives_considered"] = [
            {"option": a.split("|", 1)[0].strip(),
             "why_rejected": a.split("|", 1)[1].strip() if "|" in a else "(no reason given)"}
            for a in args.alt
        ]
    if args.why:
        decision["rationale"] = args.why
    if args.affects:
        decision["affects"] = [a.strip() for a in args.affects.split(",") if a.strip()]

    decisions.append(decision)
    _save(DECISIONS_FILE, data)
    print(f"[decision] added {new_id}: {args.title}")
    return 0


# ─── Summary ─────────────────────────────────────────────────────────────────

def cmd_summary(_args) -> int:
    bdata = _load(BACKLOG_FILE)
    ddata = _load(DECISIONS_FILE)
    items = bdata.get("items", [])
    decisions = ddata.get("decisions", [])

    by_status: dict[str, int] = {}
    by_sprint: dict[str, int] = {}
    for it in items:
        by_status[it.get("status", "?")] = by_status.get(it.get("status", "?"), 0) + 1
        sp = it.get("sprint") or "(backlog)"
        by_sprint[sp] = by_sprint.get(sp, 0) + 1

    print(f"ULTRON Roadmap Summary  ({BACKLOG_FILE.parent})")
    print(f"  Items:     {len(items)}")
    for s in ("ideated", "spec", "ready", "in_progress", "done", "cancelled"):
        if s in by_status:
            print(f"    {STATUS_GLYPH[s]} {s:13s} {by_status[s]}")
    print(f"\n  Sprints:")
    for sp in sorted(by_sprint.keys()):
        print(f"    {sp:14s} {by_sprint[sp]}")
    print(f"\n  Decisions: {len(decisions)}")
    return 0


# ─── argparse wiring ─────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(prog="backlog", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    # backlog list
    pl = sub.add_parser("list", help="List items")
    pl.add_argument("--pending", action="store_true", help="exclude done/cancelled")
    pl.add_argument("--sprint")
    pl.add_argument("--priority", choices=sorted(VALID_PRIORITY))
    pl.add_argument("--status", choices=sorted(VALID_STATUS))
    pl.set_defaults(func=cmd_backlog_list)

    # backlog show
    ps = sub.add_parser("show", help="Show item detail")
    ps.add_argument("id")
    ps.set_defaults(func=cmd_backlog_show)

    # backlog add
    pa = sub.add_parser("add", help="Add new item")
    pa.add_argument("title")
    pa.add_argument("--sprint", default=None)
    pa.add_argument("--priority", choices=sorted(VALID_PRIORITY), default="P2")
    pa.add_argument("--status", choices=sorted(VALID_STATUS), default="ideated")
    pa.add_argument("--tags", help="comma-separated")
    pa.add_argument("--description", default=None)
    pa.set_defaults(func=cmd_backlog_add)

    # backlog start / done / cancel
    pst = sub.add_parser("start", help="Mark in_progress")
    pst.add_argument("id"); pst.set_defaults(func=cmd_backlog_start)

    pdn = sub.add_parser("done", help="Mark done")
    pdn.add_argument("id")
    pdn.add_argument("--decision", help="related decision ID (D-XXX)")
    pdn.set_defaults(func=cmd_backlog_done)

    pcn = sub.add_parser("cancel", help="Mark cancelled")
    pcn.add_argument("id")
    pcn.add_argument("--reason")
    pcn.set_defaults(func=cmd_backlog_cancel)

    # decision sub-cmds
    pdl = sub.add_parser("decision-list", help="List decisions")
    pdl.add_argument("--recent", action="store_true", help="last 10")
    pdl.add_argument("--affects", help="filter by affected item ID")
    pdl.set_defaults(func=cmd_decision_list)

    pds = sub.add_parser("decision-show", help="Show decision")
    pds.add_argument("id"); pds.set_defaults(func=cmd_decision_show)

    pda = sub.add_parser("decision-add", help="Add decision")
    pda.add_argument("title")
    pda.add_argument("--chosen", required=True, help="What was chosen")
    pda.add_argument("--alt", action="append", default=[],
                     help='Alternative considered. Format: "option|why_rejected" (repeatable)')
    pda.add_argument("--why", help="Rationale for the chosen option")
    pda.add_argument("--affects", help="comma-separated item IDs")
    pda.set_defaults(func=cmd_decision_add)

    # summary
    psm = sub.add_parser("summary", help="One-line overview")
    psm.set_defaults(func=cmd_summary)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
