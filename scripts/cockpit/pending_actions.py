#!/usr/bin/env python3
"""
ULTRON v13.2 — Pending Actions Dead-Letter Queue (F4 + v13.2 enhancements).

Closes the audit→fix loop. Kirkardo audits identify FIX/FEAT items but they
sat in markdown reports for >24h with no enforcement (SI-CRIT-1 of Kirkardo
TOTAL Triple). This module is the actuator: audits write here, SessionStart
hook reads from here, and Claude sees critical-and-old actions in turn 0.

Storage: ~/.ultron/cockpit/pending_actions.json

CLI:
    pending_actions.py list [--severity S] [--status open|in_progress|resolved|rejected|deferred]
    pending_actions.py add  --id ID --severity S --title T --source AUDIT
                            [--deadline ISO] [--blocking] [--description ...]
    pending_actions.py start  --id ID [--note "..."]    # open → in_progress
    pending_actions.py resolve --id ID [--note "..."]   # any → resolved
    pending_actions.py reject  --id ID [--note "..."]   # any → rejected (won't fix)
    pending_actions.py defer   --id ID [--note "..."]   # any → deferred (revisit later)
    pending_actions.py prime [--output PATH] [--max N]
        Write top-N critical-and-old actions as JSON for session-init hook.

Schema (one entry):
    {id, severity, title, description, deadline, blocking, source_audit,
     created_at, status, resolved_at, notes[]}
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

QUEUE = Path.home() / ".ultron" / "cockpit" / "pending_actions.json"
LOCK_FILE = QUEUE.with_suffix(".lock")
SCHEMA_VERSION = 2  # bumped for SI-P0-2: producer field + validation

VALID_SEVERITY = {"critical", "high", "medium", "low"}
VALID_STATUS = {"open", "in_progress", "resolved", "rejected", "deferred"}
DEFAULT_MAX_PRIMED = 5
PRIME_MIN_AGE_HOURS = 24

_LOCK_TIMEOUT = 5.0  # seconds
_LOCK_RETRY   = 0.05

# SI-P0-2 hardening: futuro skew tolerable (clock drift entre máquinas / NTP).
# Cualquier timestamp > now + FUTURE_SKEW se considera inyección y se rechaza.
_FUTURE_SKEW_SECONDS = 300  # 5 min

# Required fields para una entry válida. Entries sin estos campos se cuarentenan
# en _load() y NO entran a la lista pública. `producer` lo añadimos en v2 —
# entries pre-v2 quedan con producer="legacy" para backward compat sin descartarlas.
REQUIRED_FIELDS = {"id", "severity", "title", "source_audit",
                   "created_at", "status"}


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ── SI-P0-2 validators ────────────────────────────────────────────────────────

def _parse_iso(value: str | None) -> datetime | None:
    """Parse ISO timestamp tolerantly. Return None si vacío o malformado."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except (ValueError, TypeError):
        return None


def _is_valid_timestamp(value: str | None, *, allow_none: bool = True) -> bool:
    """True si es ISO parseable y NO en el futuro más allá de FUTURE_SKEW.

    `resolved_at` puede ser None en entries open — usar allow_none=True.
    `created_at` siempre debe estar presente — usar allow_none=False.
    """
    if value is None or value == "":
        return allow_none
    parsed = _parse_iso(value)
    if parsed is None:
        return False
    cutoff = datetime.now() + timedelta(seconds=_FUTURE_SKEW_SECONDS)
    return parsed <= cutoff


