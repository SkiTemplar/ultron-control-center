#!/usr/bin/env python3
"""
ULTRON v13.1 — Session Highlights (Sprint 4 F15).

Extracts a TOKEN-FRIENDLY highlight digest from each `auto-{date}-{sid}.md`
that `session_compactor.py` writes. Solves the user-stated problem:

    "quiero también principalmente, que todas las sesiones tengan un tipo
     de registro token friendly para que siempre te acuerdes de que hablamos,
     no recuperar sesión del todo, sino algo para decirte. Recuerdas cuando
     intentamos hacer estas mejoras? etc."

Two outputs:
  1. `~/.ultron-vault/50_SESSIONS_LOG/highlights/highlight-{date}-{sid}.md`
     (~250-400 tokens each — auto-indexed by brain_index for FTS5 search)
  2. `~/.ultron/.tmp/recent-highlights.json`
     (last N highlights primed for SessionStart context)

Usage:
    session_highlights.py extract <auto-md-path>     # extract one
    session_highlights.py extract-recent [--limit N] # extract latest N missing highlights
    session_highlights.py recall "topic"             # search highlights via brain_index FTS5
    session_highlights.py prime [--max N]            # write recent-highlights.json for SessionStart
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ultron_paths import VAULT_SESSIONS_LOG, BRAIN_INDEX_DB, TMP_DIR

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HIGHLIGHTS_DIR = VAULT_SESSIONS_LOG / "highlights"
RECENT_PRIMED  = TMP_DIR / "recent-highlights.json"

# Compactor file pattern: auto-YYYY-MM-DD-{sid8}.md
COMPACTOR_FILE_RE = re.compile(r"^auto-(\d{4}-\d{2}-\d{2})-([a-f0-9]{8})\.md$")


# ─── Parser: extract bullet sections from compactor markdown ──────────────────

SECTION_HEADERS = {
    "summary":     re.compile(r"^##\s+Summary\s*$", re.MULTILINE),
    "decisions":   re.compile(r"^##\s+Decisions\s*$", re.MULTILINE),
    "done":        re.compile(r"^##\s+(?:What got done|Done|Changes|Shipped)\s*$", re.MULTILINE | re.IGNORECASE),
    "patterns":    re.compile(r"^##\s+Patterns observed\s*$", re.MULTILINE),
    "open":        re.compile(r"^##\s+Open questions?\s*$", re.MULTILINE),
    "seeds":       re.compile(r"^##\s+Next[- ]session seeds?\s*$", re.MULTILINE),
}


def _extract_section(text: str, key: str) -> str:
    """Get the body of a `## Header` section. Returns text up to next `##` or EOF."""
    pat = SECTION_HEADERS.get(key)
    if not pat:
        return ""
    m = pat.search(text)
    if not m:
        return ""
    body_start = m.end()
    next_header = re.search(r"^##\s+\S", text[body_start:], re.MULTILINE)
    body_end = body_start + next_header.start() if next_header else len(text)
    return text[body_start:body_end].strip()


def _bullets(section: str, max_n: int = 5) -> list[str]:
    """Extract `- ...` bullet lines, strip emphasis markdown, cap to max_n."""
    bullets = []
    for line in section.splitlines():
        line = line.strip()
        if line.startswith("- "):
            text = line[2:].strip()
            # strip leading bold/emoji
            text = re.sub(r"^\*\*([^*]+)\*\*\s*[—-]\s*", r"\1: ", text)
            text = re.sub(r"^[🔁🆕✅❌⚠️📌🎯🚨]\s*", "", text)
            # truncate long bullets
            if len(text) > 200:
                text = text[:197] + "..."
            bullets.append(text)
            if len(bullets) >= max_n:
                break
    return bullets


def _topics(text: str, max_n: int = 8) -> list[str]:
    """Heuristic: extract Sprint/feature codes + key uppercase tokens for FTS5 indexing."""
    topics = set()
    for m in re.finditer(r"\b(?:Sprint|F\d+|FIX-\d+|OPS-\d+|SEC-\d+|ARCH-\d+|LRN-\d+|v\d+\.\d+)\b", text):
        topics.add(m.group(0))
    for m in re.finditer(r"\b([A-Z][A-Z_]{2,}[A-Z0-9])\b", text):
        token = m.group(1)
        if token not in {"AND", "THE", "FOR", "NOT", "BUT", "WAS"}:
            topics.add(token.lower().replace("_", "-"))
    return sorted(topics)[:max_n]


def make_highlight(compactor_md: Path) -> str:
    """Render a token-friendly highlight from a compactor output file."""
    text = compactor_md.read_text(encoding="utf-8")
    fname_match = COMPACTOR_FILE_RE.match(compactor_md.name)
    if not fname_match:
        date_str, sid = datetime.now().strftime("%Y-%m-%d"), "unknown"
    else:
        date_str, sid = fname_match.group(1), fname_match.group(2)

    summary  = _extract_section(text, "summary")
    # Cap summary to ~50 words
    summary_short = " ".join(summary.split()[:50])
    if summary != summary_short:
        summary_short += "..."

    decisions = _bullets(_extract_section(text, "decisions"), max_n=4)
    done      = _bullets(_extract_section(text, "done"),      max_n=4)
    open_q    = _bullets(_extract_section(text, "open"),      max_n=3)
    seeds     = _bullets(_extract_section(text, "seeds"),     max_n=3)

    topics = _topics(text, max_n=8)

    out = []
    out.append("---")
    out.append(f"name: highlight-{date_str}-{sid}")
    out.append(f"date: {date_str}")
    out.append(f"session_id: {sid}")
    out.append(f"type: session-highlight")
    out.append(f"source: auto-{date_str}-{sid}.md")
    out.append(f"topics: [{', '.join(topics)}]")
    out.append(f"tags: [highlight, recall]")
    out.append("---")
    out.append("")
    out.append(f"# Highlight {date_str} · {sid}")
    out.append("")
    out.append(f"**Resumen:** {summary_short or '(sin resumen)'}")
    out.append("")
    if decisions:
        out.append("## Decisiones")
        for b in decisions:
            out.append(f"- {b}")
        out.append("")
    if done:
        out.append("## Hecho")
        for b in done:
            out.append(f"- {b}")
        out.append("")
    if open_q:
        out.append("## Abierto")
        for b in open_q:
            out.append(f"- {b}")
        out.append("")
    if seeds:
        out.append("## Seeds próxima sesión")
        for b in seeds:
            out.append(f"- {b}")
        out.append("")
    out.append(f"_Fuente: [[auto-{date_str}-{sid}]]_")
    return "\n".join(out)


# ─── CLI ───────────────────────────────────────────────────────────────────────

def cmd_extract(args) -> int:
    src = Path(args.path)
    if not src.exists():
        print(f"[highlights] not found: {src}", file=sys.stderr)
        return 1
    HIGHLIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    fname_match = COMPACTOR_FILE_RE.match(src.name)
    if not fname_match:
        print(f"[highlights] not a compactor file: {src.name}", file=sys.stderr)
        return 1
    out_path = HIGHLIGHTS_DIR / f"highlight-{fname_match.group(1)}-{fname_match.group(2)}.md"
    out_path.write_text(make_highlight(src), encoding="utf-8")
    print(f"[highlights] wrote {out_path.relative_to(VAULT_SESSIONS_LOG.parent)}")
    return 0


def cmd_extract_recent(args) -> int:
    """Extract highlights for compactor files that don't yet have one."""
    HIGHLIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    sources = sorted(VAULT_SESSIONS_LOG.glob("auto-*.md"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    written, skipped = 0, 0
    for src in sources[: args.limit]:
        m = COMPACTOR_FILE_RE.match(src.name)
        if not m:
            continue
        out_path = HIGHLIGHTS_DIR / f"highlight-{m.group(1)}-{m.group(2)}.md"
        if out_path.exists() and out_path.stat().st_mtime >= src.stat().st_mtime:
            skipped += 1
            continue
        out_path.write_text(make_highlight(src), encoding="utf-8")
        written += 1
    print(f"[highlights] wrote={written} skipped={skipped} (latest {args.limit} compactor files)")
    return 0


def _sanitize_fts5(q: str) -> str:
    """Make user query FTS5-safe: split into tokens, drop punctuation, AND-join.

    FTS5 special chars (-, *, etc.) cause syntax errors. We drop them and
    match all remaining tokens (implicit AND semantics).
    """
    # Drop punctuation except internal letters/digits, lowercase, split
    cleaned = re.sub(r"[^\w\sáéíóúñ]", " ", q.lower())
    tokens = [t for t in cleaned.split() if len(t) >= 2]
    if not tokens:
        return q
    # Quote each token to be safe with reserved words
    return " ".join(f'"{t}"' for t in tokens)


def cmd_recall(args) -> int:
    """FTS5 search across highlights for a topic. Returns top N relevant."""
    if not BRAIN_INDEX_DB.exists():
        print("[highlights] brain_index.db missing — run brain_index.py update first",
              file=sys.stderr)
        return 1
    raw = args.query
    fts_q = _sanitize_fts5(raw)
    conn = sqlite3.connect(str(BRAIN_INDEX_DB))
    # Prefer highlights (token-friendly), fall back to compactor full output
    try:
        # First: highlights only
        rows = conn.execute("""
            SELECT n.path, n.title, snippet(notes_fts, 1, '«', '»', '...', 15)
              FROM notes_fts
              JOIN notes n ON n.id = notes_fts.rowid
             WHERE notes_fts MATCH ?
               AND n.path LIKE '%/highlights/%'
             ORDER BY rank
             LIMIT ?
        """, (fts_q, args.limit)).fetchall()
        # If nothing in highlights, fall back to all sessions log
        if not rows and not args.highlights_only:
            rows = conn.execute("""
                SELECT n.path, n.title, snippet(notes_fts, 1, '«', '»', '...', 15)
                  FROM notes_fts
                  JOIN notes n ON n.id = notes_fts.rowid
                 WHERE notes_fts MATCH ?
                   AND n.path LIKE '%/50_SESSIONS_LOG/%'
                 ORDER BY rank
                 LIMIT ?
            """, (fts_q, args.limit)).fetchall()
    except sqlite3.OperationalError as e:
        print(f"[recall] FTS5 error (query={fts_q!r}): {e}", file=sys.stderr)
        return 2
    finally:
        conn.close()
    if not rows:
        print(f"[recall] no session highlights match '{raw}' (fts_q={fts_q})")
        return 1
    print(f"[recall] {len(rows)} hit(s) for '{raw}':\n")
    for path, title, snippet in rows:
        rel = path.replace("\\", "/").rsplit("50_SESSIONS_LOG/", 1)[-1]
        print(f"  📌 {title or rel}")
        print(f"     {snippet}")
        print(f"     → {path}\n")
    return 0


def cmd_prime(args) -> int:
    """Write recent-highlights.json for SessionStart priming."""
    HIGHLIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(HIGHLIGHTS_DIR.glob("highlight-*.md"),
                   key=lambda p: p.stat().st_mtime, reverse=True)[: args.max]
    out = []
    for f in files:
        text = f.read_text(encoding="utf-8")
        m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", text, re.DOTALL)
        if not m:
            continue
        out.append({
            "file": f.name,
            "mtime": datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="seconds"),
            "preview": m.group(2)[:600],   # first ~600 chars of body
        })
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    RECENT_PRIMED.write_text(json.dumps(out, indent=2, ensure_ascii=False),
                             encoding="utf-8")
    print(f"[highlights] primed {len(out)} highlights → {RECENT_PRIMED}")
    return 0


def main():
    p = argparse.ArgumentParser(prog="session_highlights",
                                description="ULTRON v13.1 Session Highlights (token-friendly cross-session memory)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sx = sub.add_parser("extract", help="Extract one highlight from a compactor file")
    sx.add_argument("path")
    sx.set_defaults(func=cmd_extract)

    sr = sub.add_parser("extract-recent", help="Extract highlights for recent compactor files")
    sr.add_argument("--limit", type=int, default=10)
    sr.set_defaults(func=cmd_extract_recent)

    sc = sub.add_parser("recall", help='Search highlights via FTS5 ("Recuerdas cuando X?")')
    sc.add_argument("query")
    sc.add_argument("--limit", type=int, default=5)
    sc.add_argument("--highlights-only", action="store_true",
                    help="Don't fall back to full compactor files if no highlight matches")
    sc.set_defaults(func=cmd_recall)

    sp = sub.add_parser("prime", help="Write recent-highlights.json for SessionStart context")
    sp.add_argument("--max", type=int, default=5)
    sp.set_defaults(func=cmd_prime)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
