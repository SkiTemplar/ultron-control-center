"""ULTRON v15.3.5 — Agent auto-suggest helper (core wiring).

Bridges the agents catalog (`~/.claude/agents/*.md`) with the runtime hooks
(`intent-dispatcher.py`, `auto-recall.py`) so a normal Claude Code session
auto-surfaces matching subagents — same way skills are surfaced.

Two retrieval paths:

  1. FTS5 (fast, sync-safe)   → for the UserPromptSubmit hot path (<40ms).
     Reads from the dedicated `agents_fts` table in brain_index/index.db.
     Pure stdlib (sqlite3) — no Qdrant, no embeddings, no I/O outside the
     SQLite file. Returns BM25-ranked agent names + descriptions.

  2. Qdrant (semantic)         → for the async auto-recall path.
     Lazy-imports embed_agents.query_agents — same vector space as the rest
     of ULTRON's Qdrant fleet. Higher precision on natural-language
     paraphrases ("revisa el código de seguridad" → security-auditor) but
     costs ~50-100ms warm and requires Qdrant up.

Both return a normalised dict shape:
  {"name": str, "score": float in [0,1], "description": str, "path": str}

Feature gate:
  ~/.ultron/cockpit/features.json → "agent_auto_suggest": true|false
  (default: true if file missing or key missing — opt-out, not opt-in).

Threshold gate:
  ~/.ultron/cockpit/features.json → "agent_auto_suggest_threshold": float
  (default: 0.60 — matches Skill auto-suggest threshold used in auto-recall).
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

_BRAIN_DB = Path.home() / ".ultron" / "brain_index" / "index.db"
_FEATURES_PATH = Path.home() / ".ultron" / "cockpit" / "features.json"
_FEATURES_EXAMPLE_PATH = Path.home() / ".ultron" / "cockpit" / "features.example.json"

# Defaults match features.example.json. Used when features.json is missing
# or unreadable so the feature stays on by default (opt-out semantics).
DEFAULT_ENABLED = True
DEFAULT_THRESHOLD = 0.60
DEFAULT_TOP_N = 3


# ── Feature gate ──────────────────────────────────────────────────────────────

_features_cache: dict[str, Any] = {}


def _load_features() -> dict[str, Any]:
    """Read features.json (fallback to features.example.json). Cached by mtime."""
    for path in (_FEATURES_PATH, _FEATURES_EXAMPLE_PATH):
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if (
            _features_cache.get("path") == str(path)
            and _features_cache.get("mtime") == mtime
        ):
            return _features_cache.get("data", {})
        try:
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        _features_cache["path"] = str(path)
        _features_cache["mtime"] = mtime
        _features_cache["data"] = data if isinstance(data, dict) else {}
        return _features_cache["data"]
    return {}


def is_enabled() -> bool:
    """True when agent auto-suggest is on. Opt-out: default True."""
    return bool(_load_features().get("agent_auto_suggest", DEFAULT_ENABLED))


def threshold() -> float:
    try:
        return float(_load_features().get(
            "agent_auto_suggest_threshold", DEFAULT_THRESHOLD,
        ))
    except (TypeError, ValueError):
        return DEFAULT_THRESHOLD


def top_n() -> int:
    try:
        return int(_load_features().get(
            "agent_auto_suggest_top_n", DEFAULT_TOP_N,
        ))
    except (TypeError, ValueError):
        return DEFAULT_TOP_N


# ── FTS5 fast path (sync-safe, <5ms typical) ─────────────────────────────────

_FTS5_SAFE_RE = re.compile(r"[^\w\sÀ-ɏ]", re.UNICODE)
# FTS5 reserved keywords. If a stripped token matches one of these
# case-insensitively, FTS5 will treat it as an operator (AND/OR/NOT/NEAR)
# instead of a search term, which can lead to surprising results or syntax
# errors. We drop them defensively.
_FTS5_RESERVED = frozenset({"AND", "OR", "NOT", "NEAR"})
# Short tokens (1-2 chars) and common stopwords add noise to OR queries
# without contributing real signal — drop them so BM25 ranks on the
# content-bearing words.
_STOPWORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "of", "to", "for", "in", "on",
    "and", "or", "but", "with", "this", "that", "it", "be", "by", "at",
    "as", "from", "my", "me", "i", "you", "your",
    # Spanish equivalents
    "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del",
    "en", "y", "o", "pero", "con", "este", "esta", "esto", "ese", "esa",
    "para", "por", "que", "qué", "como", "cómo", "muy", "yo", "mi", "tu",
    "tú", "su", "le", "lo", "al", "se",
})


def _fts5_safe(text: str) -> str:
    """Strip FTS5 syntax chars and turn the query into an OR'd token list.

    Agents have short descriptions (~30-80 words) so an implicit AND across
    every prompt token misses real matches — e.g. `audit security OWASP
    vulnerabilities` needs all four words in one agent's description, which
    rarely happens. We OR the tokens to maximise recall, then let BM25 do
    the precision ranking.

    Side effects:
      * Strips FTS5 reserved keywords (AND/OR/NOT/NEAR) and stopwords.
      * Lowercases tokens (FTS5 unicode61 tokenizer is case-insensitive,
        but lowercasing makes the OR'd query string easier to reason about
        in logs).
      * Returns "" when no tokens survive — caller must treat as no-op.
    """
    cleaned = _FTS5_SAFE_RE.sub(" ", text)
    tokens: list[str] = []
    for raw in cleaned.split():
        tok = raw.strip().lower()
        if len(tok) < 3:
            continue
        if tok.upper() in _FTS5_RESERVED:
            continue
        if tok in _STOPWORDS:
            continue
        tokens.append(tok)
    if not tokens:
        return ""
    return " OR ".join(tokens)


def _bm25_to_confidence(bm25_score: float) -> float:
    """Negative BM25 → [0,1] for the agents catalog.

    Calibration is agent-specific: BM25 over short YAML descriptions yields
    much weaker absolute scores than chunks_fts (notes are 200-300 words;
    agent descriptions are ~30-80). Empirically, agent matches land in
    [-3.0, -0.3] for relevant queries — we clamp to [-3.0, 0] so a -2.5 score
    becomes ~0.83 confidence (clearly above the 0.60 gate).

    Compare with intent-dispatcher._bm25_to_confidence which uses [-25, 0]
    for chunks_fts (long, dense note content).
    """
    clamped = max(-3.0, min(0.0, bm25_score))
    return abs(clamped) / 3.0


def query_agents_fts(
    prompt: str,
    *,
    top: int | None = None,
    min_confidence: float | None = None,
    budget_left_ms_fn=None,
) -> list[dict[str, Any]]:
    """BM25 query against the `agents_fts` table. Empty list on any failure.

    Hard-bounded by an optional budget closure (intent-dispatcher passes its
    own). Read-only + immutable SQLite open so a writer never blocks us.
    """
    if not _BRAIN_DB.exists():
        return []
    if budget_left_ms_fn is not None and budget_left_ms_fn() < 5:
        return []
    limit = top if top is not None else top_n()
    threshold_v = min_confidence if min_confidence is not None else threshold()
    safe = _fts5_safe(prompt)
    if not safe:
        return []
    try:
        uri = f"file:{_BRAIN_DB.as_posix()}?mode=ro&immutable=1"
        conn = sqlite3.connect(uri, uri=True, timeout=0)
        try:
            if budget_left_ms_fn is not None:
                def _progress() -> int:
                    try:
                        return 1 if budget_left_ms_fn() < 2 else 0
                    except BaseException:
                        return 0
                conn.set_progress_handler(_progress, 1000)
            try:
                rows = conn.execute(
                    "SELECT name, snippet(agents_fts, 1, '', '', '…', 12) AS snip, "
                    "bm25(agents_fts) AS rank, path "
                    "FROM agents_fts WHERE agents_fts MATCH ? "
                    "ORDER BY rank LIMIT ?",
                    (safe, limit),
                ).fetchall()
            except sqlite3.OperationalError:
                # agents_fts table absent — brain_index not yet rebuilt with
                # the agents schema. Silent fallthrough; caller stays no-op.
                return []
        finally:
            conn.close()
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        name, snippet, bm25, path = r[0], r[1] or "", r[2], r[3] or ""
        conf = _bm25_to_confidence(bm25)
        if conf < threshold_v:
            continue
        out.append({
            "name": name,
            "score": round(conf, 4),
            "description": snippet,
            "path": path,
            "source": "fts",
        })
    return out


# ── Qdrant semantic path (async, lazy) ───────────────────────────────────────

def query_agents_semantic(
    prompt: str,
    *,
    top: int | None = None,
    min_confidence: float | None = None,
) -> list[dict[str, Any]]:
    """Semantic Qdrant match via embed_agents.query_agents. Empty on failure."""
    limit = top if top is not None else top_n()
    threshold_v = min_confidence if min_confidence is not None else threshold()
    try:
        # Lazy: ~250ms import on cold start. Caller controls when to pay.
        _here = str(Path(__file__).resolve().parent)
        if _here not in sys.path:
            sys.path.insert(0, _here)
        import embed_agents  # type: ignore
        rows = embed_agents.query_agents(prompt, top_n=limit)
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        score = float(r.get("score", 0.0) or 0.0)
        if score < threshold_v:
            continue
        out.append({
            "name": r.get("name", ""),
            "score": round(score, 4),
            "description": (r.get("description") or "")[:200],
            "path": r.get("path", ""),
            "source": "qdrant",
        })
    return out


# ── Unified suggestion API ───────────────────────────────────────────────────

def suggest_agents(
    prompt: str,
    *,
    prefer: str = "fts",
    top: int | None = None,
    min_confidence: float | None = None,
    budget_left_ms_fn=None,
) -> list[dict[str, Any]]:
    """Best-effort suggestion. Honours feature gate.

    prefer='fts'    → cheap, sync-safe (intent-dispatcher hot path).
    prefer='qdrant' → semantic, async (auto-recall).

    On failure of the preferred path, falls back to the other when budget
    permits. Returns at most `top` hits sorted by score desc.
    """
    if not is_enabled():
        return []
    if not prompt or not prompt.strip():
        return []
    hits: list[dict[str, Any]] = []
    if prefer == "qdrant":
        hits = query_agents_semantic(prompt, top=top, min_confidence=min_confidence)
        if not hits:
            hits = query_agents_fts(
                prompt, top=top, min_confidence=min_confidence,
                budget_left_ms_fn=budget_left_ms_fn,
            )
    else:
        hits = query_agents_fts(
            prompt, top=top, min_confidence=min_confidence,
            budget_left_ms_fn=budget_left_ms_fn,
        )
        if not hits:
            hits = query_agents_semantic(
                prompt, top=top, min_confidence=min_confidence,
            )
    hits.sort(key=lambda h: -h.get("score", 0.0))
    cap = top if top is not None else top_n()
    return hits[:cap]


# ── CLI for manual testing ───────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    import argparse
    parser = argparse.ArgumentParser(
        prog="agent_suggest.py",
        description="Surface agents matching a prompt (FTS5 or Qdrant).",
    )
    parser.add_argument("prompt", help="prompt text to match against agents")
    parser.add_argument("--mode", choices=("fts", "qdrant", "auto"), default="auto",
                        help="retrieval mode (default: auto = fts then qdrant)")
    parser.add_argument("--top", type=int, default=None)
    parser.add_argument("--min-confidence", type=float, default=None,
                        dest="min_confidence")
    args = parser.parse_args(argv)
    if args.mode == "fts":
        hits = query_agents_fts(args.prompt, top=args.top,
                                 min_confidence=args.min_confidence)
    elif args.mode == "qdrant":
        hits = query_agents_semantic(args.prompt, top=args.top,
                                      min_confidence=args.min_confidence)
    else:
        hits = suggest_agents(args.prompt, top=args.top,
                               min_confidence=args.min_confidence)
    print(json.dumps({
        "prompt": args.prompt,
        "mode": args.mode,
        "enabled": is_enabled(),
        "threshold": threshold(),
        "matches": len(hits),
        "results": hits,
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