def _validate_entry(entry: dict) -> tuple[bool, str]:
    """Devuelve (ok, reason). Si !ok, _load() cuarentena la entry."""
    if not isinstance(entry, dict):
        return False, "not a dict"
    missing = REQUIRED_FIELDS - set(entry.keys())
    if missing:
        return False, f"missing required fields: {sorted(missing)}"
    if entry.get("severity") not in VALID_SEVERITY:
        return False, f"invalid severity: {entry.get('severity')!r}"
    if entry.get("status") not in VALID_STATUS:
        return False, f"invalid status: {entry.get('status')!r}"
    if not _is_valid_timestamp(entry.get("created_at"), allow_none=False):
        return False, f"invalid/future created_at: {entry.get('created_at')!r}"
    if not _is_valid_timestamp(entry.get("resolved_at"), allow_none=True):
        return False, f"invalid/future resolved_at: {entry.get('resolved_at')!r}"
    # id sane: no NUL, no path-traversal, longitud razonable
    id_val = entry.get("id", "")
    if not isinstance(id_val, str) or "\x00" in id_val or len(id_val) > 200:
        return False, f"invalid id: {id_val!r}"
    return True, ""


class _FileLock:
    """Simple lock-file with timeout. Used to prevent concurrent read-modify-write races."""
    def __init__(self, path: Path, timeout: float = _LOCK_TIMEOUT):
        self.path = path
        self.timeout = timeout

    def __enter__(self):
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                fd = self.path.open("x")  # exclusive create — atomic on all platforms
                fd.close()
                return self
            except FileExistsError:
                if time.monotonic() >= deadline:
                    # Stale lock: delete and retry once
                    try:
                        self.path.unlink(missing_ok=True)
                    except OSError:
                        pass
                    continue
                time.sleep(_LOCK_RETRY)

    def __exit__(self, *_):
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            pass


def _load() -> dict:
    """Load + validate. Entries inválidas se cuarentenan (no entran a `actions`).

    SI-P0-2: protege contra inyección manual con timestamps futuros, severities
    inventadas, ids con NUL, etc. Backward-compat: entries pre-v2 sin `producer`
    reciben producer="legacy" en lugar de ser descartadas.
    """
    empty = {"version": SCHEMA_VERSION, "updated_at": _now(), "actions": []}
    if not QUEUE.exists():
        return empty
    try:
        # utf-8-sig tolera BOM que PowerShell `Set-Content -Encoding UTF8`
        # añade al editar el archivo desde Windows. Sin esto el queue se
        # carga como vacío y silenciosamente borra todo lo previo.
        data = json.loads(QUEUE.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[pending] WARN: queue file unreadable ({exc}) — "
              f"returning empty (data NOT lost; file untouched)",
              file=sys.stderr)
        return empty
    if not isinstance(data, dict):
        return empty
    raw_actions = data.get("actions", [])
    if not isinstance(raw_actions, list):
        raw_actions = []

    valid: list[dict] = []
    for entry in raw_actions:
        ok, reason = _validate_entry(entry)
        if not ok:
            print(f"[pending] rejected malformed entry: {reason} "
                  f"(id={entry.get('id', '?')!r})", file=sys.stderr)
            continue
        # Backward-compat: producer ausente → legacy
        if "producer" not in entry:
            entry["producer"] = "legacy"
        valid.append(entry)
    data["actions"] = valid
    return data


def _save(data: dict) -> None:
    data["updated_at"] = _now()
    data["version"] = SCHEMA_VERSION
    QUEUE.parent.mkdir(parents=True, exist_ok=True)
    # Atomic write: temp file + rename prevents corruption on mid-write crash
    tmp = QUEUE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                   encoding="utf-8")
    tmp.replace(QUEUE)


def add_action(id_: str, severity: str, title: str, *,
                source_audit: str, producer: str,
                description: str = "",
                deadline: str | None = None, blocking: bool = False) -> dict:
    """Public API used by audit scripts to enqueue actions.

    SI-P0-2: `producer` es obligatorio. Identifica qué script/hook/usuario
    creó la entry. Útil para trazabilidad y para detectar inyección manual
    (entry sin producer válido = sospechosa).
    """
    if severity not in VALID_SEVERITY:
        raise ValueError(f"severity must be one of {sorted(VALID_SEVERITY)}")
    if not producer or not isinstance(producer, str) or len(producer) > 100:
        raise ValueError(
            "producer must be a non-empty string ≤100 chars "
            "(e.g. 'kirkardo-audit', 'session-init.ps1', 'manual:USER')"
        )
    with _FileLock(LOCK_FILE):
        return _add_action_locked(id_, severity, title,
                                   source_audit=source_audit, producer=producer,
                                   description=description,
                                   deadline=deadline, blocking=blocking)


