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
ARCHIVE = ULTRON / "plans" / "_archive"
SPECS = ULTRON / "plans" / "specs"

# Matches v15, v15.0, v15.0.2, v15.0b, v15.0.2-rc1, with dot/dash separators
VERSION_RE = re.compile(r"v(\d+)[.\-_](\d+)(?:[.\-_](\d{1,2})(?!\d))?([a-z]+\d*)?", re.IGNORECASE)
# Matches a leading YYYY-MM-DD prefix in archive filenames
DATE_PREFIX_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def normalize_version(m: re.Match) -> str:
    """Match → '15.0.2' / '15.0' / '15.0b' format used by the frontend."""
    major, minor, patch, tag = m.group(1), m.group(2), m.group(3), m.group(4)
    base = f"{major}.{minor}"
    if patch:
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


def candidate_files() -> list[Path]:
    """All markdown files in archive + specs."""
    files: list[Path] = []
    for d in (ARCHIVE, SPECS):
        if d.exists():
            files.extend(sorted(d.glob("*.md")))
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


def build_entry(path: Path, version: str) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    title = extract_title(text, fallback=path.stem.replace("-", " "))
    body = extract_body(text)
    return {
        "id": f"hist-v{version}-{path.stem}",
        "ts": file_timestamp(path),
        "type": "feat",
        "scope": "historical",
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
    files = candidate_files()
    seen_versions: set[str] = set()
    new_entries: list[dict] = []

    for path in files:
        v = extract_version_from_name(path)
        if not v:
            continue
        # Skip if we already have any entry for this version
        if v in have:
            continue
        # Skip if we already emitted a synthetic entry for this version in
        # this run (prefer the first file alphabetically per version)
        if v in seen_versions:
            continue
        entry = build_entry(path, v)
        new_entries.append(entry)
        seen_versions.add(v)

    if not new_entries:
        print("[backfill] no new versions to add (changelog already covers all archive)", flush=True)
        return 0

    with CHANGELOG.open("a", encoding="utf-8", newline="\n") as f:
        for entry in new_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print(f"[backfill] appended {len(new_entries)} historical entries:", flush=True)
    for entry in new_entries:
        print(f"  v{entry['related_ids'][0][1:]:<10s} {entry['title'][:80]}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
