#!/usr/bin/env python3
"""
ULTRON v12 Knowledge Decay Queue — staleness-aware vault hygiene.

3rd convergent gap from Triple repo-evaluator BRAIN mega-eval: vault notes get
stale silently. APIs deprecate, models change names, patterns get superseded.
Without a decay model, the vault becomes a graveyard of facts that were
correct on the day they were written and silently false 3 months later.

This script extends brain_index.db with a `decay_state` table that tracks
per-note verification timestamps and applies a criticality-weighted staleness
score. Notes with frontmatter `criticality: critical|high|medium|low` are
weighted accordingly; missing frontmatter defaults to `medium`.

Schema (created on first run):
    decay_state(note_id PK, last_verified_at, criticality, verify_count,
                last_seen_in_session)

Score formula (higher = more urgent):
    score = days_since_verified * criticality_weight
where weights: critical=4.0, high=2.0, medium=1.0, low=0.4

CLI:
    decay_queue.py scan [--top N] [--min-score S] [--category C]
                                            List top-N stale notes ranked
    decay_queue.py verify <note_id> [--note "..."]
                                            Mark a note as freshly verified
    decay_queue.py stats                    Distribution by criticality + age
    decay_queue.py touch <note_id>          Bump verify_count without changing date
    decay_queue.py prime                    Print top-3 stale (Stop hook ready)

Token efficiency:
    Pure SQL on existing brain_index.db. Zero LLM calls. Zero filesystem
    traversal beyond what brain_index already did. Sub-100ms typical.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

INDEX_DB = Path.home() / ".ultron" / "brain_index" / "index.db"

CRITICALITY_WEIGHT = {
    "critical": 4.0,
    "high": 2.0,
    "medium": 1.0,
    "low": 0.4,
}
DEFAULT_CRITICALITY = "medium"

CRITICALITY_RE = re.compile(r"^criticality\s*:\s*(\w+)\s*$",
                              re.MULTILINE | re.IGNORECASE)
VERIFIED_RE = re.compile(
    r"^last[_-]verified(?:[_-]at)?\s*:\s*(\d{4}-\d{2}-\d{2}[\dT:.\-Z+]*)",
    re.MULTILINE | re.IGNORECASE,
)


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS decay_state (
    note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    last_verified_at TEXT NOT NULL,        -- ISO timestamp
    criticality TEXT NOT NULL DEFAULT 'medium',
    verify_count INTEGER NOT NULL DEFAULT 0,
    last_seen_in_session TEXT              -- session_id last time this note was queried
);
CREATE INDEX IF NOT EXISTS idx_decay_crit ON decay_state(criticality);
"""


# ── Helpers ───────────────────────────────────────────────────────────────────

def open_db() -> sqlite3.Connection:
    if not INDEX_DB.exists():
        raise FileNotFoundError(
            f"brain index not found: {INDEX_DB}\nRun 'ultron brain build' first."
        )
    conn = sqlite3.connect(str(INDEX_DB), timeout=10)
    conn.executescript(SCHEMA_SQL)
    return conn


def parse_frontmatter_criticality(fm: str | None) -> str:
    if not fm:
        return DEFAULT_CRITICALITY
    m = CRITICALITY_RE.search(fm)
    if not m:
        return DEFAULT_CRITICALITY
    val = m.group(1).strip().lower()
    return val if val in CRITICALITY_WEIGHT else DEFAULT_CRITICALITY


def parse_frontmatter_verified(fm: str | None) -> str | None:
    if not fm:
        return None
    m = VERIFIED_RE.search(fm)
    return m.group(1).strip() if m else None


