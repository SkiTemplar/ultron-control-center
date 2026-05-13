"""ULTRON Changelog Tool — official entry-point for changelog management.

Subcommands:
  add       Append a new entry interactively or via flags.
  compact   Rewrite existing bodies to a strict bullet format (≤5 bullets,
            each ≤120 chars). Drops prose paragraphs; keeps the essentials.
  list      Show one line per version (count + dates).
  rm        Delete entries by id substring.

Body format (canonical):
  Every entry body is a list of bullets:
    - first bullet
    - second bullet
    ...
  Max 5 bullets, each starts with capital letter, no trailing period,
  ≤120 chars. Backticks for code/paths preserved. The frontend
  RenderBody renders these as proper list items.

Why: the historical changelog had ndjson bodies as multi-paragraph prose
written by Claude across sessions. That format is unreadable in any UI.
This tool enforces a uniform shape going forward and one-time rewrites
the back-catalogue.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

ULTRON = Path.home() / ".ultron"
CHANGELOG = ULTRON / "cockpit" / "changelog.ndjson"

MAX_BULLETS = 5
MAX_BULLET_LEN = 120


# ---------------------------------------------------------------------------
# Body compaction
# ---------------------------------------------------------------------------

# Lines that obviously aren't worth being a bullet
_BORING_PREFIXES = (
    "see ", "spec:", "context:", "background:", "details:", "note:",
)


def _split_into_candidate_bullets(body: str) -> list[str]:
    """Try several strategies to break a prose body into bullet candidates."""
    if not body:
        return []
    text = body.replace("\r\n", "\n").strip()

    # Strategy 1: explicit bullets (- or *)
    explicit = [
        m.group(1).strip()
        for m in re.finditer(r"(?m)^\s*[-*]\s+(.+?)$", text)
    ]
    if explicit:
        return explicit

    # Strategy 2: numbered list
    numbered = [
        m.group(1).strip()
        for m in re.finditer(r"(?m)^\s*\d+[.)]\s+(.+?)$", text)
    ]
    if numbered:
        return numbered

    # Strategy 3: split prose paragraphs into sentences and pick the strongest.
    # We split first on blank-line paragraph breaks, then on sentence-end
    # punctuation. Newline-only joins are flattened to single spaces.
    paragraphs = re.split(r"\n\s*\n", text)
    sentences: list[str] = []
    for para in paragraphs:
        flat = re.sub(r"\s+", " ", para).strip()
        # Sentence split on .!? followed by space + capital (or end)
        parts = re.split(r"(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])", flat)
        sentences.extend(p.strip() for p in parts if p.strip())
    return sentences


def _is_boring(s: str) -> bool:
    low = s.lower()
    return any(low.startswith(p) for p in _BORING_PREFIXES) or low.startswith("#")


def compact_body(body: str, title: str = "") -> str:
    """Return a body containing at most MAX_BULLETS bullets ≤ MAX_BULLET_LEN."""
    candidates = _split_into_candidate_bullets(body)
    if not candidates:
        return ""

    seen: set[str] = set()
    cleaned: list[str] = []
    title_norm = title.lower().strip() if title else ""

    for raw in candidates:
        s = raw.strip().rstrip(".,;:")
        if not s or _is_boring(s):
            continue
        # Drop near-duplicate-of-title bullets (the body sometimes repeats the title)
        if title_norm and s.lower().strip() == title_norm:
            continue
        # Truncate long bullets at a clean boundary
        if len(s) > MAX_BULLET_LEN:
            cut = s[:MAX_BULLET_LEN]
            # Try to back up to the last sensible separator
            for sep in (";", ",", " — ", " - ", " "):
                idx = cut.rfind(sep)
                if idx > MAX_BULLET_LEN * 0.6:
                    cut = cut[:idx]
                    break
            s = cut.rstrip(" ,;:") + "…"
        # Capitalize first character
        if s and s[0].islower():
            s = s[0].upper() + s[1:]
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(s)
        if len(cleaned) >= MAX_BULLETS:
            break

    if not cleaned:
        return ""
    return "\n".join(f"- {b}" for b in cleaned)


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def read_entries() -> list[dict]:
    if not CHANGELOG.exists():
        return []
    out: list[dict] = []
    for line in CHANGELOG.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s:
            continue
        try:
            out.append(json.loads(s))
        except json.JSONDecodeError:
            # Preserve unparseable lines by re-emitting as is later? For now skip.
            continue
    return out


def write_entries(entries: list[dict]) -> None:
    # Ensure trailing newline; preserve order as given.
    with CHANGELOG.open("w", encoding="utf-8", newline="\n") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Normalization — strip pre-release tags and clean up titles
# ---------------------------------------------------------------------------

# Matches a leading version prefix in a title like "v15.0.2 ", "v15.1 Fase 2 —",
# possibly with the trailing "Fase N" / "Phase N" / "phase-N" filler.
_TITLE_VERSION_PREFIX = re.compile(
    r"^\s*v?\d+(?:\.\d+){1,2}[a-z]*\d*\s*"  # v15.0.2 or v15.0b
    r"(?:[-—:]\s*)?"                          # optional separator after version
    r"(?:(?:fase|phase)\s*\d+\s*[-—:]?\s*)?"   # optional "Fase N — "
    r"(?:foundation|changelog)?\s*"            # filler words
    r"(?:[-—:]\s*)?",                          # second optional separator
    re.IGNORECASE,
)

# Standalone "changelog" word filler when not at the start
_CHANGELOG_FILLER = re.compile(r"\s*\bchangelog\b\s*", re.IGNORECASE)

# Pre-release tag at end of version: v15.0b, v15.0-rc1
_VERSION_TAG = re.compile(r"^(\d+(?:\.\d+){1,2})([a-z]+\d*)$", re.IGNORECASE)


def strip_tag(version: str) -> str:
    """v15.0b → v15.0, v15.0-rc1 → v15.0, v15.0.2 → v15.0.2."""
    m = _VERSION_TAG.match(version)
    return m.group(1) if m else version


def clean_title(title: str) -> str:
    """Drop redundant version prefix + "Fase N — " + "changelog" filler."""
    if not title:
        return title
    out = _TITLE_VERSION_PREFIX.sub("", title, count=1)
    # Drop a "Foundation —" left over after Fase strip
    out = re.sub(r"^\s*foundation\s*[-—:]\s*", "", out, count=1, flags=re.IGNORECASE)
    # Squash double separators and trim
    out = re.sub(r"\s*[-—:]\s*[-—:]\s*", " — ", out)
    out = out.strip(" -—:")
    if out and out[0].islower():
        out = out[0].upper() + out[1:]
    return out


def cmd_normalize(args: argparse.Namespace) -> int:
    """Strip pre-release tags from versions and clean titles for all entries."""
    entries = read_entries()
    if not entries:
        print("[changelog_tool] no entries", flush=True)
        return 0

    title_changed = 0
    version_changed = 0
    for e in entries:
        # related_ids: drop tag
        rids = e.get("related_ids") or []
        new_rids = []
        for r in rids:
            s = str(r)
            m = re.match(r"^v?(\d+(?:\.\d+){1,2})[a-z]*\d*$", s, re.IGNORECASE)
            if m:
                stripped = f"v{m.group(1)}"
                new_rids.append(stripped)
            else:
                new_rids.append(r)
        if new_rids != rids:
            e["related_ids"] = new_rids
            version_changed += 1

        # id: replace tag occurrences like "v15-0-b" → "v15-0"
        eid = str(e.get("id", ""))
        new_id = re.sub(r"(v\d+(?:[-_.]\d+){1,2})[-_]?[a-z]+\d*", r"\1", eid, count=1, flags=re.IGNORECASE)
        if new_id != eid:
            e["id"] = new_id

        # title
        old_title = e.get("title", "") or ""
        new_title = clean_title(old_title)
        if new_title and new_title != old_title:
            e["title"] = new_title
            title_changed += 1

    write_entries(entries)
    print(f"[changelog_tool] normalized: {version_changed} versions, {title_changed} titles", flush=True)
    return 0


def cmd_compact(args: argparse.Namespace) -> int:
    entries = read_entries()
    if not entries:
        print("[changelog_tool] no entries", flush=True)
        return 0

    rewritten = 0
    for e in entries:
        old = e.get("body", "") or ""
        new = compact_body(old, title=e.get("title", ""))
        if new and new != old:
            e["body"] = new
            rewritten += 1
        elif not new and old:
            # If the compaction yields nothing, leave the original alone
            pass

    write_entries(entries)
    print(f"[changelog_tool] compacted {rewritten}/{len(entries)} entries", flush=True)
    return 0


def cmd_rm(args: argparse.Namespace) -> int:
    needle = args.id_substring.lower()
    entries = read_entries()
    kept = []
    removed = []
    for e in entries:
        if needle in str(e.get("id", "")).lower() or needle in str(
            (e.get("related_ids") or [""])[0]
        ).lower():
            removed.append(e)
        else:
            kept.append(e)
    if not removed:
        print(f"[changelog_tool] no entries matched '{needle}'", flush=True)
        return 0
    write_entries(kept)
    print(f"[changelog_tool] removed {len(removed)} entries:", flush=True)
    for e in removed:
        print(f"  - {e.get('id'):<40s} {e.get('title','')[:60]}", flush=True)
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    entries = read_entries()
    print(f"[changelog_tool] {len(entries)} entries total", flush=True)
    for e in entries:
        ts = (e.get("ts") or "")[:10]
        typ = e.get("type", "?")
        scope = e.get("scope", "?")
        title = (e.get("title") or "")[:80]
        print(f"  {ts}  {typ:<8s} {scope:<24s} {title}", flush=True)
    return 0


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def cmd_add(args: argparse.Namespace) -> int:
    bullets = [b.strip() for b in (args.bullet or []) if b.strip()]
    body = "\n".join(f"- {b}" for b in bullets[:MAX_BULLETS])

    entry = {
        "id": args.id or f"{args.scope}-{int(time.time())}-{uuid.uuid4().hex[:4]}",
        "ts": args.ts or _now_iso(),
        "type": args.type,
        "scope": args.scope,
        "title": args.title,
        "body": body,
        "related_ids": args.related or [],
        "applied_by": args.applied_by or "claude",
    }
    with CHANGELOG.open("a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"[changelog_tool] appended entry {entry['id']}", flush=True)
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="changelog_tool")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("normalize", help="Drop tags (b/rc) + clean titles")
    sp.set_defaults(func=cmd_normalize)

    sp = sub.add_parser("compact", help="Rewrite bodies to bullet format")
    sp.set_defaults(func=cmd_compact)

    sp = sub.add_parser("rm", help="Remove entries by id substring")
    sp.add_argument("id_substring")
    sp.set_defaults(func=cmd_rm)

    sp = sub.add_parser("list", help="One-line per entry")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("add", help="Append a new entry")
    sp.add_argument("--type", required=True, choices=["feat", "fix", "chore", "refactor", "docs"])
    sp.add_argument("--scope", required=True)
    sp.add_argument("--title", required=True)
    sp.add_argument("--bullet", action="append", help="Repeatable. Max 5 used.")
    sp.add_argument("--related", action="append")
    sp.add_argument("--id")
    sp.add_argument("--ts")
    sp.add_argument("--applied-by")
    sp.set_defaults(func=cmd_add)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
