#!/usr/bin/env python3
"""
ULTRON v12.5.0-fix2 — Audit Index + Retention (F9).

Two responsibilities:

1. **INDEX**: scan ~/.ultron/cockpit/audits/*.md and build a manifest JSON
   (date, type, target, nota, veredicto, related) so audits become
   navigable programmatically (TUI, future dashboards).

2. **RETENTION**: archive audits older than --retention-days (default 30)
   to ~/.ultron/cockpit/audits/archive/<year>/<month>/ — preserved, never
   deleted. Historical audits are knowledge, not log noise.

CLI:
    audit_index.py build          Scan + write INDEX.json (no archival)
    audit_index.py archive [--retention-days N] [--dry-run]
                                  Move stale audits to archive/<year>/<month>/
    audit_index.py run            Both: build → archive → rebuild
                                  (called from retention.py daily)

Frontmatter parsed (best-effort):
    type, date, target, nota_global / nota, veredicto, related
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

AUDITS_DIR = Path.home() / ".ultron" / "cockpit" / "audits"
INDEX_PATH = AUDITS_DIR / "INDEX.json"
ARCHIVE_ROOT = AUDITS_DIR / "archive"
DEFAULT_RETENTION_DAYS = 30

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
DATE_FROM_NAME_RE = re.compile(r"(\d{4}[-_]?\d{2}[-_]?\d{2})")
# Patterns for nota extraction from markdown body (when not in frontmatter).
# Covers formats: **nota_global: 6.2/10**, **Nota global:** **5.8/10**, etc.
_NOTA_BODY_RE = re.compile(
    r"(?:nota[_\s]global|nota\s+global|NOTA\s+GLOBAL)\s*[:\*\s]+\**([\d.]+(?:\s*/\s*10)?)",
    re.IGNORECASE,
)


def _extract_nota(text: str, fm: dict) -> str:
    """Extract nota from frontmatter (nota_global/nota/score) or markdown body."""
    nota = fm.get("nota_global") or fm.get("nota") or fm.get("score") or ""
    if nota:
        return nota
    # Fallback: scan head + tail (nota can appear at start or end of audit)
    # Handles: **nota_global: 6.2/10**, **Nota global:** **5.8/10**, etc.
    search_zone = text[:2000] + text[-1500:]
    m = _NOTA_BODY_RE.search(search_zone)
    if m:
        raw = m.group(1).strip().replace(" ", "")
        return raw if "/" in raw else f"{raw}/10"
    return ""


def parse_frontmatter(text: str) -> dict[str, str]:
    """Cheap YAML-frontmatter parser (no external deps).
    Only flat key:value pairs; ignores nested blocks. Good enough for audits."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}
    fm: dict[str, str] = {}
    for line in m.group(1).splitlines():
        line = line.rstrip()
        if not line or line.startswith("#") or line.startswith(" "):
            continue
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        v = v.strip().strip('"').strip("'")
        if v:  # skip block-list openers like "related:" with items below
            fm[k.strip()] = v
    return fm


def date_from_filename(name: str) -> str | None:
    m = DATE_FROM_NAME_RE.search(name)
    if not m:
        return None
    raw = m.group(1).replace("_", "-")
    if len(raw) == 8:  # 20260503 → 2026-05-03
        raw = f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return raw


def build_index() -> dict:
    """Scan AUDITS_DIR and return a manifest dict."""
    if not AUDITS_DIR.exists():
        return {"version": 1, "generated_at": datetime.now().isoformat(),
                "count": 0, "audits": []}
    entries: list[dict] = []
    for md in sorted(AUDITS_DIR.glob("*.md")):
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue
        fm = parse_frontmatter(text)
        date = (fm.get("date")
                 or date_from_filename(md.stem)
                 or datetime.fromtimestamp(md.stat().st_mtime).strftime("%Y-%m-%d"))
        entry = {
            "file": md.name,
            "date": date,
            "type": fm.get("type", "unknown"),
            "target": fm.get("target", ""),
            "nota": _extract_nota(text, fm),
            "veredicto": fm.get("veredicto", ""),
            "size_kb": round(md.stat().st_size / 1024, 1),
            "mtime": datetime.fromtimestamp(md.stat().st_mtime).isoformat(timespec="seconds"),
        }
        entries.append(entry)

    entries.sort(key=lambda e: (e.get("date", ""), e["file"]), reverse=True)
    return {
        "version": 1,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "count": len(entries),
        "audits": entries,
    }