def sync_decay_rows(conn: sqlite3.Connection) -> tuple[int, int]:
    """Make sure every note in the index has a decay_state row.
    For new rows: seed last_verified_at from frontmatter `last_verified` if
    present, otherwise from the file mtime (proxy: the day it was written =
    the day it was verified). Returns (created, updated_criticality)."""
    rows = conn.execute(
        "SELECT n.id, n.frontmatter, n.mtime FROM notes n "
        "LEFT JOIN decay_state d ON d.note_id = n.id"
    ).fetchall()
    created = 0
    updated = 0
    for note_id, fm, mtime in rows:
        crit = parse_frontmatter_criticality(fm)
        fm_verified = parse_frontmatter_verified(fm)
        seed_ts = fm_verified or datetime.fromtimestamp(mtime).isoformat()
        existing = conn.execute(
            "SELECT criticality FROM decay_state WHERE note_id=?",
            (note_id,),
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO decay_state(note_id, last_verified_at, criticality, "
                "verify_count) VALUES (?, ?, ?, 0)",
                (note_id, seed_ts, crit),
            )
            created += 1
        elif existing[0] != crit:
            conn.execute(
                "UPDATE decay_state SET criticality=? WHERE note_id=?",
                (crit, note_id),
            )
            updated += 1
    conn.commit()
    return created, updated


def days_since(iso: str) -> float:
    try:
        # Strip Z and parse; support naive ISO too
        clean = iso.replace("Z", "+00:00")
        ts = datetime.fromisoformat(clean)
        if ts.tzinfo is not None:
            ts = ts.replace(tzinfo=None)
        delta = datetime.now() - ts
        return max(0.0, delta.total_seconds() / 86400.0)
    except (ValueError, TypeError):
        return 0.0


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_scan(args) -> int:
    conn = open_db()
    sync_decay_rows(conn)

    where = []
    params: list = []
    if args.category:
        where.append("n.category = ?")
        params.append(args.category)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    rows = conn.execute(
        f"SELECT n.id, n.path, n.layer, n.category, n.title, "
        f"d.last_verified_at, d.criticality, d.verify_count "
        f"FROM notes n JOIN decay_state d ON d.note_id = n.id "
        f"{where_sql}"
    , params).fetchall()

    scored: list[dict] = []
    for nid, path, layer, cat, title, verified, crit, vcount in rows:
        days = days_since(verified)
        weight = CRITICALITY_WEIGHT.get(crit, 1.0)
        score = days * weight
        if args.min_score is not None and score < args.min_score:
            continue
        scored.append({
            "id": nid, "path": path, "layer": layer, "category": cat,
            "title": title, "verified_at": verified,
            "days_since": round(days, 1),
            "criticality": crit, "verify_count": vcount,
            "score": round(score, 1),
        })
    scored.sort(key=lambda r: r["score"], reverse=True)
    top = scored[:args.top]
    if args.json:
        print(json.dumps({"count": len(top), "items": top}, indent=2,
                          ensure_ascii=False))
    else:
        if not top:
            print("[decay] no stale notes (or all below threshold)")
            return 0
        print(f"⌬  Top {len(top)} stale notes (score = days * criticality_weight):")
        print("=" * 80)
        for r in top:
            crit_glyph = {"critical": "🔴", "high": "🟠",
                            "medium": "🟡", "low": "🟢"}.get(r["criticality"], "·")
            print(f"  {crit_glyph} [{r['id']:>3}] score={r['score']:>6.1f}  "
                   f"{r['days_since']:>4}d  {r['title'][:48]}")
            print(f"        {r['path']}")
    return 0


def cmd_verify(args) -> int:
    conn = open_db()
    sync_decay_rows(conn)
    row = conn.execute(
        "SELECT n.id, n.title FROM notes n WHERE n.id=?", (args.note_id,),
    ).fetchone()
    if not row:
        sys.stderr.write(f"[error] no note with id={args.note_id}\n")
        return 1
    now = datetime.now().isoformat(timespec="seconds")
    conn.execute(
        "UPDATE decay_state SET last_verified_at=?, verify_count=verify_count+1 "
        "WHERE note_id=?", (now, args.note_id),
    )
    conn.commit()
    print(f"[decay] verified id={row[0]} ({row[1]}) at {now}")
    if args.note:
        # Append a verification log entry to vault (audit trail)
        log_dir = Path.home() / ".ultron-vault" / "20_DECISIONS"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / "verifications-log.md"
        if not log_file.exists():
            log_file.write_text("# Verification log (decay queue)\n\n", encoding="utf-8")
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(f"- {now} · note={args.note_id} ({row[1]}) · {args.note}\n")
        print(f"[decay] logged → {log_file}")
    return 0


def cmd_touch(args) -> int:
    """Bump verify_count without changing date (e.g. when querying note in
    a session — signal that it was 'seen', not necessarily 'verified')."""
    conn = open_db()
    sync_decay_rows(conn)
    cur = conn.execute(
        "UPDATE decay_state SET verify_count=verify_count+1 WHERE note_id=?",
        (args.note_id,),
    )
    conn.commit()
    if cur.rowcount == 0:
        sys.stderr.write(f"[error] no decay row for note id={args.note_id}\n")
        return 1
    print(f"[decay] touched id={args.note_id}")
    return 0


def cmd_stats(_args) -> int:
    conn = open_db()
    sync_decay_rows(conn)
    rows = conn.execute(
        "SELECT d.criticality, COUNT(*), AVG(julianday('now') - julianday(d.last_verified_at)) "
        "FROM decay_state d GROUP BY d.criticality"
    ).fetchall()
    total = conn.execute("SELECT COUNT(*) FROM decay_state").fetchone()[0]
    over_60 = conn.execute(
        "SELECT COUNT(*) FROM decay_state "
        "WHERE julianday('now') - julianday(last_verified_at) > 60"
    ).fetchone()[0]
    over_90 = conn.execute(
        "SELECT COUNT(*) FROM decay_state "
        "WHERE julianday('now') - julianday(last_verified_at) > 90"
    ).fetchone()[0]

    print(f"⌬  Knowledge Decay Queue — {total} tracked notes")
    print("=" * 70)
    print("  By criticality (avg days since verified):")
    print(f"  {'criticality':<14} {'count':>6}  {'avg_days':>10}")
    for crit, count, avg in sorted(rows,
                                     key=lambda r: -CRITICALITY_WEIGHT.get(r[0], 1)):
        print(f"  {crit:<14} {count:>6}  {avg or 0:>10.1f}")
    print()
    print(f"  Stale (>60d):   {over_60}")
    print(f"  Very stale (>90d): {over_90}")
    return 0


def _config():
    """Lazy-load brain_config (script remains usable if config missing)."""
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        from brain_config import load as _load_cfg  # type: ignore
        return _load_cfg()
    except Exception:
        return {"decay_threshold_days": 14, "decay_max_prime_results": 3}


def cmd_prime(args) -> int:
    """Print the top-N stale notes as JSON for SessionStart hook + Stop hook
    cache. Threshold + cap configurable via brain-config.json."""
    cfg = _config()
    threshold = float(cfg.get("decay_threshold_days", 14))
    max_results = int(cfg.get("decay_max_prime_results", 3))

    conn = open_db()
    sync_decay_rows(conn)
    rows = conn.execute(
        "SELECT n.id, n.title, d.last_verified_at, d.criticality "
        "FROM notes n JOIN decay_state d ON d.note_id = n.id"
    ).fetchall()
    scored: list[dict] = []
    for nid, title, verified, crit in rows:
        days = days_since(verified)
        if days < threshold:
            continue
        weight = CRITICALITY_WEIGHT.get(crit, 1.0)
        scored.append({
            "id": nid, "title": title,
            "days_since": round(days, 1),
            "criticality": crit, "score": round(days * weight, 1),
        })
    scored.sort(key=lambda r: r["score"], reverse=True)
    result = json.dumps(scored[:max_results], ensure_ascii=False)
    output_path = getattr(args, "output", None)
    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_text(result + "\n", encoding="utf-8")
    else:
        print(result)
    return 0


def cmd_archive(args) -> int:
    """Move stale notes (score >= threshold) to ~/.ultron-vault/_archive/<year>/.

    Auditor 2 finding: decay_queue was measurement without action — 965 notes
    scored, 0 ever archived. brain_index grew unbounded. This command is the
    missing exit door.
    """
    conn = open_db()
    sync_decay_rows(conn)

    rows = conn.execute(
        "SELECT n.id, n.path, n.layer, n.title, "
        "d.last_verified_at, d.criticality "
        "FROM notes n JOIN decay_state d ON d.note_id = n.id "
        "WHERE n.layer = 'L2-vault'"  # only archive L2; L1 skill refs are machine-generated
    ).fetchall()

    candidates: list[tuple[int, Path, float]] = []
    for nid, path_s, layer, title, verified, crit in rows:
        days = days_since(verified)
        weight = CRITICALITY_WEIGHT.get(crit, 1.0)
        score = days * weight
        if days < args.over_days:
            continue
        if crit == "critical":
            continue  # never auto-archive critical notes
        candidates.append((nid, Path(path_s), score))

    candidates.sort(key=lambda r: r[2], reverse=True)
    if args.limit:
        candidates = candidates[:args.limit]

    if not candidates:
        print(f"[archive] no notes >= {args.over_days} days stale (excluding critical)")
        return 0

    vault_root = Path.home() / ".ultron-vault"
    archive_root = vault_root / "_archive" / str(datetime.now().year)
    archive_root.mkdir(parents=True, exist_ok=True)

    moved = 0
    for nid, src, score in candidates:
        if not src.exists():
            # Orphan in DB — just delete the decay_state row
            if not args.dry_run:
                conn.execute("DELETE FROM decay_state WHERE note_id = ?", (nid,))
                conn.execute("DELETE FROM notes WHERE id = ?", (nid,))
            print(f"[archive] orphan-cleanup [{nid}] {src}")
            moved += 1
            continue
        try:
            rel = src.relative_to(vault_root)
        except ValueError:
            print(f"[archive] skip [{nid}]: not under vault root: {src}")
            continue
        dst = archive_root / rel
        if args.dry_run:
            print(f"[archive] DRY-RUN [{nid}] score={score:.1f} → {dst}")
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            src.rename(dst)
            conn.execute("DELETE FROM decay_state WHERE note_id = ?", (nid,))
            conn.execute("DELETE FROM notes WHERE id = ?", (nid,))
            print(f"[archive] moved [{nid}] score={score:.1f} {rel} → _archive/{datetime.now().year}/{rel}")
            moved += 1
        except OSError as exc:
            print(f"[archive] error [{nid}] {src}: {exc}", file=sys.stderr)

    if not args.dry_run:
        conn.commit()
    print(f"[archive] {moved} note(s) {'would be ' if args.dry_run else ''}archived")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        prog="decay_queue",
        description="ULTRON v12 Knowledge Decay Queue — staleness scoring",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("scan", help="List top-N stale notes ranked")
    sp.add_argument("--top", type=int, default=10)
    sp.add_argument("--min-score", type=float, default=None)
    sp.add_argument("--category", default=None)
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_scan)

    sp = sub.add_parser("verify", help="Mark a note as freshly verified")
    sp.add_argument("note_id", type=int)
    sp.add_argument("--note", help="Optional human note for the audit log")
    sp.set_defaults(func=cmd_verify)

    sp = sub.add_parser("touch", help="Bump verify_count without re-dating")
    sp.add_argument("note_id", type=int)
    sp.set_defaults(func=cmd_touch)

    sub.add_parser("stats", help="Distribution by criticality + age").set_defaults(
        func=cmd_stats)

    sp = sub.add_parser("prime",
                         help="Print top-3 stale (JSON) for SessionStart")
    sp.add_argument("--output", default=None, metavar="PATH",
                    help="Write JSON to file (UTF-8) instead of stdout — avoids PS5.1 cp1252 corruption")
    sp.set_defaults(func=cmd_prime)

    sp = sub.add_parser("archive",
                         help="Move stale notes to ~/.ultron-vault/_archive/<year>/")
    sp.add_argument("--over-days", type=int, default=90,
                    help="Archive notes not verified in N days (default: 90)")
    sp.add_argument("--limit", type=int, default=None,
                    help="Max number of notes to archive in one run")
    sp.add_argument("--dry-run", action="store_true",
                    help="Print what would be archived without moving files")
    sp.set_defaults(func=cmd_archive)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
