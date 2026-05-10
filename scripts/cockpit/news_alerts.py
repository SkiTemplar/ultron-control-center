"""
ULTRON News Alerts — TTL-aware lifecycle for ~/.ultron/cockpit/news/ALERTS.md.

ALERTS.md contains breaking-changes warnings surfaced into the TUI (News view)
and into Claude session priming. Without housekeeping, alerts accumulate
forever and the user sees stale entries from weeks ago.

Format conventions:
  - Sections start with `## YYYY-MM-DD[ HH:MM]` headers — date is the section key
  - Bullets `- [YYYY-MM-DD] message` are dated standalone (preferred for new entries)
  - Bullets `- message` (no date prefix) inherit the most recent section header date
  - Lines without a section date and without an inline date are treated as undated
    and kept by default (manual review required)

Lifecycle:
  - purge_stale(ttl_days): rewrites ALERTS.md keeping only sections newer than
    TTL; stale sections are appended to ALERTS.archive.md (atomic via Cockpit IO).
  - clear_all(): empties ALERTS.md (loses content; only call from explicit user
    command).
  - archive_then_clear(): moves everything to ALERTS.archive.md then empties.
  - read_active(): returns list of fresh sections for programmatic consumption.

CLI:
  python news_alerts.py purge          # purge stale (TTL = NEWS_ALERTS_TTL_DAYS)
  python news_alerts.py purge --days 14
  python news_alerts.py clear          # clear all (with confirmation prompt)
  python news_alerts.py archive        # archive everything then clear
  python news_alerts.py status         # report counts (active / archived / stale)
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import NamedTuple

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import (  # noqa: E402
    NEWS_ALERTS,
    NEWS_ALERTS_ARCHIVE,
    NEWS_ALERTS_TTL_DAYS,
    Cockpit,
)

# Header `## YYYY-MM-DD` (optionally followed by ` HH:MM` and trailing text)
_DATE_HEADER = re.compile(r"^##\s*(\d{4}-\d{2}-\d{2})\b")

# Bullet `- [YYYY-MM-DD]` for explicit dated entries
_DATE_BULLET = re.compile(r"^\s*-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$")


class AlertSection(NamedTuple):
    """One logical section of ALERTS.md — header + body lines."""
    date: date | None  # None = undated section (kept indefinitely)
    header: str        # original header line (or empty for preamble)
    body: list[str]    # body lines (without trailing newlines)

    def render(self) -> str:
        if self.header:
            return self.header + "\n" + "\n".join(self.body)
        return "\n".join(self.body)


def _parse_date(s: str) -> date | None:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def parse_sections(text: str) -> tuple[list[str], list[AlertSection]]:
    """Split ALERTS.md into preamble lines + dated sections.

    Returns (preamble_lines, sections). Preamble = everything before the first
    `## YYYY-MM-DD` header. Sections are split by such headers.
    """
    lines = text.splitlines()
    preamble: list[str] = []
    sections: list[AlertSection] = []

    current_header: str | None = None
    current_date: date | None = None
    current_body: list[str] = []

    def flush():
        if current_header is not None:
            sections.append(AlertSection(
                date=current_date, header=current_header, body=list(current_body),
            ))

    for line in lines:
        m = _DATE_HEADER.match(line)
        if m:
            flush()
            current_header = line
            current_date = _parse_date(m.group(1))
            current_body = []
            continue
        if current_header is None:
            preamble.append(line)
        else:
            current_body.append(line)

    flush()
    return preamble, sections


def _split_stale(sections: list[AlertSection], cutoff: date) -> tuple[list[AlertSection], list[AlertSection]]:
    """Return (active, stale) section lists. Undated → active by default."""
    active: list[AlertSection] = []
    stale: list[AlertSection] = []
    for sec in sections:
        if sec.date is None or sec.date >= cutoff:
            active.append(sec)
        else:
            stale.append(sec)
    return active, stale


def _atomic_write(path: Path, text: str) -> None:
    """Atomic-ish write via temp + replace. Creates parent dir if missing."""
    Cockpit.ensure_dirs()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _append_archive(sections: list[AlertSection]) -> None:
    """Append stale sections to ALERTS.archive.md with a separator banner."""
    if not sections:
        return
    NEWS_ALERTS_ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
    banner = (
        f"\n\n<!-- archived {datetime.now().strftime('%Y-%m-%d %H:%M')} "
        f"({len(sections)} sections) -->\n"
    )
    body = "\n".join(sec.render() for sec in sections)
    with NEWS_ALERTS_ARCHIVE.open("a", encoding="utf-8") as f:
        f.write(banner + body + "\n")


# ── Public API ────────────────────────────────────────────────────────────────


def purge_stale(ttl_days: int = NEWS_ALERTS_TTL_DAYS) -> tuple[int, int]:
    """Move stale sections (older than ttl_days) to archive. Returns (purged, kept)."""
    if not NEWS_ALERTS.exists():
        return 0, 0
    text = NEWS_ALERTS.read_text(encoding="utf-8", errors="replace")
    preamble, sections = parse_sections(text)
    cutoff = (datetime.now() - timedelta(days=ttl_days)).date()
    active, stale = _split_stale(sections, cutoff)

    if not stale:
        return 0, len(active)

    _append_archive(stale)

    new_body = "\n".join(preamble).rstrip()
    if active:
        active_text = "\n\n".join(sec.render() for sec in active)
        new_body = (new_body + "\n\n" + active_text) if new_body else active_text
    if not new_body.endswith("\n"):
        new_body += "\n"
    _atomic_write(NEWS_ALERTS, new_body)
    return len(stale), len(active)


def clear_all() -> int:
    """Empty ALERTS.md outright (caller is responsible for confirmation).
    Returns count of sections that were cleared."""
    if not NEWS_ALERTS.exists():
        return 0
    text = NEWS_ALERTS.read_text(encoding="utf-8", errors="replace")
    _, sections = parse_sections(text)
    _atomic_write(NEWS_ALERTS, "")
    return len(sections)


def archive_then_clear() -> int:
    """Archive everything to ALERTS.archive.md then empty. Returns archived count."""
    if not NEWS_ALERTS.exists():
        return 0
    text = NEWS_ALERTS.read_text(encoding="utf-8", errors="replace")
    _, sections = parse_sections(text)
    if sections:
        _append_archive(sections)
    _atomic_write(NEWS_ALERTS, "")
    return len(sections)


def read_active(ttl_days: int = NEWS_ALERTS_TTL_DAYS) -> list[AlertSection]:
    """Return sections that are still fresh (within TTL). Side-effect-free."""
    if not NEWS_ALERTS.exists():
        return []
    text = NEWS_ALERTS.read_text(encoding="utf-8", errors="replace")
    _, sections = parse_sections(text)
    cutoff = (datetime.now() - timedelta(days=ttl_days)).date()
    active, _ = _split_stale(sections, cutoff)
    return active


def status(ttl_days: int = NEWS_ALERTS_TTL_DAYS) -> dict[str, int]:
    """Report counts: active / stale / undated / archived bytes."""
    if not NEWS_ALERTS.exists():
        return {"active": 0, "stale": 0, "undated": 0, "archived_bytes": 0}
    text = NEWS_ALERTS.read_text(encoding="utf-8", errors="replace")
    _, sections = parse_sections(text)
    cutoff = (datetime.now() - timedelta(days=ttl_days)).date()
    active = stale = undated = 0
    for sec in sections:
        if sec.date is None:
            undated += 1
        elif sec.date >= cutoff:
            active += 1
        else:
            stale += 1
    arch_bytes = NEWS_ALERTS_ARCHIVE.stat().st_size if NEWS_ALERTS_ARCHIVE.exists() else 0
    return {"active": active, "stale": stale, "undated": undated, "archived_bytes": arch_bytes}


# ── CLI ───────────────────────────────────────────────────────────────────────


def _cmd_purge(args: argparse.Namespace) -> int:
    purged, kept = purge_stale(ttl_days=args.days)
    print(f"[alerts] purged {purged} stale section(s) (TTL={args.days}d), "
          f"kept {kept} active.")
    return 0


def _cmd_clear(args: argparse.Namespace) -> int:
    if not args.yes:
        print("[alerts] refusing to clear without --yes (this is destructive).")
        return 1
    n = clear_all()
    print(f"[alerts] cleared {n} section(s) from ALERTS.md (no archive).")
    return 0


def _cmd_archive(args: argparse.Namespace) -> int:
    n = archive_then_clear()
    print(f"[alerts] archived {n} section(s) → {NEWS_ALERTS_ARCHIVE}")
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    s = status(ttl_days=args.days)
    print(f"[alerts] active={s['active']} stale={s['stale']} "
          f"undated={s['undated']} archive_bytes={s['archived_bytes']}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="news_alerts",
                                 description="ULTRON News Alerts lifecycle manager")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_purge = sub.add_parser("purge", help="Move stale sections to archive")
    p_purge.add_argument("--days", type=int, default=NEWS_ALERTS_TTL_DAYS,
                          help=f"TTL in days (default {NEWS_ALERTS_TTL_DAYS})")
    p_purge.set_defaults(func=_cmd_purge)

    p_clear = sub.add_parser("clear", help="Wipe ALERTS.md (no archive)")
    p_clear.add_argument("--yes", action="store_true", help="Confirm destructive clear")
    p_clear.set_defaults(func=_cmd_clear)

    p_arch = sub.add_parser("archive", help="Archive everything then wipe")
    p_arch.set_defaults(func=_cmd_archive)

    p_stat = sub.add_parser("status", help="Show counts")
    p_stat.add_argument("--days", type=int, default=NEWS_ALERTS_TTL_DAYS)
    p_stat.set_defaults(func=_cmd_status)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