def cmd_build(args) -> int:
    AUDITS_DIR.mkdir(parents=True, exist_ok=True)
    idx = build_index()
    INDEX_PATH.write_text(json.dumps(idx, indent=2, ensure_ascii=False) + "\n",
                           encoding="utf-8")
    print(f"[audit-index] {idx['count']} audit(s) → {INDEX_PATH}")

    # Sprint 4 F11: auto-extract pending_actions from new kirkardo audits.
    # Idempotent — same ID = title update, no duplicates. Skip with --skip-pending.
    if not getattr(args, "skip_pending", False):
        try:
            audit_to_pending = Path(__file__).parent / "audit_to_pending.py"
            if audit_to_pending.exists():
                # Only process audits modified in last 7 days (avoid re-processing old ones)
                cutoff = (datetime.now() - timedelta(days=7)).date().isoformat()
                import subprocess
                r = subprocess.run(
                    [sys.executable, str(audit_to_pending), "extract-all", "--since", cutoff],
                    capture_output=True, text=True, timeout=30,
                )
                # Show only the summary line
                for line in r.stdout.splitlines():
                    if "processed" in line:
                        print(f"[audit-index] {line.strip()}")
                        break
        except Exception:
            pass  # never block audit_index on pending_actions write
    return 0


def cmd_archive(args) -> int:
    """Move audits older than retention-days to archive/<year>/<month>/."""
    if not AUDITS_DIR.exists():
        print("[audit-index] no audits dir — nothing to archive")
        return 0
    cutoff = datetime.now() - timedelta(days=args.retention_days)
    moved = 0
    skipped = 0
    for md in sorted(AUDITS_DIR.glob("*.md")):
        # Don't archive INDEX.json contents holders or already-archived
        if md.parent != AUDITS_DIR:
            continue
        try:
            mtime = datetime.fromtimestamp(md.stat().st_mtime)
        except OSError:
            continue
        if mtime >= cutoff:
            skipped += 1
            continue
        # Use the most reliable date: frontmatter > filename > mtime
        try:
            text = md.read_text(encoding="utf-8")
            fm = parse_frontmatter(text)
            date_str = (fm.get("date")
                         or date_from_filename(md.stem)
                         or mtime.strftime("%Y-%m-%d"))
        except OSError:
            date_str = mtime.strftime("%Y-%m-%d")
        try:
            dt = datetime.fromisoformat(date_str)
        except ValueError:
            dt = mtime
        archive_dir = ARCHIVE_ROOT / f"{dt.year}" / f"{dt.month:02d}"
        archive_dir.mkdir(parents=True, exist_ok=True)
        dst = archive_dir / md.name
        if dst.exists():
            print(f"[audit-index] skip (already archived): {md.name}")
            continue
        if args.dry_run:
            print(f"[audit-index] DRY-RUN move: {md.name} → archive/{dt.year}/{dt.month:02d}/")
            continue
        md.rename(dst)
        print(f"[audit-index] archived: {md.name} → archive/{dt.year}/{dt.month:02d}/")
        moved += 1
    print(f"[audit-index] archive: moved={moved} skipped(<{args.retention_days}d)={skipped}")
    return 0


def cmd_run(args) -> int:
    """Daily entry: build → archive → rebuild (so INDEX reflects post-archive)."""
    cmd_build(args)
    cmd_archive(args)
    cmd_build(args)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        prog="audit_index",
        description="ULTRON Audit Index + Retention (F9)",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    p_build = sub.add_parser("build", help="Generate INDEX.json")
    p_build.add_argument("--skip-pending", action="store_true",
                          help="Skip auto-extract pending_actions from new audits (F11)")
    p_build.set_defaults(func=cmd_build)

    sp = sub.add_parser("archive", help="Move stale audits to archive/")
    sp.add_argument("--retention-days", type=int, default=DEFAULT_RETENTION_DAYS)
    sp.add_argument("--dry-run", action="store_true")
    sp.set_defaults(func=cmd_archive)

    sp = sub.add_parser("run", help="Daily: build + archive + rebuild")
    sp.add_argument("--retention-days", type=int, default=DEFAULT_RETENTION_DAYS)
    sp.add_argument("--dry-run", action="store_true")
    sp.set_defaults(func=cmd_run)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
