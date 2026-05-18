"""Context packet builder for ULTRON intent dispatcher (S3-B).

Queries chunks_fts in brain_index/index.db and returns a single formatted
string for injection into Claude's context.

Public API:
    build(query, layer, max_tokens, index_path, budget_left_ms_fn) -> str

Returns format:
    [CTX·{layer}·{domain}·{tokens}tok] {content}

Returns empty string on any failure (fail-soft contract).

Direct sqlite3 against index.db using the same read-only URI + progress
handler pattern as intent-dispatcher.py _query_chunks_fts (Codex S2-B C1).
Never spawns subprocesses.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Callable

# ── Default path ─────────────────────────────────────────────────────────────
_DEFAULT_INDEX = Path.home() / ".ultron" / "brain_index" / "index.db"

# ── Layer mapping ─────────────────────────────────────────────────────────────
# Maps the public `layer` parameter to a WHERE clause fragment.
# "L1" → any chunk whose layer starts with "L1-"
# "L2" → exact "L2-vault"
_LAYER_PATTERNS: dict[str, tuple[str, bool]] = {
    "L1":            ("L1-%", True),   # (pattern, use_LIKE)
    "L1-projects":   ("L1-projects", False),
    "L1-decisions":  ("L1-decisions", False),
    "L2":            ("L2-vault", False),
    "L2-vault":      ("L2-vault", False),
}


def _layer_where(layer: str) -> tuple[str, str]:
    """Return (sql_fragment, value) for the given layer param."""
    if layer in _LAYER_PATTERNS:
        pattern, use_like = _LAYER_PATTERNS[layer]
        if use_like:
            return ("cf.layer LIKE ?", pattern)
        else:
            return ("cf.layer = ?", pattern)
    # Default: exact match on whatever was passed.
    return ("cf.layer = ?", layer)


def _dominant_domain(rows: list[dict]) -> str:
    """Return the most common domain value from the result rows."""
    if not rows:
        return "—"
    counts: dict[str, int] = {}
    for row in rows:
        domain = row.get("domain") or row.get("category") or ""
        # Derive from note_path if no explicit domain/category.
        if not domain:
            path = row.get("note_path", "")
            # e.g. "L1/projects-active.md" → "projects"
            parts = Path(path).stem.split("-")
            domain = parts[0] if parts else "—"
        counts[domain] = counts.get(domain, 0) + 1
    return max(counts, key=lambda k: counts[k]) or "—"


def build(
    query: str,
    layer: str = "L1",
    max_tokens: int = 300,  # v15.5.20: was 600, aligned with the only real caller (intent-dispatcher line 588)
    index_path: Path | None = None,
    budget_left_ms_fn: Callable[[], float] | None = None,
) -> str:
    """Build a context packet for *query* from *layer*.

    Returns a single string formatted as:
        [CTX·{layer}·{domain}·{tokens}tok] {content}

    Returns empty string if:
    - chunks_fts table unavailable or index missing
    - no results for query
    - budget_left_ms_fn returns < 5ms
    - any internal exception (fail-soft)
    """
    try:
        return _build_unsafe(query, layer, max_tokens, index_path, budget_left_ms_fn)
    except Exception:
        return ""


def _build_unsafe(
    query: str,
    layer: str,
    max_tokens: int,
    index_path: Path | None,
    budget_left_ms_fn: Callable[[], float] | None,
) -> str:
    """Inner implementation — may raise. Callers must catch."""
    # Budget guard.
    if budget_left_ms_fn is not None and budget_left_ms_fn() < 5:
        return ""

    db_path = index_path or _DEFAULT_INDEX
    if not db_path.exists():
        return ""

    # Query brain_index chunks_fts with layer filter.
    rows = _query_chunks(query, layer, db_path, budget_left_ms_fn, top=8)
    if not rows:
        return ""

    # Budget guard after DB query.
    if budget_left_ms_fn is not None and budget_left_ms_fn() < 2:
        return ""

    # Assemble content from top-K snippets.
    # Import token_budget from same cockpit directory (lazy, local).
    # Codex S3 C1 fix: log() removed from the hot-path entirely. The dispatcher
    # invokes this on every prompt; synchronous JSONL disk I/O after each
    # successful build is unbounded (slow disks, AV scanners, etc.). Telemetry
    # is the dispatcher's responsibility — log() can still be called by other
    # callers (generate_L0, manual builds), just not on the live UserPromptSubmit
    # path.
    _cockpit = Path(__file__).parent
    if str(_cockpit) not in sys.path:
        sys.path.insert(0, str(_cockpit))
    from token_budget import enforce, measure  # noqa: PLC0415

    parts: list[str] = []
    for row in rows:
        snippet = (row.get("snippet") or "").strip()
        if snippet:
            parts.append(snippet)

    raw_content = "\n\n".join(parts)
    if not raw_content:
        return ""

    # Codex S3 C1 fix: budget guard between enforce (potentially expensive on
    # very long content) and the final emit. If we're already over budget,
    # bail out rather than emit a possibly-stale packet.
    if budget_left_ms_fn is not None and budget_left_ms_fn() < 2:
        return ""

    content = enforce(raw_content, max_tokens)

    # Codex S3 H1 fix: sanitize newlines so the packet is exactly ONE line of
    # stdout. The dispatcher contract is "routing_line\n[CTX...]\n" — embedded
    # newlines would inject phantom lines into Claude's context. Collapse
    # whitespace runs while we're at it to keep the line readable.
    content = " ".join(content.split())

    actual_tokens = measure(content)
    if actual_tokens == 0:
        return ""

    # Final budget guard: if we ran out of time during enforce/sanitize, drop
    # the packet rather than risk pushing past the dispatcher's 40ms cap.
    if budget_left_ms_fn is not None and budget_left_ms_fn() < 1:
        return ""

    domain = _dominant_domain(rows)
    header = f"[CTX·{layer}·{domain}·{actual_tokens}tok]"
    return f"{header} {content}"


def _query_chunks(
    query: str,
    layer: str,
    db_path: Path,
    budget_left_ms_fn: Callable[[], float] | None,
    top: int = 8,
) -> list[dict]:
    """Direct SQLite query against chunks_fts, filtered by layer.

    Same read-only URI + progress handler + timeout=0 pattern as
    intent-dispatcher.py _query_chunks_fts (Codex S2-B C1 critical fix).
    """
    if budget_left_ms_fn is not None and budget_left_ms_fn() < 5:
        return []

    try:
        where_fragment, layer_value = _layer_where(layer)
        uri = f"file:{db_path.as_posix()}?mode=ro&immutable=1"
        conn = sqlite3.connect(uri, uri=True, timeout=0)
        try:
            if budget_left_ms_fn is not None:
                def _progress() -> int:
                    try:
                        return 1 if budget_left_ms_fn() < 2 else 0
                    except BaseException:
                        return 0
                conn.set_progress_handler(_progress, 1000)

            sql = (
                "SELECT n.path, cf.chunk_idx, cf.token_est, "
                "snippet(chunks_fts, 0, ?, ?, ?, 15) AS snippet, "
                "bm25(chunks_fts) AS bm25_score, "
                "cf.layer, cf.category, cf.domain "
                "FROM chunks_fts cf "
                "JOIN notes n ON n.id = cf.note_id "
                f"WHERE chunks_fts MATCH ? AND {where_fragment} "
                "ORDER BY bm25_score LIMIT ?"
            )
            rows = conn.execute(
                sql, ("«", "»", "…", query, layer_value, top)
            ).fetchall()
        finally:
            conn.close()
    except Exception:
        return []

    return [
        {
            "note_path": r[0],
            "chunk_idx": r[1],
            "token_est": r[2],
            "snippet": r[3] or "",
            "bm25": r[4],
            "layer": r[5] or "",
            "category": r[6] or "",
            "domain": r[7] or "",
        }
        for r in rows
    ]
