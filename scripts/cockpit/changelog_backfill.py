"""Backfill changelog.ndjson with historical release entries.

Reads ~/.ultron/plans/_archive/ and ~/.ultron/plans/specs/ for any markdown
file containing a version tag (v11.X, v12.X, v13.X, v14.X, v15.X). For each
version NOT yet represented in changelog.ndjson, generates a synthetic
entry of type "feat" with:
  - title:  first H1 line of the markdown (or the filename if no H1)
  - body:   first 6-12 non-empty content lines (the "summary" of the plan)
  - ts:     file mtime if no date elsewhere, otherwise extracted from name
  - scope:  "historical"
  - id:     synthetic, deterministic

Idempotent: if the version already has an entry in the changelog (matched
via the same regex used by the frontend version extractor), skip it.

Run once to seed the UI with the full release history. Re-runs are no-ops.

Usage: uv run python scripts/cockpit/changelog_backfill.py
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

ULTRON = Path.home() / ".ultron"
CHANGELOG = ULTRON / "cockpit" / "changelog.ndjson"

# Sources to scan for versioned markdown, in *preference order*. When a
# version is found in multiple sources, the first one wins (so spec > plan
# archive > migration handover > audit). Each entry is a (label, glob_root)
# pair — the glob is applied recursively for .md files.
SOURCES: tuple[tuple[str, Path], ...] = (
    ("spec", ULTRON / "plans" / "specs"),
    ("plan-archive", ULTRON / "plans" / "_archive"),
    ("plan", ULTRON / "plans"),
    ("migration", ULTRON / "archive"),
    ("audit", ULTRON / "audits"),
    ("audit", ULTRON / "cockpit" / "audits"),
)

# Matches v15, v15.0, v15.0.2, v15.0b, v15.0.2-rc1, with dot/dash separators
# Stricter version regex: each component capped at 2 digits so "v2-2026-05"
# (kirkardo audit revision + date) doesn't get misparsed as a v2.2026.05
# release. Pre-v100 ULTRON is the only target — bump the limits if that
# changes.
VERSION_RE = re.compile(
    r"v(\d{1,2})(?!\d)[.\-_](\d{1,2})(?!\d)(?:[.\-_](\d{1,2})(?!\d))?([a-z]+\d*)?",
    re.IGNORECASE,
)
# Matches a leading YYYY-MM-DD prefix in archive filenames
DATE_PREFIX_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def normalize_version(m: re.Match) -> str:
    """Match -> '15.0.2' / '15.0' / '15.0b' format used by the frontend.

    Drops trailing '.0' patch so v12.4 and v12.4.0 collapse to the same key.
    """
    major, minor, patch, tag = m.group(1), m.group(2), m.group(3), m.group(4)
    base = f"{major}.{minor}"
    if patch and patch != "0":
        base = f"{base}.{patch}"
    if tag:
        base = f"{base}{tag.lower()}"
    return base


def existing_versions() -> set[str]:
    """Pull versions already present in changelog.ndjson (from id/title/related_ids)."""
    versions: set[str] = set()
    if not CHANGELOG.exists():
        return versions
    for line in CHANGELOG.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        candidates = [
            str(obj.get("id", "")),
            str(obj.get("title", "")),
        ]
        candidates.extend(str(r) for r in obj.get("related_ids") or [])
        for c in candidates:
            m = VERSION_RE.search(c)
            if m:
                versions.add(normalize_version(m))
                break
    return versions


def candidate_files() -> list[tuple[Path, str]]:
    """Return (path, source_label) pairs from every configured source.

    Recursive .md scan. Order matters: SOURCES is tried in priority order
    so when a version appears in multiple sources, the highest-priority
    file (spec > plan-archive > plan > migration > audit) is selected
    by the caller's dedup logic.
    """
    files: list[tuple[Path, str]] = []
    seen_paths: set[Path] = set()
    for label, root in SOURCES:
        if not root.exists():
            continue
        for p in sorted(root.rglob("*.md")):
            if p in seen_paths:
                continue
            seen_paths.add(p)
            files.append((p, label))
    return files


def extract_version_from_name(path: Path) -> str | None:
    m = VERSION_RE.search(path.name)
    return normalize_version(m) if m else None


def extract_title(text: str, fallback: str) -> str:
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("# ") and len(s) > 2:
            # Strip leading "v15.X — " style prefix; keep concept
            return s[2:].strip()
    return fallback


def extract_body(text: str, max_lines: int = 12) -> str:
    """Pull the first chunk of meaningful content, skipping titles and frontmatter."""
    lines = text.splitlines()
    out: list[str] = []
    skip = True
    for line in lines:
        s = line.rstrip()
        # Skip until past the first H1
        if skip:
            if s.startswith("# "):
                skip = False
            continue
        # Stop on a second-level heading after we already have content
        if s.startswith("## ") and out:
            break
        # Strip frontmatter blocks
        if s.strip() == "---":
            continue
        out.append(s)
        if len(out) >= max_lines and s.strip() == "":
            break
    # Trim leading/trailing blank lines, dedupe consecutive blanks
    while out and not out[0].strip():
        out.pop(0)
    while out and not out[-1].strip():
        out.pop()
    cleaned: list[str] = []
    prev_blank = False
    for line in out:
        if not line.strip():
            if prev_blank:
                continue
            prev_blank = True
        else:
            prev_blank = False
        cleaned.append(line)
    return "\n".join(cleaned).strip()


def file_timestamp(path: Path) -> str:
    """Prefer date prefix in filename; fall back to file mtime."""
    m = DATE_PREFIX_RE.match(path.name)
    if m:
        return f"{m.group(1)}T12:00:00"
    mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return mtime.strftime("%Y-%m-%dT%H:%M:%S")


def build_entry(path: Path, version: str, source_label: str) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    title = extract_title(text, fallback=path.stem.replace("-", " "))
    body = extract_body(text)
    return {
        "id": f"hist-v{version}-{path.stem}",
        "ts": file_timestamp(path),
        "type": "feat",
        "scope": f"historical/{source_label}",
        "title": f"v{version} — {title}" if not title.lower().startswith(f"v{version.lower()}") else title,
        "body": body,
        "related_ids": [f"v{version}"],
        "applied_by": "backfill",
    }


def main() -> int:
    if not CHANGELOG.exists():
        print(f"[backfill] {CHANGELOG} does not exist", flush=True)
        return 1

    have = existing_versions()
    candidates = candidate_files()
    seen_versions: set[str] = set()
    new_entries: list[dict] = []

    # Build version → best-candidate map in priority order. Since SOURCES is
    # ordered and candidate_files() preserves that order, the *first* time
    # we encounter a version, that file is the best source.
    for path, label in candidates:
        v = extract_version_from_name(path)
        if not v:
            continue
        if v in have or v in seen_versions:
            continue
        entry = build_entry(path, v, label)
        new_entries.append(entry)
        seen_versions.add(v)

    if not new_entries:
        print("[backfill] no new versions to add", flush=True)
        return 0

    with CHANGELOG.open("a", encoding="utf-8", newline="\n") as f:
        for entry in new_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    # ASCII-only output to avoid cp1252 stdout issues on Windows shells.
    print(f"[backfill] appended {len(new_entries)} historical entries:", flush=True)
    for entry in new_entries:
        scope = entry["scope"].split("/")[-1] if "/" in entry["scope"] else entry["scope"]
        print(f"  v{entry['related_ids'][0][1:]:<10s} [{scope:<14s}] {entry['title'][:70]}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
