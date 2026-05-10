#!/usr/bin/env python3
"""
ULTRON v13.2 — Changelog Registry (registro estructurado de cambios).

Changelog append-only con dedup por hash. Reemplaza el modelo de
"edita changelog.md manualmente" por un registro machine+human readable.

Storage: ~/.ultron/cockpit/changelog.ndjson  (append-only NDJSON, source of truth)
View:    ~/.ultron/cockpit/changelog_table.md (tabla compacta auto-generada, ≤50 entries)

Schema de entrada:
{
  id:          sha256(ts+scope+title)[:8],   # dedup key
  ts:          "2026-05-03T21:00:00",
  type:        "fix|feat|change|error|resolve|audit|refactor",
  scope:       "pending_actions|apply_proposals|audit|skill|hook|vault|session",
  title:       "Short title ≤80 chars",
  body:        "",          # opcional
  related_ids: [],          # IDs de pending actions, audits, etc.
  applied_by:  "claude|codex|human|auto"
}

CLI:
    changelog_registry.py add --type fix --scope pending --title "..." [--body ...] [--related FIX-1]
    changelog_registry.py list [--last N] [--type fix] [--scope audit]
    changelog_registry.py table [--last N]   # genera/imprime tabla markdown
    changelog_registry.py errors [--last N]  # solo entradas type=error
    changelog_registry.py search <text>      # búsqueda en title+body
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from ultron_paths import COCKPIT_DIR

CHANGELOG_NDJSON = COCKPIT_DIR / "changelog.ndjson"
CHANGELOG_TABLE  = COCKPIT_DIR / "changelog_table.md"

VALID_TYPES  = {"fix", "feat", "change", "error", "resolve", "audit", "refactor", "security"}
VALID_SCOPES = {"pending_actions", "apply_proposals", "audit", "skill", "hook",
                "vault", "session", "changelog", "settings", "cockpit", "memory", "other"}

TYPE_GLYPH = {
    "fix":       "🔧",
    "feat":      "✨",
    "change":    "🔄",
    "error":     "❌",
    "resolve":   "✅",
    "audit":     "🔍",
    "refactor":  "♻️",
    "security":  "🔐",
}


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _make_id(ts: str, scope: str, title: str) -> str:
    raw = f"{ts}|{scope}|{title}"
    return hashlib.sha256(raw.encode()).hexdigest()[:8]


def _load_all() -> list[dict]:
    if not CHANGELOG_NDJSON.exists():
        return []
    entries = []
    for line in CHANGELOG_NDJSON.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


def add_entry(type_: str, scope: str, title: str, body: str = "",
              related_ids: list[str] | None = None,
              applied_by: str = "claude") -> dict:
    ts = _now_iso()
    id_ = _make_id(ts, scope, title)
    entry = {
        "id": id_,
        "ts": ts,
        "type": type_,
        "scope": scope,
        "title": title[:80],
        "body": body[:500] if body else "",
        "related_ids": related_ids or [],
        "applied_by": applied_by,
    }
    CHANGELOG_NDJSON.parent.mkdir(parents=True, exist_ok=True)
    # Dedup: skip if same scope+title in last 60 seconds
    if CHANGELOG_NDJSON.exists():
        lines = CHANGELOG_NDJSON.read_text(encoding="utf-8").splitlines()
        for line in lines[-20:]:
            try:
                prev = json.loads(line)
                if (prev.get("scope") == scope and prev.get("title") == title[:80]
                        and abs((datetime.fromisoformat(ts) -
                                 datetime.fromisoformat(prev["ts"])).total_seconds()) < 60):
                    return prev  # duplicate within 60s
            except (json.JSONDecodeError, ValueError, KeyError):
                pass
    with CHANGELOG_NDJSON.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    _regen_table()
    return entry


def _regen_table(last: int = 50) -> None:
    entries = _load_all()
    entries_sorted = sorted(entries, key=lambda e: e.get("ts", ""), reverse=True)[:last]
    lines = [
        "# ULTRON Changelog (últimas entradas)",
        f"> Auto-generado · {_now_iso()} · fuente: changelog.ndjson",
        "",
        "| ts | type | scope | title | related | by |",
        "|---|---|---|---|---|---|",
    ]
    for e in entries_sorted:
        ts_short  = e.get("ts", "")[:16]
        glyph     = TYPE_GLYPH.get(e.get("type", ""), "·")
        type_str  = f"{glyph} {e.get('type','?')}"
        scope     = e.get("scope", "?")[:20]
        title     = e.get("title", "?")[:50]
        related   = ", ".join(e.get("related_ids", []))[:20]
        by        = e.get("applied_by", "?")[:10]
        lines.append(f"| {ts_short} | {type_str} | {scope} | {title} | {related} | {by} |")
    CHANGELOG_TABLE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def cmd_add(args) -> int:
    type_ = args.type.lower()
    scope = args.scope.lower()
    if type_ not in VALID_TYPES:
        print(f"[changelog] invalid type '{type_}'. Valid: {sorted(VALID_TYPES)}", file=sys.stderr)
        return 1
    related = [r.strip() for r in (args.related or "").split(",") if r.strip()]
    entry = add_entry(type_, scope, args.title,
                      body=args.body or "",
                      related_ids=related,
                      applied_by=args.by or "claude")
    print(f"[changelog] {entry['id']}  {entry['ts']}  {entry['type']}:{entry['scope']}  {entry['title']}")
    return 0


def cmd_list(args) -> int:
    entries = _load_all()
    if args.type:
        entries = [e for e in entries if e.get("type") == args.type]
    if args.scope:
        entries = [e for e in entries if e.get("scope") == args.scope]
    entries = sorted(entries, key=lambda e: e.get("ts", ""), reverse=True)[:args.last]
    if not entries:
        print("[changelog] no entries matching filters")
        return 0
    for e in reversed(entries):
        g = TYPE_GLYPH.get(e.get("type", ""), "·")
        rel = f" [{', '.join(e.get('related_ids',[]))}]" if e.get("related_ids") else ""
        print(f"{e['ts'][:16]}  {g}{e['type']:<12} {e['scope']:<20} {e['title'][:50]}{rel}")
    return 0


def cmd_table(args) -> int:
    _regen_table(args.last)
    print(CHANGELOG_TABLE.read_text(encoding="utf-8"))
    return 0


def cmd_errors(args) -> int:
    entries = _load_all()
    errors = [e for e in entries if e.get("type") == "error"]
    errors = sorted(errors, key=lambda e: e.get("ts", ""), reverse=True)[:args.last]
    if not errors:
        print("[changelog] no error entries recorded")
        return 0
    print(f"ERROR REGISTRY ({len(errors)} entries)")
    print("=" * 70)
    for e in reversed(errors):
        print(f"{e['ts'][:16]}  scope={e['scope']:<20} {e['title']}")
        if e.get("body"):
            print(f"              {e['body'][:100]}")
    return 0


def cmd_search(args) -> int:
    q = args.query.lower()
    entries = _load_all()
    matches = [e for e in entries
               if q in e.get("title", "").lower() or q in e.get("body", "").lower()
               or q in " ".join(e.get("related_ids", [])).lower()]
    matches = sorted(matches, key=lambda e: e.get("ts", ""), reverse=True)[:20]
    if not matches:
        print(f"[changelog] no matches for '{args.query}'")
        return 0
    for e in reversed(matches):
        g = TYPE_GLYPH.get(e.get("type", ""), "·")
        print(f"{e['ts'][:16]}  {g}{e['type']:<10} {e['title']}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="ULTRON Changelog Registry")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("add", help="Añade entrada al changelog")
    sp.add_argument("--type",    required=True, help=f"Tipo: {', '.join(sorted(VALID_TYPES))}")
    sp.add_argument("--scope",   required=True, help=f"Scope: {', '.join(sorted(VALID_SCOPES))}")
    sp.add_argument("--title",   required=True)
    sp.add_argument("--body",    default="")
    sp.add_argument("--related", default="", metavar="ID1,ID2", help="IDs relacionados (comma-separated)")
    sp.add_argument("--by",      default="claude", metavar="APPLIED_BY")
    sp.set_defaults(func=cmd_add)

    sp = sub.add_parser("list", help="Lista entradas recientes")
    sp.add_argument("--last",  type=int, default=20)
    sp.add_argument("--type",  default=None)
    sp.add_argument("--scope", default=None)
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("table", help="Genera/imprime tabla markdown")
    sp.add_argument("--last", type=int, default=50)
    sp.set_defaults(func=cmd_table)

    sp = sub.add_parser("errors", help="Solo entradas type=error")
    sp.add_argument("--last", type=int, default=20)
    sp.set_defaults(func=cmd_errors)

    sp = sub.add_parser("search", help="Búsqueda en title+body")
    sp.add_argument("query")
    sp.set_defaults(func=cmd_search)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
