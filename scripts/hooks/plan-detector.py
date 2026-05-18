#!/usr/bin/env python3
"""plan-detector.py — Stop hook that captures plan-worthy items into ~/.ultron/plans/.

Runs as a Stop hook. Reads the latest session transcript (or stdin payload),
detects sentences that look like deferred work / TODOs / "for next time" /
"para v15.5.x" / "diferido" / "pending" / "tracked for", and appends them
to a single inbox file at:

    ~/.ultron/plans/_inbox.md

The user reviews the inbox manually and promotes real items to PLANS.json
via `uv run python scripts/cockpit/plans_cli.py add ...`. The inbox is the
audit trail; PLANS.json stays curated.

Conservative: only fires on EXPLICIT plan markers. Never adds to
PLANS.json directly (no auto-promotion — too noisy).

Wire it in templates/settings-hooks.json under the Stop event, AFTER
session-log.py so the transcript exists.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

INBOX_PATH = Path.home() / ".ultron" / "plans" / "_inbox.md"
TRANSCRIPT_DIR = Path.home() / ".claude" / "projects"
MAX_LINES_SCAN = 5000  # tail of transcript to scan

# Patterns that indicate "this is a plan candidate".
# Conservative — must mention version OR explicit deferral keyword.
PLAN_MARKERS = [
    re.compile(r"\b(?:diferido|deferred|tracked for v?\d+\.\d+\.x?|para v?15\.5\.x|TODO\s+v?\d)", re.IGNORECASE),
    re.compile(r"\b(?:siguiente wave|next wave|backlog|pending|por hacer)\s*[:,]", re.IGNORECASE),
    re.compile(r"\b(?:falta|missing|necesita|needs)\s+(?:port|migrar|migrate|implementar|implement|añadir|add)\b", re.IGNORECASE),
    re.compile(r"^\s*-\s+\[\s*[Pp]\d\s*\]", re.MULTILINE),  # "[P0]" / "[P1]" priority markers
]


# v15.5.20.1: persistent dedup ledger. Tail-based dedup broke when the
# inbox grew past the scanned tail (R6 caught 15x MAINTAINERS / 10x
# release-cadence duplicates because the originals had scrolled out of
# the 200-line window). The ledger keeps every snippet hash ever
# recorded, so dedup is correct regardless of inbox size.
_SEEN_LEDGER = INBOX_PATH.parent / ".inbox-seen.json"
_SEEN_LEDGER_CAP = 5000  # cap entries to bound file size


def _load_seen() -> set[str]:
    if not _SEEN_LEDGER.exists():
        return set()
    try:
        data = json.loads(_SEEN_LEDGER.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return set(data)
    except (OSError, json.JSONDecodeError):
        pass
    return set()


def _save_seen(seen: set[str]) -> None:
    try:
        _SEEN_LEDGER.parent.mkdir(parents=True, exist_ok=True)
        items = sorted(seen)
        if len(items) > _SEEN_LEDGER_CAP:
            items = items[-_SEEN_LEDGER_CAP:]
        _SEEN_LEDGER.write_text(
            json.dumps(items, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass


def append_inbox(items: list[str]) -> None:
    INBOX_PATH.parent.mkdir(parents=True, exist_ok=True)
    seen = _load_seen()
    fresh: list[str] = []
    for item in items:
        snippet = " ".join(item.split())[:240]
        if snippet and snippet not in seen:
            fresh.append(snippet)
            seen.add(snippet)
    if not fresh:
        return
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    with INBOX_PATH.open("a", encoding="utf-8") as f:
        f.write(f"\n## {ts}\n\n")
        for snippet in fresh:
            f.write(f"- {snippet}\n")
    _save_seen(seen)


def scan_text(text: str) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for line in text.splitlines():
        stripped = line.strip()
        if len(stripped) < 20 or len(stripped) > 400:
            continue
        for pat in PLAN_MARKERS:
            if pat.search(stripped):
                key = stripped[:120]
                if key not in seen:
                    seen.add(key)
                    found.append(stripped)
                break
    return found


def latest_transcript() -> Path | None:
    """Find the most-recently-modified .jsonl transcript under ~/.claude/projects."""
    if not TRANSCRIPT_DIR.is_dir():
        return None
    candidates = list(TRANSCRIPT_DIR.rglob("*.jsonl"))
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


def extract_messages(transcript: Path) -> str:
    """Pull text fields from the last MAX_LINES_SCAN transcript events."""
    try:
        lines = transcript.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    chunks: list[str] = []
    for line in lines[-MAX_LINES_SCAN:]:
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        # Common shapes from Claude Code transcripts.
        msg = obj.get("message") or obj.get("content") or obj.get("text") or ""
        if isinstance(msg, list):
            for part in msg:
                if isinstance(part, dict):
                    chunks.append(str(part.get("text") or ""))
        elif isinstance(msg, str):
            chunks.append(msg)
    return "\n".join(chunks)


def main() -> int:
    # Swallow stdin (Stop hook passes JSON; we don't need it).
    try:
        _ = sys.stdin.read()
    except Exception:
        pass

    transcript = latest_transcript()
    if transcript is None:
        return 0
    text = extract_messages(transcript)
    if not text:
        return 0
    items = scan_text(text)
    if not items:
        return 0
    try:
        append_inbox(items[:25])  # cap per-session noise
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
