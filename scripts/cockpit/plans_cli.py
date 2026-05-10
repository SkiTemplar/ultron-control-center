"""ULTRON — sistema unificado de planes.

Single source: ~/.ultron/plans/PLANS.json
Renderer:       ~/.ultron/plans/MASTER-pendientes.md (auto-generado)

Comandos:
    ultron plans list [--status open|all] [--kind X] [--priority P]
    ultron plans show <id>
    ultron plans add <title> --kind X [--priority P] [--effort N-M]
                              [--tags a,b,c] [--spec <path>]
    ultron plans done <id> [--note "..."]
    ultron plans defer <id> [--reason "..."]
    ultron plans reopen <id>
    ultron plans clean       # archiva resueltos >30d
    ultron plans render      # regenera MASTER-pendientes.md
    ultron plans status      # totals por status / kind / priority

Schema item:
    id            slug único
    kind          sprint | bug | polish | research | new-direction | hotfix
    title         str
    status        open | in-progress | resolved | deferred
    priority      p0 | p1 | p2
    effort_hours  [low, high]   o null
    tags          list[str]
    spec_path     ruta a un .md con detalle (opcional)
    description   texto corto (no es el spec)
    created_at    ISO
    resolved_at   ISO | null
    deferred_reason str | null
    notes         list[{ts, text}]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter

# Windows cmd.exe defaults a cp1252 — fuerza UTF-8 para que el rendering
# de iconos/acentos no rompa cuando ultron.ps1 invoca este script.
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

ULTRON_HOME = Path.home() / ".ultron"
PLANS_DIR = ULTRON_HOME / "plans"
PLANS_JSON = PLANS_DIR / "PLANS.json"
MASTER_MD = PLANS_DIR / "MASTER-pendientes.md"
ARCHIVE_DIR = PLANS_DIR / "_archive"

VALID_KINDS = ("sprint", "bug", "polish", "research", "new-direction", "hotfix")
VALID_STATUS = ("open", "in-progress", "resolved", "deferred")
VALID_PRIORITY = ("p0", "p1", "p2")


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _slugify(text: str) -> str:
    out = []
    for ch in text.lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in (" ", "-", "_", "/"):
            out.append("-")
    slug = "".join(out).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug[:50] or "untitled"


def load_plans() -> dict[str, Any]:
    if not PLANS_JSON.exists():
        return {"version": "1.0", "updated_at": _now_iso(), "items": []}
    # utf-8-sig tolera BOM que PowerShell `Set-Content -Encoding UTF8` añade.
    try:
        return json.loads(PLANS_JSON.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        print(f"[plans] PLANS.json corrupto: {exc}", file=sys.stderr)
        sys.exit(2)


def save_plans(data: dict[str, Any]) -> None:
    PLANS_DIR.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = _now_iso()
    PLANS_JSON.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def find_item(data: dict[str, Any], item_id: str) -> dict[str, Any] | None:
    item_id_lower = item_id.lower()
    for it in data["items"]:
        if it["id"].lower() == item_id_lower:
            return it
    # Permitir match parcial si es único
    matches = [it for it in data["items"]
               if item_id_lower in it["id"].lower()]
    if len(matches) == 1:
        return matches[0]
    return None


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_list(args) -> int:
    data = load_plans()
    items = data["items"]
    if args.status and args.status != "all":
        items = [it for it in items if it["status"] == args.status]
    if args.kind:
        items = [it for it in items if it["kind"] == args.kind]
    if args.priority:
        items = [it for it in items if it.get("priority") == args.priority]

    if not items:
        print("[plans] sin items que coincidan")
        return 0

    # Sort: priority then status then id
    pri_rank = {"p0": 0, "p1": 1, "p2": 2}
    status_rank = {"in-progress": 0, "open": 1, "deferred": 2, "resolved": 3}
    items = sorted(items, key=lambda it: (
        pri_rank.get(it.get("priority", "p2"), 9),
        status_rank.get(it["status"], 9),
        it["id"],
    ))

    for it in items:
        eff = it.get("effort_hours")
        eff_s = f"{eff[0]}-{eff[1]}h" if eff else "—"
        pri = it.get("priority", "—")
        print(f"  [{it['status']:<11}] {pri} {it['kind']:<13} "
              f"{it['id']:<28} {eff_s:>6}  {it['title'][:60]}")
    print(f"\n  total: {len(items)}")
    return 0


def cmd_show(args) -> int:
    data = load_plans()
    it = find_item(data, args.id)
    if not it:
        print(f"[plans] no encontrado: {args.id}", file=sys.stderr)
        return 1
    print(json.dumps(it, ensure_ascii=False, indent=2))
    return 0


def cmd_add(args) -> int:
    if args.kind not in VALID_KINDS:
        print(f"[plans] kind inválido. Válidos: {VALID_KINDS}", file=sys.stderr)
        return 2
    if args.priority and args.priority not in VALID_PRIORITY:
        print(f"[plans] priority inválida. Válidas: {VALID_PRIORITY}", file=sys.stderr)
        return 2

    data = load_plans()
    item_id = args.id or _slugify(args.title)
    if find_item(data, item_id):
        print(f"[plans] id ya existe: {item_id}", file=sys.stderr)
        return 1

    effort = None
    if args.effort:
        try:
            lo, hi = args.effort.split("-")
            effort = [int(lo), int(hi)]
        except ValueError:
            print("[plans] --effort formato N-M", file=sys.stderr)
            return 2

    new_item = {
        "id": item_id,
        "kind": args.kind,
        "title": args.title,
        "status": "open",
        "priority": args.priority or "p2",
        "effort_hours": effort,
        "tags": [t.strip() for t in (args.tags or "").split(",") if t.strip()],
        "spec_path": args.spec,
        "description": args.description or "",
        "created_at": _now_iso(),
        "resolved_at": None,
        "deferred_reason": None,
        "notes": [],
    }
    data["items"].append(new_item)
    save_plans(data)
    print(f"[plans] añadido: {item_id} ({args.kind}, {new_item['priority']})")
    return 0


def cmd_done(args) -> int:
    data = load_plans()
    it = find_item(data, args.id)
    if not it:
        print(f"[plans] no encontrado: {args.id}", file=sys.stderr)
        return 1
    it["status"] = "resolved"
    it["resolved_at"] = _now_iso()
    if args.note:
        it.setdefault("notes", []).append({"ts": _now_iso(), "text": args.note})
    save_plans(data)
    print(f"[plans] resolved: {it['id']}")
    return 0


def cmd_defer(args) -> int:
    data = load_plans()
    it = find_item(data, args.id)
    if not it:
        print(f"[plans] no encontrado: {args.id}", file=sys.stderr)
        return 1
    it["status"] = "deferred"
    it["deferred_reason"] = args.reason or ""
    save_plans(data)
    print(f"[plans] deferred: {it['id']}")
    return 0


def cmd_reopen(args) -> int:
    data = load_plans()
    it = find_item(data, args.id)
    if not it:
        print(f"[plans] no encontrado: {args.id}", file=sys.stderr)
        return 1
    it["status"] = "open"
    it["resolved_at"] = None
    it["deferred_reason"] = None
    save_plans(data)
    print(f"[plans] reopened: {it['id']}")
    return 0


def cmd_clean(args) -> int:
    """Archiva items resolved con resolved_at >30d a _archive/."""
    data = load_plans()
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.older_than)

    keep = []
    archive = []
    for it in data["items"]:
        if it["status"] != "resolved":
            keep.append(it)
            continue
        ts_raw = it.get("resolved_at") or it.get("created_at")
        try:
            ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
        except (ValueError, AttributeError):
            keep.append(it)
            continue
        if ts < cutoff:
            archive.append(it)
        else:
            keep.append(it)

    if not archive:
        print("[plans] nada que archivar")
        return 0

    if args.dry_run:
        print(f"[plans] dry-run: archivaría {len(archive)} items:")
        for it in archive:
            print(f"  - {it['id']} ({it['resolved_at']})")
        return 0

    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    out_path = ARCHIVE_DIR / f"PLANS-archive-{datetime.now().strftime('%Y-%m-%d')}.json"
    existing = []
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    out_path.write_text(
        json.dumps(existing + archive, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    data["items"] = keep
    save_plans(data)
    print(f"[plans] archivados {len(archive)} items en {out_path.name}")
    return 0


def cmd_render(args) -> int:
    """Renderiza MASTER-pendientes.md desde PLANS.json."""
    data = load_plans()
    items = data["items"]

    # Group by status, then by priority, then kind
    by_status: dict[str, list[dict[str, Any]]] = {s: [] for s in VALID_STATUS}
    for it in items:
        by_status.setdefault(it["status"], []).append(it)

    out: list[str] = []
    out.append("---")
    out.append("title: ULTRON — MASTER de pendientes (auto-generado)")
    out.append(f"date: {datetime.now().strftime('%Y-%m-%d')}")
    out.append("status: ACTIVE — single source: PLANS.json")
    out.append("source: ~/.ultron/plans/PLANS.json")
    out.append("---")
    out.append("")
    out.append("# ULTRON — MASTER de pendientes")
    out.append("")
    out.append("> **Auto-generado desde `PLANS.json` por `ultron plans render`.**")
    out.append("> No editar este .md manualmente — usa los comandos `ultron plans add|done|defer|reopen`.")
    out.append("")

    counts = Counter(it["status"] for it in items)
    out.append(f"**Snapshot:** {counts.get('open', 0)} open · "
               f"{counts.get('in-progress', 0)} in-progress · "
               f"{counts.get('deferred', 0)} deferred · "
               f"{counts.get('resolved', 0)} resolved · "
               f"{len(items)} total")
    out.append("")

    sections = [
        ("in-progress", "🔄 EN CURSO"),
        ("open", "📋 ABIERTOS"),
        ("deferred", "⏸  DIFERIDOS"),
        ("resolved", "✅ RESUELTOS (recientes)"),
    ]

    pri_rank = {"p0": 0, "p1": 1, "p2": 2}
    kind_label = {
        "sprint": "🚀 Sprint", "bug": "🐛 Bug", "polish": "✨ Polish",
        "research": "🔬 Research", "new-direction": "🌟 Nueva dirección",
        "hotfix": "🔧 Hotfix",
    }

    for status, label in sections:
        section_items = sorted(
            by_status.get(status, []),
            key=lambda it: (pri_rank.get(it.get("priority", "p2"), 9), it["id"]),
        )
        if not section_items:
            continue
        out.append(f"## {label} ({len(section_items)})")
        out.append("")
        out.append("| Pri | Kind | ID | Título | Effort | Tags |")
        out.append("|---|---|---|---|---|---|")
        for it in section_items:
            eff = it.get("effort_hours")
            eff_s = f"{eff[0]}-{eff[1]}h" if eff else "—"
            tags = ", ".join(it.get("tags") or []) or "—"
            kind = kind_label.get(it["kind"], it["kind"])
            spec = ""
            if it.get("spec_path"):
                spec = f" [📄]({it['spec_path']})"
            out.append(f"| {it.get('priority', '—')} | {kind} | "
                       f"`{it['id']}`{spec} | {it['title']} | {eff_s} | {tags} |")
        out.append("")

    # Detail blocks for in-progress + p0 open
    detail_items = [it for it in items
                    if it["status"] == "in-progress"
                    or (it["status"] == "open" and it.get("priority") == "p0")]
    if detail_items:
        out.append("---")
        out.append("")
        out.append("## 🎯 DETALLE: en curso + p0 abiertos")
        out.append("")
        for it in detail_items:
            out.append(f"### `{it['id']}` — {it['title']}")
            out.append("")
            if it.get("description"):
                out.append(it["description"])
                out.append("")
            if it.get("spec_path"):
                out.append(f"**Spec completo:** `{it['spec_path']}`")
                out.append("")
            if it.get("notes"):
                out.append("**Notas:**")
                for n in it["notes"][-3:]:
                    out.append(f"- {n['ts'][:16]} — {n['text']}")
                out.append("")

    out.append("---")
    out.append(f"*Última render: {_now_iso()}. "
               f"Comandos: `ultron plans list|add|done|defer|render|clean`.*")

    MASTER_MD.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"[plans] rendered {MASTER_MD}")
    return 0


def cmd_status(args) -> int:
    data = load_plans()
    items = data["items"]
    by_status = Counter(it["status"] for it in items)
    by_kind = Counter(it["kind"] for it in items)
    by_priority = Counter(it.get("priority", "p2") for it in items
                          if it["status"] != "resolved")

    print(f"PLANS — {len(items)} items totales")
    print(f"  Status:   " + " · ".join(f"{k}={v}" for k, v in by_status.items()))
    print(f"  Kind:     " + " · ".join(f"{k}={v}" for k, v in by_kind.items()))
    print(f"  Priority (no-resolved): " +
          " · ".join(f"{k}={v}" for k, v in sorted(by_priority.items())))

    # Sum effort de open + in-progress
    total_lo = 0
    total_hi = 0
    for it in items:
        if it["status"] not in ("open", "in-progress"):
            continue
        eff = it.get("effort_hours")
        if eff:
            total_lo += eff[0]
            total_hi += eff[1]
    print(f"  Total effort (open+in-progress): {total_lo}-{total_hi} h")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="plans_cli")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list")
    p.add_argument("--status", choices=("all",) + VALID_STATUS, default="open")
    p.add_argument("--kind", choices=VALID_KINDS)
    p.add_argument("--priority", choices=VALID_PRIORITY)
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("show")
    p.add_argument("id")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("add")
    p.add_argument("title")
    p.add_argument("--id", help="slug explícito (default: derivado del título)")
    p.add_argument("--kind", required=True, choices=VALID_KINDS)
    p.add_argument("--priority", choices=VALID_PRIORITY)
    p.add_argument("--effort", help='formato "N-M" (horas low-high)')
    p.add_argument("--tags", help='lista coma-separada')
    p.add_argument("--spec", help="path a spec .md detallado")
    p.add_argument("--description", help="resumen corto")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("done")
    p.add_argument("id")
    p.add_argument("--note")
    p.set_defaults(func=cmd_done)

    p = sub.add_parser("defer")
    p.add_argument("id")
    p.add_argument("--reason")
    p.set_defaults(func=cmd_defer)

    p = sub.add_parser("reopen")
    p.add_argument("id")
    p.set_defaults(func=cmd_reopen)

    p = sub.add_parser("clean")
    p.add_argument("--older-than", type=int, default=30,
                   help="días desde resolved_at (default 30)")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_clean)

    p = sub.add_parser("render")
    p.set_defaults(func=cmd_render)

    p = sub.add_parser("status")
    p.set_defaults(func=cmd_status)

    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