def _add_action_locked(id_: str, severity: str, title: str, *,
                        source_audit: str, producer: str,
                        description: str = "",
                        deadline: str | None = None, blocking: bool = False) -> dict:
    data = _load()
    existing = next((a for a in data["actions"] if a["id"] == id_), None)
    entry = {
        "id": id_,
        "severity": severity,
        "title": title,
        "description": description,
        "deadline": deadline,
        "blocking": bool(blocking),
        "source_audit": source_audit,
        "producer": producer,
        "created_at": _now(),
        "status": "open",
        "resolved_at": None,
        "notes": [],
    }
    if existing:
        # Refresh title/severity/deadline/source/producer — preserve created_at + status + notes
        existing.update({
            "severity": severity, "title": title,
            "description": description or existing.get("description", ""),
            "deadline": deadline, "blocking": bool(blocking),
            "source_audit": source_audit,
            "producer": producer,
        })
        entry = existing
    else:
        data["actions"].append(entry)
    _save(data)
    return entry


def _transition_action(id_: str, new_status: str, note: str | None = None) -> bool:
    with _FileLock(LOCK_FILE):
        data = _load()
        for a in data["actions"]:
            if a["id"] != id_:
                continue
            a["status"] = new_status
            if new_status in {"resolved", "rejected", "deferred"}:
                resolved_ts = _now()
                a["resolved_at"] = resolved_ts
                # Zero-duration guard: warn on same-second create+resolve (P0-2)
                if a.get("created_at") == resolved_ts:
                    print(
                        f"[pending] warn: zero-duration resolve for {id_!r} — "
                        f"created_at==resolved_at; verify this is not an invalid entry",
                        file=sys.stderr,
                    )
            if note:
                a.setdefault("notes", []).append({"ts": _now(), "text": note})
            _save(data)
            return True
    return False


def start_action(id_: str, note: str | None = None) -> bool:
    return _transition_action(id_, "in_progress", note)


def resolve_action(id_: str, note: str | None = None) -> bool:
    return _transition_action(id_, "resolved", note)


def reject_action(id_: str, note: str | None = None) -> bool:
    return _transition_action(id_, "rejected", note)


def defer_action(id_: str, note: str | None = None) -> bool:
    return _transition_action(id_, "deferred", note)


def _age_hours(iso: str) -> float:
    try:
        return (datetime.now() - datetime.fromisoformat(iso)).total_seconds() / 3600.0
    except (ValueError, TypeError):
        return 0.0


