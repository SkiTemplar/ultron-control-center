#!/usr/bin/env python3
"""
ULTRON v12 Brain Index — FTS5-backed retrieval over the 3-layer memory.

The palanca 10x identified by Triple Kirkardo: turn the vault from a passive
collection of markdown files into a queryable, ranked, low-token index. Built
on SQLite FTS5 — zero external dependencies, O(log n), runs offline, no API
calls per query (max token efficiency).

Index location: ~/.ultron/brain_index/index.db (single file, portable)

Sources indexed:
  - L2 vault   ~/.ultron-vault/**/*.md (excluding .obsidian/, .git/)
  - L1 projects ~/.ultron/projects/**/*.md
  - L1 sessions ~/.ultron/sessions/<date>.md (last 30 days only)

Schema:
  notes(id, path, layer, category, title, frontmatter, content_chars,
        mtime, sha1)
  notes_fts(title, content, tags, category, layer) — FTS5 virtual table
  links(src_id, dst_path, kind)  -- [[wikilinks]], [](markdown links), tags

CLI:
  brain_index.py build         Full rebuild (idempotent, deletes stale rows)
  brain_index.py update        Incremental — only re-index changed files
  brain_index.py query "..."   FTS5 + filter; --layer / --category / --top K
  brain_index.py stats         Counts, last update, broken links
  brain_index.py inspect <id>  Full record dump

Token efficiency:
  - Index is ~1MB for 32 vault notes (size grows linearly with content)
  - Query returns top-K with snippet (200 chars) — typical retrieval <2K tokens
  - vs reading the whole vault (~58K tokens), 30x reduction.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys

# Windows console: force UTF-8 so arrow / glyph chars don't crash with cp1252.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

VAULT_DIR = Path.home() / ".ultron-vault"
MEMORY_L1_DIR = Path.home() / ".ultron-vault" / "00_INDEX" / "_packets"  # S3-B: warm L1 packets (vault-resident as of v14.9)
ULTRON_DIR = Path.home() / ".ultron"
PROJECTS_DIR = ULTRON_DIR / "projects"
SESSIONS_DIR = ULTRON_DIR / "sessions"
ARCHIVE_DIR = ULTRON_DIR / "archive"  # cold but searchable: deferred plans, retired sessions
CLAUDE_SKILLS_DIR = Path.home() / ".claude" / "skills"
VAULT_SKILLS_DIR = ULTRON_DIR / "skill-vault"  # v15.0b: skills fuera del contexto, pero indexables para recall

INDEX_DIR = ULTRON_DIR / "brain_index"
INDEX_PATH = INDEX_DIR / "index.db"
_COCKPIT_DIR = str(Path(__file__).parent)

def _session_lookback_days() -> int:
    try:
        if _COCKPIT_DIR not in sys.path:
            sys.path.insert(0, _COCKPIT_DIR)
        from brain_config import load as _load_cfg  # type: ignore
        return int(_load_cfg().get("brain_session_lookback_days", 30))
    except Exception:
        return 30


SESSION_LOOKBACK_DAYS = _session_lookback_days()

# Skip noise paths by exact path-component match (NOT substring — see _is_skipped).
# `40_SKILLS/` exclusion (Auditor 2): vault folder mirrored the live skills
# directory (~410 stub files), drowning real curated knowledge — 87% of indexed
# notes were skill descriptors. CLAUDE_SKILLS_DIR walker already covers them.
# `_archive/` exclusion: decay_queue.archive moves stale notes there; they
# shouldn't keep polluting brain_index queries.
#
# v12.5.1 fix (M-MED-3 Kirkardo TOTAL v2 2026-05-03): substring match leaked
# 3 notes — `labarchive-integration/SKILL.md` (substring `archive` false-positive
# for `_archive/`), `decisions-archive.md` and `feedback_archive-not-delete.md`
# (substring failed to match `_archive/` literal). Switching to path-component
# membership eliminates both classes of error.
SKIP_DIRS = frozenset({
    ".git", ".obsidian", "__pycache__", ".tmp",
    "deprecated-memory-system", "40_SKILLS", "_archive",
    "v6.x-legacy",       # subdir of `archive/`, kept for safety
    "skill_cache",       # retired SKILL.md copies, no value indexing
    ".pytest_cache", ".venv", ".uv-cache-rescue", "node_modules",
})


# ── Schema ────────────────────────────────────────────────────────────────────

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    layer TEXT NOT NULL,            -- L1-projects | L1-sessions | L2-vault | L1-skills | L1-skills-ref
    category TEXT,                   -- knowledge | decisions | patterns | sessions | other
    title TEXT,
    frontmatter TEXT,                -- raw YAML block
    content TEXT,                    -- full body (stripped of frontmatter)
    content_chars INTEGER,
    mtime REAL NOT NULL,
    sha1 TEXT NOT NULL
);

-- FTS5 in regular (self-contained) mode — keeps own copy of indexed text.
-- 2x storage vs contentless, but immune to schema drift on the source table.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, content, tags, category, layer,
    tokenize='unicode61 remove_diacritics 2'
);

-- S2-A: chunk-level FTS5 table for sub-note retrieval with BM25 ranking.
-- UNINDEXED columns are stored but not included in full-text search.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    note_id UNINDEXED,
    chunk_idx UNINDEXED,
    layer UNINDEXED,
    category UNINDEXED,
    domain UNINDEXED,
    token_est UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY,
    src_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    dst_path TEXT NOT NULL,         -- target as written (may not be a real file)
    kind TEXT NOT NULL              -- wikilink | markdown | tag
);

CREATE INDEX IF NOT EXISTS idx_notes_layer    ON notes(layer);
CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);
CREATE INDEX IF NOT EXISTS idx_links_src      ON links(src_id);
CREATE INDEX IF NOT EXISTS idx_links_dst      ON links(dst_path);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


# ── Source discovery ──────────────────────────────────────────────────────────

@dataclass
class Source:
    path: Path
    layer: str
    category: str


def _is_skipped(p: Path) -> bool:
    """True if any path component (directory name) matches a SKIP_DIRS entry.

    Component-level matching avoids both false-positives ('labarchive' as
    substring of '_archive') and false-negatives ('decisions-archive.md' is a
    file inside `20_DECISIONS/`, not under `_archive/` — should NOT be skipped).
    """
    return any(part in SKIP_DIRS for part in p.parts)


def discover_sources() -> list[Source]:
    """Walk the 5 source roots and yield indexable .md files.

    Sources:
      L2-vault       — long-term curated knowledge (Obsidian)
      L1-projects    — per-project memory
      L1-sessions    — recent session digests (last N days)
      L1-skills      — every installed skill's SKILL.md
      L1-skills-ref  — references/*.md under each skill dir
    """
    out: list[Source] = []

    if VAULT_DIR.exists():
        for md in VAULT_DIR.rglob("*.md"):
            if _is_skipped(md):
                continue
            cat = _vault_category(md)
            out.append(Source(md, "L2-vault", cat))

    if PROJECTS_DIR.exists():
        for md in PROJECTS_DIR.rglob("*.md"):
            if _is_skipped(md):
                continue
            out.append(Source(md, "L1-projects", "projects"))

    # S3-B: warm L1 memory packets (projects-active.md, recent-decisions.md,
    # skills-routing.md, system-state.md). These are the on-demand context
    # files queried by context_packet_builder. Without indexing them here,
    # the dispatcher's L1 query mode finds no chunks → no context injection.
    if MEMORY_L1_DIR.exists():
        for md in MEMORY_L1_DIR.glob("*.md"):
            if _is_skipped(md):
                continue
            # Reuse the L1-projects layer so context_packet_builder's
            # `layer="L1"` LIKE pattern picks them up alongside ~/.ultron/projects.
            # Category "memory" distinguishes them from per-project notes.
            out.append(Source(md, "L1-projects", "memory"))

    if SESSIONS_DIR.exists():
        cutoff = datetime.now() - timedelta(days=SESSION_LOOKBACK_DAYS)
        for md in SESSIONS_DIR.glob("*.md"):
            try:
                m = datetime.fromtimestamp(md.stat().st_mtime)
            except OSError:
                continue
            if m < cutoff:
                continue
            out.append(Source(md, "L1-sessions", "sessions"))

    # L2-archive: cold but searchable. Includes deferred plans, retired sessions,
    # migration handovers. Excludes skill_cache (retired SKILL.md copies) and
    # v6.x-legacy via SKIP_DIRS. Indexed so historical context is queryable
    # without manual file hunting.
    if ARCHIVE_DIR.exists():
        for md in ARCHIVE_DIR.rglob("*.md"):
            if _is_skipped(md):
                continue
            out.append(Source(md, "L2-archive", "archive"))

    if CLAUDE_SKILLS_DIR.exists():
        for skill_dir in CLAUDE_SKILLS_DIR.iterdir():
            if not skill_dir.is_dir() or skill_dir.name.startswith("."):
                continue
            skill_md = skill_dir / "SKILL.md"
            if skill_md.exists():
                out.append(Source(skill_md, "L1-skills", "skill"))
            refs_dir = skill_dir / "references"
            if refs_dir.is_dir():
                for ref_md in refs_dir.glob("*.md"):
                    out.append(Source(ref_md, "L1-skills-ref", "skill-ref"))

    # v15.0b: skills vaulteadas — no cargan en contexto, pero su SKILL.md se
    # indexa en FTS5 para que `ultron recall "<topic>"` cubra también su contenido.
    if VAULT_SKILLS_DIR.exists():
        for skill_dir in VAULT_SKILLS_DIR.iterdir():
            if not skill_dir.is_dir() or skill_dir.name.startswith("."):
                continue
            skill_md = skill_dir / "SKILL.md"
            if skill_md.exists():
                out.append(Source(skill_md, "L1-skills-vault", "skill-vault"))

    return out


def _vault_category(path: Path) -> str:
    """Map vault path to MECE category from its top-level numbered dir."""
    try:
        rel = path.relative_to(VAULT_DIR)
    except ValueError:
        return "other"
    if not rel.parts:
        return "root"
    head = rel.parts[0]
    mapping = {
        "00_INDEX": "index", "10_KNOWLEDGE": "knowledge",
        "20_DECISIONS": "decisions", "30_PATTERNS": "patterns",
        "40_NEWS_ARCHIVE": "news", "50_SESSIONS_LOG": "sessions",
    }
    return mapping.get(head, "other")


# ── Note parsing ──────────────────────────────────────────────────────────────

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
WIKILINK_RE = re.compile(r"\[\[([^\]\|#]+)(?:\|[^\]]+)?(?:#[^\]]*)?\]\]")
MD_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+\.md)\)")
TAG_LINE_RE = re.compile(r"^tags?\s*:\s*(.+)$", re.MULTILINE)


@dataclass
class ParsedNote:
    title: str
    frontmatter: str
    body: str
    tags: list[str]
    wikilinks: list[str]
    md_links: list[str]


def parse_note(text: str, fallback_title: str) -> ParsedNote:
    fm = ""
    body = text
    m = FRONTMATTER_RE.match(text)
    if m:
        fm = m.group(1)
        body = text[m.end():]

    title = fallback_title
    # Prefer first H1 if present
    for line in body.splitlines():
        s = line.strip()
        if s.startswith("# "):
            title = s.lstrip("# ").strip()
            break

    tags: list[str] = []
    if fm:
        tag_match = TAG_LINE_RE.search(fm)
        if tag_match:
            raw = tag_match.group(1).strip()
            # YAML list style: [a, b, c] or - a / - b
            raw = raw.strip("[]")
            tags = [t.strip().strip('"').strip("'")
                     for t in re.split(r"[,\n]\s*-?\s*", raw) if t.strip()]

    wikilinks = [w.strip() for w in WIKILINK_RE.findall(body)]
    md_links = [m.strip() for m in MD_LINK_RE.findall(body)]

    return ParsedNote(title=title, frontmatter=fm, body=body,
                       tags=tags, wikilinks=wikilinks, md_links=md_links)


def hash_content(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def _extract_domain(path: Path, layer: str) -> str:
    """Semantic domain for finer-grained routing (W3.1).

    L2-vault 10_KNOWLEDGE/<subdir>/ → "cpp-ue5", "opengl", "claude-platform", …
    L1-skills                       → skill dir name ("don-claudio", "terry-davis", …)
    L1-sessions                     → "session"
    L1-projects                     → "project"
    """
    if layer == "L2-vault":
        try:
            rel = path.relative_to(VAULT_DIR)
        except ValueError:
            return ""
        parts = rel.parts
        if len(parts) >= 2 and parts[0] == "10_KNOWLEDGE":
            return parts[1]
        return ""
    if layer == "L1-skills":
        return path.parent.name
    if layer == "L1-skills-ref":
        return path.parent.parent.name
    if layer == "L1-sessions":
        return "session"
    if layer == "L1-projects":
        return "project"
    return ""


# ── routing_hint extraction ────────────────────────────────────────────────────
# Matches `routing_hint: "..."` or `routing_hint: ...` in YAML frontmatter.
_ROUTING_HINT_RE = re.compile(r'^routing_hint:\s*["\']?(.*?)["\']?\s*$', re.MULTILINE)


def _extract_routing_hint(frontmatter: str) -> str:
    """Return routing_hint value from frontmatter, or empty string."""
    if not frontmatter:
        return ""
    m = _ROUTING_HINT_RE.search(frontmatter)
    return m.group(1).strip() if m else ""


# ── S2-A Splitter ─────────────────────────────────────────────────────────────

_HEADING_RE = re.compile(r"^#{1,6}\s+\S")
_SUBHEADING_RE = re.compile(r"^##\s+\S", re.MULTILINE)
_MERGE_THRESHOLD = 50     # words — merge consecutive blocks below this
_SPLIT_THRESHOLD = 300    # words — blocks above this get further split
_SPLIT_WINDOW = 250       # target words per window when splitting by length


def _word_count(text: str) -> int:
    return len(text.split())


def _split_by_length(text: str, window: int = _SPLIT_WINDOW) -> list[str]:
    """Split a long block into ~window-word windows.

    Prefers line boundaries; falls back to word-level splitting when a single
    "line" already exceeds the window (e.g. a 1000-word paragraph with no
    internal newlines — common in markdown notes).
    """
    words = text.split()
    if len(words) <= window:
        return [text]
    chunks: list[str] = []
    lines = text.splitlines(keepends=True)
    cur_words = 0
    cur_lines: list[str] = []
    for line in lines:
        line_words = line.split()
        lw = len(line_words)
        # Edge case: a single line is bigger than the window. Flush the buffer
        # and split the line itself into word-windows so we never emit a chunk
        # that exceeds the threshold.
        if lw > window:
            if cur_lines:
                chunks.append("".join(cur_lines).strip())
                cur_lines = []
                cur_words = 0
            for i in range(0, lw, window):
                chunks.append(" ".join(line_words[i:i + window]).strip())
            continue
        if cur_words + lw > window and cur_lines:
            chunks.append("".join(cur_lines).strip())
            cur_lines = []
            cur_words = 0
        cur_lines.append(line)
        cur_words += lw
    if cur_lines:
        chunks.append("".join(cur_lines).strip())
    return [c for c in chunks if c]


def split_into_chunks(text: str) -> list[dict]:
    """Split a note body into indexable chunks with token estimates.

    Algorithm:
      1. Split on double-newline paragraph breaks.
      2. Track the last seen heading (prepend as context to each chunk).
      3. Merge consecutive small blocks (<50 words) into one chunk.
      4. Split large blocks (>300 words) — first by ##-subheadings, then by
         fixed-length windows (~250 words each).

    Returns a list of dicts:
        {"content": str, "chunk_idx": int, "token_est": int}
    where token_est = len(content) // 4  (GPT-style approximation).
    """
    raw_blocks = [b.strip() for b in re.split(r"\n\n+", text) if b.strip()]
    last_heading = ""

    # Phase 1: assign heading context and produce preliminary blocks
    prelim: list[str] = []
    for block in raw_blocks:
        first_line = block.splitlines()[0] if block else ""
        if _HEADING_RE.match(first_line):
            last_heading = first_line
        if last_heading and not block.startswith(last_heading):
            content = last_heading + "\n\n" + block
        else:
            content = block
        prelim.append(content)

    # Phase 2: merge small consecutive blocks
    merged: list[str] = []
    for block in prelim:
        if merged and _word_count(merged[-1]) < _MERGE_THRESHOLD:
            merged[-1] = merged[-1] + "\n\n" + block
        else:
            merged.append(block)

    # Phase 3: split oversized blocks
    final: list[str] = []
    for block in merged:
        if _word_count(block) <= _SPLIT_THRESHOLD:
            final.append(block)
        else:
            # Try splitting by ##-subheadings first
            sub_matches = list(_SUBHEADING_RE.finditer(block))
            if len(sub_matches) >= 2:
                # Build sections: text before first ## + each ## section
                reconstructed: list[str] = []
                first_start = sub_matches[0].start()
                if block[:first_start].strip():
                    reconstructed.append(block[:first_start].strip())
                for idx2, m in enumerate(sub_matches):
                    start = m.start()
                    end = sub_matches[idx2 + 1].start() if idx2 + 1 < len(sub_matches) else len(block)
                    reconstructed.append(block[start:end].strip())
                for part in reconstructed:
                    if _word_count(part) <= _SPLIT_THRESHOLD:
                        final.append(part)
                    else:
                        final.extend(_split_by_length(part))
            else:
                final.extend(_split_by_length(block))

    # Phase 4: produce output dicts
    result: list[dict] = []
    for idx, content in enumerate(final):
        if not content:
            continue
        result.append({
            "content": content,
            "chunk_idx": idx,
            "token_est": len(content) // 4,
        })
    return result


# ── Index operations ──────────────────────────────────────────────────────────

def open_db() -> sqlite3.Connection:
    """Open index for write commands — creates schema, runs migrations, enables WAL.
    Use ONLY from cmd_build / cmd_update / cite_notes (write path)."""
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(INDEX_PATH))
    conn.executescript(SCHEMA_SQL)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    # W3.1: idempotent migration — add domain column if this is an older index
    try:
        conn.execute("ALTER TABLE notes ADD COLUMN domain TEXT NOT NULL DEFAULT ''")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists
    # S2-A: idempotent migration — add token_est column for whole-note cost estimate
    try:
        conn.execute("ALTER TABLE notes ADD COLUMN token_est INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists
    # S2-A: ensure chunks_fts exists (for databases created before S2-A schema)
    try:
        conn.executescript("""
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                content,
                note_id UNINDEXED,
                chunk_idx UNINDEXED,
                layer UNINDEXED,
                category UNINDEXED,
                domain UNINDEXED,
                token_est UNINDEXED,
                tokenize='unicode61 remove_diacritics 2'
            );
        """)
        conn.commit()
    except sqlite3.OperationalError:
        pass  # already exists
    return conn


def _open_conn() -> sqlite3.Connection:
    """Open index for read-only commands — no DDL, no schema migration, no write lock.
    Use from cmd_query / cmd_stats / cmd_inspect."""
    return sqlite3.connect(str(INDEX_PATH))


def _upsert_chunks(conn: sqlite3.Connection, note_id: int, body: str,
                    layer: str, category: str, domain: str) -> int:
    """Delete and re-insert chunks for a note. Returns total token_est.

    Fails softly if chunks_fts doesn't exist (e.g. migration not yet applied).
    Always updates notes.token_est regardless of chunks_fts availability.
    """
    chunks = split_into_chunks(body)
    total_tokens = sum(c["token_est"] for c in chunks)

    # Update the whole-note token estimate unconditionally (min 1 for empty files)
    conn.execute("UPDATE notes SET token_est=? WHERE id=?", (max(1, total_tokens), note_id))

    # Now (re)populate chunks_fts — fail-soft if table absent
    try:
        conn.execute("DELETE FROM chunks_fts WHERE note_id=?", (note_id,))
        rows = [
            (c["content"], note_id, c["chunk_idx"], layer, category, domain, c["token_est"])
            for c in chunks
        ]
        conn.executemany(
            "INSERT INTO chunks_fts(content, note_id, chunk_idx, layer, category, domain, token_est) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
    except sqlite3.OperationalError:
        pass  # chunks_fts table not yet available — safe to skip

    return total_tokens


def upsert_note(conn: sqlite3.Connection, src: Source) -> tuple[bool, str]:
    """Index a single source. Returns (changed, reason)."""
    try:
        text = src.path.read_text(encoding="utf-8")
    except OSError as e:
        return False, f"read-error: {e}"

    sha = hash_content(text)
    mtime = src.path.stat().st_mtime
    rel = src.path.as_posix()

    # Skip if unchanged
    row = conn.execute("SELECT id, sha1 FROM notes WHERE path=?", (rel,)).fetchone()
    if row and row[1] == sha:
        note_id = row[0]
        # S2-A migration backfill: if pre-S2-A note lacks chunks or token_est,
        # populate them now even though content is unchanged. This makes
        # `update` self-healing for DBs created before S2-A schema landed.
        needs_backfill = False
        try:
            has_chunks = conn.execute(
                "SELECT 1 FROM chunks_fts WHERE note_id=? LIMIT 1", (note_id,)
            ).fetchone() is not None
        except sqlite3.OperationalError:
            has_chunks = False  # chunks_fts not yet present — backfill below will be a no-op
        token_est = conn.execute(
            "SELECT COALESCE(token_est, 0) FROM notes WHERE id=?", (note_id,)
        ).fetchone()[0]
        if not has_chunks or token_est <= 0:
            needs_backfill = True
        if needs_backfill:
            stored = conn.execute(
                "SELECT content, layer, category, domain FROM notes WHERE id=?", (note_id,)
            ).fetchone()
            if stored:
                body, layer_v, category_v, domain_v = stored
                _upsert_chunks(conn, note_id, body or "", layer_v or "",
                                category_v or "", domain_v or "")
                return False, "unchanged-backfilled"
        return False, "unchanged"

    parsed = parse_note(text, src.path.stem)
    tags_str = " ".join(parsed.tags)
    domain = _extract_domain(src.path, src.layer)

    if row:
        note_id = row[0]
        conn.execute(
            "UPDATE notes SET layer=?, category=?, domain=?, title=?, frontmatter=?, "
            "content=?, content_chars=?, mtime=?, sha1=? WHERE id=?",
            (src.layer, src.category, domain, parsed.title, parsed.frontmatter,
             parsed.body, len(parsed.body), mtime, sha, note_id),
        )
        conn.execute("DELETE FROM notes_fts WHERE rowid=?", (note_id,))
    else:
        cur = conn.execute(
            "INSERT INTO notes(path, layer, category, domain, title, frontmatter, "
            "content, content_chars, mtime, sha1) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (rel, src.layer, src.category, domain, parsed.title, parsed.frontmatter,
             parsed.body, len(parsed.body), mtime, sha),
        )
        note_id = cur.lastrowid

    # Extract routing_hint from frontmatter to augment FTS content
    routing_hint = _extract_routing_hint(parsed.frontmatter)
    fts_content = parsed.body
    if routing_hint:
        # Append routing signals to notes_fts body so notes-level queries benefit
        fts_content = fts_content + "\n\n" + routing_hint

    conn.execute(
        "INSERT INTO notes_fts(rowid, title, content, tags, category, layer) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (note_id, parsed.title, fts_content, tags_str, src.category, src.layer),
    )

    # S2-A: rebuild chunks for this note (idempotent — DELETE+INSERT)
    _upsert_chunks(conn, note_id, parsed.body, src.layer, src.category, domain)

    # Inject routing_hint as a dedicated anchor chunk (chunk_idx=-1) so ZTMSI
    # can find this note when the user's query matches routing_hint keywords.
    if routing_hint:
        try:
            conn.execute(
                "DELETE FROM chunks_fts WHERE note_id=? AND chunk_idx=-1", (note_id,)
            )
            conn.execute(
                "INSERT INTO chunks_fts(content, note_id, chunk_idx, layer, category, domain, token_est) "
                "VALUES (?, ?, -1, ?, ?, ?, ?)",
                (routing_hint, note_id, src.layer, src.category, domain,
                 len(routing_hint) // 4),
            )
        except sqlite3.OperationalError:
            pass

    # Refresh links
    conn.execute("DELETE FROM links WHERE src_id=?", (note_id,))
    link_rows: list[tuple[int, str, str]] = []
    for w in parsed.wikilinks:
        link_rows.append((note_id, w, "wikilink"))
    for m in parsed.md_links:
        link_rows.append((note_id, m, "markdown"))
    for t in parsed.tags:
        link_rows.append((note_id, t, "tag"))
    if link_rows:
        conn.executemany(
            "INSERT INTO links(src_id, dst_path, kind) VALUES (?, ?, ?)",
            link_rows,
        )

    return True, ("updated" if row else "inserted")


def prune_missing(conn: sqlite3.Connection,
                   valid_sources: list["Source"] | None = None) -> int:
    """Drop rows whose source is no longer indexable.

    A row is dropped if either:
      - The file no longer exists on disk
      - The path matches SKIP_DIRS (file was excluded after being indexed)
      - `valid_sources` is provided and the path is not in that set
        (canonical pruning against the current discover_sources() output)

    F8 (2026-05-03 Kirkardo TOTAL): without the SKIP_DIRS check here,
    `update` left 410 stale stubs in 40_SKILLS/ even after the exclusion was
    added. Only `build` (full rebuild) cleaned them. Now `update` is also
    self-healing.
    """
    cur = conn.execute("SELECT id, path FROM notes")
    valid_paths: set[str] | None = None
    if valid_sources is not None:
        valid_paths = {s.path.as_posix() for s in valid_sources}
    drop_ids: list[int] = []
    for nid, path in cur.fetchall():
        p = Path(path)
        if not p.exists():
            drop_ids.append(nid)
            continue
        if _is_skipped(p):
            drop_ids.append(nid)
            continue
        if valid_paths is not None and path not in valid_paths:
            drop_ids.append(nid)
    if drop_ids:
        conn.executemany("DELETE FROM notes WHERE id=?", [(i,) for i in drop_ids])
        conn.executemany("DELETE FROM notes_fts WHERE rowid=?",
                          [(i,) for i in drop_ids])
        # S2-A: also prune chunks for dropped notes (fail-soft)
        try:
            conn.executemany("DELETE FROM chunks_fts WHERE note_id=?",
                              [(i,) for i in drop_ids])
        except sqlite3.OperationalError:
            pass  # chunks_fts may not exist on older indexes
    return len(drop_ids)


def cmd_build(_args) -> int:
    """Full rebuild — wipes the FTS5 + notes data, but PRESERVES decay_state
    so manual `ultron decay verify` history doesn't get wiped on rebuild.

    Strategy: snapshot decay_state to a sidecar JSON before nuking the DB,
    then restore (key by note path) after the rebuild repopulates notes.id
    (path → new id may shift, that's why we key by path, not id).
    """
    decay_snapshot: list[dict] = []
    if INDEX_PATH.exists():
        try:
            conn = sqlite3.connect(str(INDEX_PATH))
            # Only attempt snapshot if both tables exist (older builds may not).
            try:
                rows = conn.execute(
                    "SELECT n.path, d.last_verified_at, d.criticality, "
                    "d.verify_count, d.last_seen_in_session "
                    "FROM decay_state d JOIN notes n ON n.id = d.note_id"
                ).fetchall()
                decay_snapshot = [
                    {"path": r[0], "last_verified_at": r[1],
                     "criticality": r[2], "verify_count": r[3],
                     "last_seen_in_session": r[4]}
                    for r in rows
                ]
            except sqlite3.OperationalError:
                pass  # table didn't exist yet
            conn.close()
        except sqlite3.DatabaseError:
            pass
        INDEX_PATH.unlink()

    rc = cmd_update(_args)
    if rc != 0 or not decay_snapshot:
        if decay_snapshot:
            print(f"[brain_index] WARN: had decay snapshot ({len(decay_snapshot)} "
                   "rows) but rebuild failed — snapshot held in memory only")
        return rc

    # Restore decay_state by joining on path (may have a different note_id now)
    conn = sqlite3.connect(str(INDEX_PATH))
    try:
        conn.executescript(
            "CREATE TABLE IF NOT EXISTS decay_state ("
            "  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,"
            "  last_verified_at TEXT NOT NULL,"
            "  criticality TEXT NOT NULL DEFAULT 'medium',"
            "  verify_count INTEGER NOT NULL DEFAULT 0,"
            "  last_seen_in_session TEXT);"
        )
        restored = 0
        for entry in decay_snapshot:
            row = conn.execute(
                "SELECT id FROM notes WHERE path = ?", (entry["path"],)
            ).fetchone()
            if not row:
                continue  # note was deleted between rebuilds — skip
            note_id = row[0]
            conn.execute(
                "INSERT OR REPLACE INTO decay_state(note_id, last_verified_at, "
                "criticality, verify_count, last_seen_in_session) "
                "VALUES (?, ?, ?, ?, ?)",
                (note_id, entry["last_verified_at"], entry["criticality"],
                 entry["verify_count"], entry["last_seen_in_session"]),
            )
            restored += 1
        conn.commit()
    finally:
        conn.close()
    print(f"[brain_index] decay_state restored: {restored}/{len(decay_snapshot)} rows")
    return 0


def cmd_update(_args) -> int:
    """Incremental update — only re-index changed files."""
    conn = open_db()
    sources = discover_sources()
    inserted = updated = unchanged = 0
    try:
        with conn:
            for src in sources:
                changed, reason = upsert_note(conn, src)
                if not changed:
                    unchanged += 1
                elif reason == "inserted":
                    inserted += 1
                else:
                    updated += 1
            pruned = prune_missing(conn, valid_sources=sources)
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                ("last_updated", datetime.now().isoformat()),
            )
    finally:
        conn.close()
    print(f"[brain_index] inserted={inserted} updated={updated} "
           f"unchanged={unchanged} pruned={pruned}")
    print(f"[brain_index] index → {INDEX_PATH}")
    return 0


def cmd_query(args) -> int:
    """FTS5 query with optional filters. Returns JSON (top-K).

    --mode notes  (default): legacy notes_fts behavior — identical JSON schema
                             as pre-S2-A for full back-compat.
    --mode chunks: query chunks_fts with BM25 ranking, return per-chunk results
                   with note_path, chunk_idx, token_est, snippet, bm25.
    """
    if not INDEX_PATH.exists():
        print("[error] Index not built — run: brain_index.py build", file=sys.stderr)
        return 1
    conn = _open_conn()
    try:
        fts_query = args.query
        try:
            from brain_config import load_synonyms as _ls  # type: ignore
            _syns = _ls()
            tl = fts_query.lower().strip()
            for _term, _expansion in _syns.items():
                if tl == _term or f" {_term} " in f" {tl} " or tl.startswith(f"{_term} "):
                    fts_query = _expansion
                    break
        except Exception:
            pass

        mode = getattr(args, "mode", "notes") or "notes"

        if mode == "chunks":
            return _cmd_query_chunks(conn, args, fts_query)

        # ── mode=notes (default, back-compat) ──
        where = []
        params: list = []
        if args.layer:
            where.append("notes.layer = ?")
            params.append(args.layer)
        if args.category:
            where.append("notes.category = ?")
            params.append(args.category)
        if getattr(args, "domain", None):
            where.append("notes.domain = ?")
            params.append(args.domain)

        where_clause = (" AND " + " AND ".join(where)) if where else ""
        sql = (
            "SELECT notes.id, notes.path, notes.layer, notes.category, notes.domain, "
            "notes.title, snippet(notes_fts, 1, '«', '»', '…', 12) AS snippet, "
            "bm25(notes_fts) AS rank "
            "FROM notes_fts JOIN notes ON notes_fts.rowid = notes.id "
            f"WHERE notes_fts MATCH ? {where_clause} "
            "ORDER BY rank LIMIT ?"
        )
        params = [fts_query, *params, (args.top or 8)]
        try:
            rows = conn.execute(sql, params).fetchall()
        except sqlite3.OperationalError as e:
            print(json.dumps({"error": str(e), "query": fts_query}, indent=2))
            return 1
        out = [
            {
                "id": r[0], "path": r[1], "layer": r[2], "category": r[3],
                "domain": r[4], "title": r[5], "snippet": r[6], "rank": round(r[7], 3),
            }
            for r in rows
        ]
        print(json.dumps({"query": fts_query, "matches": len(out), "results": out},
                           indent=2, ensure_ascii=False))
        return 0
    finally:
        conn.close()


def _cmd_query_chunks(conn: sqlite3.Connection, args, fts_query: str) -> int:
    """Execute a --mode chunks query against chunks_fts.

    Returns JSON: {"query": str, "mode": "chunks", "matches": int, "results": [...]}
    Each result: {note_path, chunk_idx, token_est, snippet, bm25, layer, category, domain}
    """
    top_k = getattr(args, "top", None) or 5
    try:
        sql = (
            "SELECT n.path, cf.chunk_idx, cf.token_est, "
            "snippet(chunks_fts, 0, '«', '»', '…', 12) AS snippet, "
            "bm25(chunks_fts) AS bm25_score, "
            "cf.layer, cf.category, cf.domain "
            "FROM chunks_fts cf "
            "JOIN notes n ON n.id = cf.note_id "
            "WHERE chunks_fts MATCH ? "
            "ORDER BY bm25_score LIMIT ?"
        )
        rows = conn.execute(sql, (fts_query, top_k)).fetchall()
    except sqlite3.OperationalError as e:
        print(json.dumps({"error": str(e), "query": fts_query, "mode": "chunks"}, indent=2))
        return 1
    out = [
        {
            "note_path": r[0],
            "chunk_idx": r[1],
            "token_est": r[2],
            "snippet": r[3],
            "bm25": round(r[4], 3),
            "layer": r[5],
            "category": r[6],
            "domain": r[7],
        }
        for r in rows
    ]
    print(json.dumps({"query": fts_query, "mode": "chunks", "matches": len(out), "results": out},
                       indent=2, ensure_ascii=False))
    return 0


def cmd_stats(_args) -> int:
    if not INDEX_PATH.exists():
        print("[error] Index not built — run: brain_index.py build", file=sys.stderr)
        return 1
    conn = _open_conn()
    try:
        total = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        by_layer = dict(conn.execute(
            "SELECT layer, COUNT(*) FROM notes GROUP BY layer").fetchall())
        by_cat = dict(conn.execute(
            "SELECT category, COUNT(*) FROM notes GROUP BY category").fetchall())
        by_domain = dict(conn.execute(
            "SELECT COALESCE(NULLIF(domain,''),'—'), COUNT(*) FROM notes "
            "GROUP BY domain ORDER BY 2 DESC").fetchall())
        link_count = conn.execute("SELECT COUNT(*) FROM links").fetchone()[0]
        broken = conn.execute(
            "SELECT COUNT(*) FROM links WHERE kind='wikilink' "
            "AND dst_path NOT IN (SELECT title FROM notes) "
            "AND dst_path NOT IN (SELECT path FROM notes)"
        ).fetchone()[0]
        last = conn.execute(
            "SELECT value FROM meta WHERE key='last_updated'").fetchone()
        # S2-A: chunk + token stats (fail-soft — chunks_fts may not exist yet)
        total_chunks = 0
        total_tokens = 0
        avg_chunk_tokens = 0.0
        avg_chunks_per_note = 0.0
        try:
            total_chunks = conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0]
            total_tokens_row = conn.execute(
                "SELECT COALESCE(SUM(token_est), 0) FROM notes").fetchone()
            total_tokens = total_tokens_row[0] if total_tokens_row else 0
            if total_chunks > 0:
                avg_chunk_tokens = conn.execute(
                    "SELECT AVG(CAST(token_est AS REAL)) FROM chunks_fts"
                ).fetchone()[0] or 0.0
            if total > 0:
                avg_chunks_per_note = total_chunks / total
        except sqlite3.OperationalError:
            pass  # chunks_fts not yet built
    finally:
        conn.close()
    size_kb = INDEX_PATH.stat().st_size / 1024

    print(f"⌬  Brain Index — {INDEX_PATH}")
    print("=" * 70)
    print(f"  Total notes:    {total}")
    print(f"  Index size:     {size_kb:.1f} KB")
    print(f"  Last updated:   {last[0] if last else '(never)'}")
    print()
    print("  By layer:")
    for k, v in sorted(by_layer.items()):
        print(f"    {k:<14} {v}")
    print()
    print("  By category:")
    for k, v in sorted(by_cat.items()):
        print(f"    {k:<14} {v}")
    print()
    print("  By domain:")
    for k, v in sorted(by_domain.items(), key=lambda x: -x[1]):
        print(f"    {k:<22} {v}")
    print()
    print(f"  Total links:    {link_count}")
    print(f"  Broken wikilinks (target not in index): {broken}")
    print()
    print("  S2-A Chunk stats:")
    print(f"    total_chunks:           {total_chunks}")
    print(f"    total_tokens_indexed:   {total_tokens}")
    print(f"    avg_chunk_tokens:       {avg_chunk_tokens:.1f}")
    print(f"    avg_chunks_per_note:    {avg_chunks_per_note:.1f}")
    return 0


def cmd_inspect(args) -> int:
    if not INDEX_PATH.exists():
        print("[error] Index not built", file=sys.stderr)
        return 1
    conn = _open_conn()
    try:
        row = conn.execute(
            "SELECT id, path, layer, category, title, frontmatter, content_chars, "
            "mtime, sha1 FROM notes WHERE id=?", (args.id,),
        ).fetchone()
        if not row:
            print(f"[error] No note with id={args.id}", file=sys.stderr)
            return 1
        keys = ["id", "path", "layer", "category", "title", "frontmatter",
                 "content_chars", "mtime", "sha1"]
        record = dict(zip(keys, row))
        record["mtime"] = datetime.fromtimestamp(record["mtime"]).isoformat()
        out_links = conn.execute(
            "SELECT dst_path, kind FROM links WHERE src_id=?", (args.id,),
        ).fetchall()
        record["outgoing_links"] = [{"dst": d, "kind": k} for d, k in out_links]
        in_links = conn.execute(
            "SELECT n.path, l.kind FROM links l JOIN notes n ON n.id = l.src_id "
            "WHERE l.dst_path = ? OR l.dst_path = (SELECT title FROM notes WHERE id=?)",
            (record["path"], args.id),
        ).fetchall()
        record["incoming_links"] = [{"src": p, "kind": k} for p, k in in_links]
    finally:
        conn.close()
    print(json.dumps(record, indent=2, ensure_ascii=False))
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        prog="brain_index",
        description="ULTRON v12 Brain Index — FTS5 retrieval over 3-layer memory",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("build", help="Full rebuild (wipes existing index)").set_defaults(
        func=cmd_build)
    sub.add_parser("update", help="Incremental update").set_defaults(
        func=cmd_update)

    sp = sub.add_parser("query", help="FTS5 query with filters")
    sp.add_argument("query", help="FTS5 query string")
    sp.add_argument("--layer", help="Filter: L1-projects | L1-sessions | L2-vault")
    sp.add_argument("--category", help="Filter: knowledge | decisions | patterns | …")
    sp.add_argument("--domain", help="Filter: cpp-ue5 | opengl | claude-platform | don-claudio | …")
    sp.add_argument("--top", type=int, default=None,
                    help="Top-K (default: 8 for --mode notes, 5 for --mode chunks)")
    sp.add_argument("--mode", choices=["notes", "chunks"], default="notes",
                    help="Query mode: notes (default, back-compat) | chunks (S2-A chunk-level BM25)")
    sp.set_defaults(func=cmd_query)

    sub.add_parser("stats", help="Index counts + health").set_defaults(
        func=cmd_stats)

    sp = sub.add_parser("inspect", help="Dump full record + links")
    sp.add_argument("id", type=int, help="Note id (from query results)")
    sp.set_defaults(func=cmd_inspect)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