def cmd_list(args) -> int:
    data = _load()
    items = list(data["actions"])
    if args.severity:
        items = [a for a in items if a.get("severity") == args.severity]
    if args.status:
        items = [a for a in items if a.get("status") == args.status]
    items.sort(key=lambda a: (
        {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(a.get("severity"), 9),
        a.get("created_at", ""),
    ))
    if args.json:
        print(json.dumps(items, indent=2, ensure_ascii=False))
        return 0
    if not items:
        print("[pending] no actions matching filters")
        return 0
    print(f"⌬  {len(items)} pending action(s)")
    print("=" * 80)
    glyph = {"critical": "🔴", "high": "🟠", "medium": "🟡", "low": "🟢"}
    for a in items:
        g = glyph.get(a.get("severity", "?"), "·")
        age = _age_hours(a.get("created_at", ""))
        block = " [BLOCKING]" if a.get("blocking") else ""
        print(f"  {g} [{a['id']:<8}] {a.get('status', '?'):<11} "
               f"age={age:>5.1f}h{block}  {a.get('title', '')}")
        src = a.get("source_audit", "")
        if src:
            print(f"        ← {src}")
    return 0


def cmd_add(args) -> int:
    try:
        entry = add_action(
            args.id, args.severity, args.title,
            source_audit=args.source,
            producer=args.producer,
            description=args.description or "",
            deadline=args.deadline,
            blocking=args.blocking,
        )
    except ValueError as exc:
        print(f"[pending] error: {exc}", file=sys.stderr)
        return 2
    print(f"[pending] added/updated id={entry['id']} "
          f"severity={entry['severity']} producer={entry['producer']}")
    return 0


def cmd_resolve(args) -> int:
    ok = resolve_action(args.id, args.note)
    if not ok:
        print(f"[error] no action with id={args.id}", file=sys.stderr)
        return 1
    print(f"[pending] resolved id={args.id}")
    return 0


def cmd_prime(args) -> int:
    """Select critical-open-old actions for SessionStart surfacing."""
    data = _load()
    items = []
    for a in data["actions"]:
        if a.get("status") != "open":
            continue
        if a.get("severity") != "critical":
            continue
        if _age_hours(a.get("created_at", "")) < PRIME_MIN_AGE_HOURS:
            # New criticals: still surface even if young
            if not a.get("blocking"):
                continue
        items.append({
            "id": a["id"],
            "severity": a["severity"],
            "title": a.get("title", ""),
            "age_hours": round(_age_hours(a.get("created_at", "")), 1),
            "blocking": a.get("blocking", False),
            "source_audit": a.get("source_audit", ""),
            "deadline": a.get("deadline"),
        })
    items.sort(key=lambda x: (
        x["deadline"] or "9999",
        -x["age_hours"],
    ))
    primed = items[: args.max]
    out = json.dumps(primed, ensure_ascii=False)
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(out + "\n", encoding="utf-8")
    else:
        print(out)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        prog="pending_actions",
        description="ULTRON Pending Actions Dead-Letter Queue (F4)",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("list", help="List pending actions")
    sp.add_argument("--severity", choices=sorted(VALID_SEVERITY))
    sp.add_argument("--status", choices=sorted(VALID_STATUS))
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("add", help="Add or update an action")
    sp.add_argument("--id", required=True)
    sp.add_argument("--severity", required=True, choices=sorted(VALID_SEVERITY))
    sp.add_argument("--title", required=True)
    sp.add_argument("--source", required=True, metavar="AUDIT")
    sp.add_argument("--producer", required=True, metavar="NAME",
                     help="Quien crea la entry (kirkardo-audit, session-init, "
                          "manual:USER, ...). SI-P0-2 hardening.")
    sp.add_argument("--description", default="")
    sp.add_argument("--deadline", default=None, metavar="ISO")
    sp.add_argument("--blocking", action="store_true")
    sp.set_defaults(func=cmd_add)

    sp = sub.add_parser("start", help="Mark action in_progress (open → in_progress)")
    sp.add_argument("--id", required=True)
    sp.add_argument("--note", default=None)
    sp.set_defaults(func=lambda a: (
        0 if start_action(a.id, a.note)
        else (print(f"[error] no action with id={a.id}", file=sys.stderr) or 1)
    ))

    sp = sub.add_parser("resolve", help="Mark an action resolved")
    sp.add_argument("--id", required=True)
    sp.add_argument("--note", default=None)
    sp.set_defaults(func=cmd_resolve)

    sp = sub.add_parser("reject", help="Mark action rejected (won't fix)")
    sp.add_argument("--id", required=True)
    sp.add_argument("--note", default=None)
    sp.set_defaults(func=lambda a: (
        0 if reject_action(a.id, a.note)
        else (print(f"[error] no action with id={a.id}", file=sys.stderr) or 1)
    ))

    sp = sub.add_parser("defer", help="Mark action deferred (revisit later)")
    sp.add_argument("--id", required=True)
    sp.add_argument("--note", default=None)
    sp.set_defaults(func=lambda a: (
        0 if defer_action(a.id, a.note)
        else (print(f"[error] no action with id={a.id}", file=sys.stderr) or 1)
    ))

    sp = sub.add_parser("prime", help="Write critical-old actions for SessionStart")
    sp.add_argument("--output", default=None, metavar="PATH")
    sp.add_argument("--max", type=int, default=DEFAULT_MAX_PRIMED)
    sp.set_defaults(func=cmd_prime)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
