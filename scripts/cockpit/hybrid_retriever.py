"""ULTRON v14.6 PERFECT MEMORY — Phase 2 hybrid retriever.

Combines two ranked retrievers over the vault:
  * BM25 lexical search via the existing FTS5 brain_index (notes_fts)
  * Vector semantic search via Qdrant collection `ultron_vault`

Results are merged with Reciprocal Rank Fusion (RRF). Each retriever
contributes 1/(k + rank_i) to a document's score; the document with the
highest summed score wins. RRF is used because it's robust without per-
retriever score calibration — the rank order is what matters.

Reference: Cormack et al. 2009, "Reciprocal Rank Fusion outperforms Condorcet
and individual Rank Learning Methods", SIGIR 2009.

CLI:
  hybrid_retriever.py query "<text>" [--top N] [--mode hybrid|fts|vector]
  hybrid_retriever.py status                 # health of both backends

Default mode is `hybrid`. Set `--mode fts` to use only BM25 (no Qdrant), or
`--mode vector` to use only embeddings (skip FTS5). Useful for ablation.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ── Paths ──────────────────────────────────────────────────────────────────────


def _user_home() -> Path:
    return Path.home()


def _brain_db() -> Path:
    return _user_home() / ".ultron" / "brain_index" / "index.db"


def _telemetry_path() -> Path:
    return _user_home() / ".ultron" / "telemetry" / "recall-events.jsonl"


def _record_telemetry(query: str, mode: str, hits: list, latency_ms: float) -> None:
    """Append one JSONL event to recall-events.jsonl. Failures are silent."""
    try:
        path = _telemetry_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        scores = [round(float(h.score), 4) for h in hits]
        sources = []
        for h in hits:
            if h.fts_rank is not None and h.vector_rank is not None:
                sources.append("both")
            elif h.fts_rank is not None:
                sources.append("fts")
            elif h.vector_rank is not None:
                sources.append("vec")
            else:
                sources.append("?")
        event = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "query": query,
            "mode": mode,
            "hits": len(hits),
            "scores": scores,
            "sources": sources,
            "latency_ms": round(latency_ms, 1),
        }
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception:
        pass


# ── Constants ──────────────────────────────────────────────────────────────────

# RRF constant (Cormack et al. recommend 60 as the canonical default).
RRF_K = 60

# Per-retriever default depth. Hybrid pulls more candidates than the final
# top-N so RRF has more signal to work with.
RETRIEVER_DEPTH = 20

ValidMode = ("hybrid", "fts", "vector")


# ── Data shapes ────────────────────────────────────────────────────────────────


@dataclass
class HybridHit:
    path: str
    score: float            # composite RRF score
    fts_rank: int | None = None      # 1-based; None if not in FTS5 results
    vector_rank: int | None = None   # 1-based; None if not in Qdrant results
    fts_bm25: float | None = None
    vector_score: float | None = None
    snippet: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "score": round(self.score, 4),
            "fts_rank": self.fts_rank,
            "vector_rank": self.vector_rank,
            "fts_bm25": (round(self.fts_bm25, 3) if self.fts_bm25 is not None else None),
            "vector_score": (round(self.vector_score, 4) if self.vector_score is not None else None),
            "snippet": self.snippet,
        }


# ── BM25 retriever (FTS5 via brain_index.db) ───────────────────────────────────


def fts_search(query: str, *, top: int = RETRIEVER_DEPTH) -> list[dict[str, Any]]:
    """Run an FTS5 BM25 query against brain_index.db. Returns ranked rows.

    Each row: {path, rank (1-based), bm25, snippet}. Empty list if the index
    is missing or the query has no matches.
    """
    db = _brain_db()
    if not db.exists():
        return []
    sql = (
        "SELECT notes.path, snippet(notes_fts, 1, '«', '»', '…', 12) AS snippet, "
        "bm25(notes_fts) AS rank "
        "FROM notes_fts JOIN notes ON notes_fts.rowid = notes.id "
        "WHERE notes_fts MATCH ? "
        "ORDER BY rank LIMIT ?"
    )
    try:
        with sqlite3.connect(str(db)) as conn:
            rows = conn.execute(sql, (query, top)).fetchall()
    except sqlite3.OperationalError:
        return []
    out: list[dict[str, Any]] = []
    for i, r in enumerate(rows, 1):
        out.append({
            "path": r[0],
            "snippet": r[1] or "",
            "bm25": float(r[2]),
            "rank": i,
        })
    return out


# ── Vector retriever (Qdrant via embed_vault) ──────────────────────────────────


def vector_search(query: str, *, top: int = RETRIEVER_DEPTH) -> list[dict[str, Any]]:
    """Run a semantic query through embed_vault.query_top.

    Lazy import so the module loads cheaply when only --mode fts is requested.
    """
    sys.path.insert(0, str(Path(__file__).parent))
    try:
        import embed_vault  # type: ignore
    except Exception:
        return []
    try:
        rows = embed_vault.query_top(query, top_n=top)
    except Exception:
        return []
    out = []
    for i, r in enumerate(rows, 1):
        out.append({
            "path": r.get("path", ""),
            "snippet": r.get("preview", ""),
            "vector_score": float(r.get("score", 0.0)),
            "rank": i,
        })
    return out


# ── Reciprocal Rank Fusion ─────────────────────────────────────────────────────


def reciprocal_rank_fusion(
    fts_rows: list[dict[str, Any]],
    vector_rows: list[dict[str, Any]],
    *,
    k: int = RRF_K,
) -> list[HybridHit]:
    """Merge two ranked lists via RRF. Document identity = path string.

    Returns hits sorted by composite RRF score descending.
    """
    by_path: dict[str, HybridHit] = {}

    for row in fts_rows:
        path = row["path"]
        if not path:
            continue
        rrf_inc = 1.0 / (k + row["rank"])
        hit = by_path.setdefault(path, HybridHit(path=path, score=0.0))
        hit.score += rrf_inc
        hit.fts_rank = row["rank"]
        hit.fts_bm25 = row.get("bm25")
        if not hit.snippet:
            hit.snippet = row.get("snippet", "")

    for row in vector_rows:
        path = row["path"]
        if not path:
            continue
        rrf_inc = 1.0 / (k + row["rank"])
        hit = by_path.setdefault(path, HybridHit(path=path, score=0.0))
        hit.score += rrf_inc
        hit.vector_rank = row["rank"]
        hit.vector_score = row.get("vector_score")
        if not hit.snippet:
            hit.snippet = row.get("snippet", "")

    return sorted(by_path.values(), key=lambda h: -h.score)


# ── Public API ─────────────────────────────────────────────────────────────────


def _maybe_rerank(
    text: str, hits: list[HybridHit], *, enabled: bool, depth: int,
) -> list[HybridHit]:
    """Apply cross-encoder re-ranking to hits. No-op when `enabled` is
    False, when fewer than 2 hits exist, or when import fails.

    Returns a new list sorted by the new score; original list is not
    mutated. The ce score is stamped into HybridHit.score and a parallel
    `rerank_score` attribute is attached for transparency.
    """
    if not enabled or len(hits) < 2:
        return hits
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        import cross_encoder  # type: ignore
    except Exception:
        return hits
    candidates = [
        {"_idx": i, "snippet": h.snippet or h.path, "path": h.path}
        for i, h in enumerate(hits[:depth])
    ]
    try:
        reranked = cross_encoder.rerank(text, candidates, text_field="snippet")
    except Exception:
        return hits
    out: list[HybridHit] = []
    for r in reranked:
        idx = r.get("_idx")
        if idx is None or idx >= len(hits):
            continue
        h = hits[idx]
        # Stamp the rerank score onto the hit so the CLI can show both.
        new_hit = HybridHit(
            path=h.path, score=float(r.get("rerank_score", h.score)),
            fts_rank=h.fts_rank, vector_rank=h.vector_rank,
            fts_bm25=h.fts_bm25, vector_score=h.vector_score, snippet=h.snippet,
        )
        out.append(new_hit)
    return out


def hybrid_query(
    text: str,
    *,
    mode: str = "hybrid",
    top: int = 5,
    depth: int = RETRIEVER_DEPTH,
    rerank: bool = False,
) -> list[HybridHit]:
    """Run a query in the chosen mode and return the top-N hits.

    mode='hybrid': BM25 + vector + RRF (default)
    mode='fts':    BM25 only
    mode='vector': Qdrant only
    rerank=True:   apply cross-encoder reranking to the candidate set
                   BEFORE truncating to `top`. Adds ~50ms per candidate
                   (see scripts/cockpit/cross_encoder.py).
    """
    if mode not in ValidMode:
        raise ValueError(f"mode must be one of {ValidMode}, got {mode!r}")

    if mode == "fts":
        rows = fts_search(text, top=depth)
        first_stage = [
            HybridHit(
                path=r["path"], score=1.0 / (RRF_K + r["rank"]),
                fts_rank=r["rank"], fts_bm25=r.get("bm25"), snippet=r.get("snippet", ""),
            )
            for r in rows
        ]
        first_stage = _maybe_rerank(text, first_stage, enabled=rerank, depth=depth)
        return first_stage[:top]
    if mode == "vector":
        rows = vector_search(text, top=depth)
        first_stage = [
            HybridHit(
                path=r["path"], score=1.0 / (RRF_K + r["rank"]),
                vector_rank=r["rank"], vector_score=r.get("vector_score"),
                snippet=r.get("snippet", ""),
            )
            for r in rows
        ]
        first_stage = _maybe_rerank(text, first_stage, enabled=rerank, depth=depth)
        return first_stage[:top]

    # mode == "hybrid"
    fts_rows = fts_search(text, top=depth)
    vec_rows = vector_search(text, top=depth)
    fused = reciprocal_rank_fusion(fts_rows, vec_rows)
    fused = _maybe_rerank(text, fused, enabled=rerank, depth=depth)
    return fused[:top]


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_query(args: argparse.Namespace) -> int:
    t0 = time.perf_counter()
    hits = hybrid_query(args.text, mode=args.mode, top=args.top, rerank=args.rerank)
    latency_ms = (time.perf_counter() - t0) * 1000
    if not getattr(args, "no_telemetry", False):
        _record_telemetry(args.text, args.mode, hits, latency_ms)
    if getattr(args, "format", "json") == "human":
        return _print_human(args.text, args.mode, hits)
    payload = {
        "query": args.text,
        "mode": args.mode,
        "matches": len(hits),
        "results": [h.to_dict() for h in hits],
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


def _short_path(path: str) -> str:
    """Trim home prefix and noisy intermediate dirs for a compact display."""
    if not path:
        return ""
    home = str(Path.home())
    if path.startswith(home):
        path = "~" + path[len(home):]
    return path.replace("\\", "/")


def _print_human(query: str, mode: str, hits: list[HybridHit]) -> int:
    """Print results as a compact, human-readable table (no JSON)."""
    if not hits:
        print(f"[recall] no matches for {query!r} (mode={mode})")
        return 0
    print(f"[recall · mode={mode}] {len(hits)} hit(s) for {query!r}\n")
    for i, h in enumerate(hits, 1):
        # Source signal: where did this hit come from?
        src_bits = []
        if h.fts_rank is not None:
            src_bits.append(f"fts#{h.fts_rank}")
        if h.vector_rank is not None:
            src_bits.append(f"vec#{h.vector_rank}")
        src = "·".join(src_bits) if src_bits else "?"
        snippet = (h.snippet or "").replace("\n", " ").strip()[:120]
        if snippet.startswith("---"):
            snippet = snippet.lstrip("- ").strip()[:120]
        print(f"  {i}. score={h.score:.4f}  [{src}]  {_short_path(h.path)}")
        if snippet:
            print(f"     › {snippet}")
        print()
    return 0


def _cmd_stats(args: argparse.Namespace) -> int:
    """Aggregate recall-events.jsonl over the last N days."""
    from collections import Counter
    from datetime import timedelta

    path = _telemetry_path()
    if not path.exists():
        print(f"[recall stats] {path} not found — no events yet")
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    events: list[dict] = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not raw.strip():
            continue
        try:
            ev = json.loads(raw)
            ts = datetime.fromisoformat(ev.get("ts", ""))
            if ts >= cutoff:
                events.append(ev)
        except (json.JSONDecodeError, ValueError):
            continue

    if not events:
        print(f"[recall stats] no events in last {args.days}d")
        return 0

    total = len(events)
    with_hits = sum(1 for e in events if e.get("hits", 0) > 0)
    hit_rate = with_hits / total
    by_mode = Counter(e.get("mode", "?") for e in events)
    all_scores = [s for e in events for s in (e.get("scores") or [])]
    avg_score = (sum(all_scores) / len(all_scores)) if all_scores else 0.0
    all_sources = [s for e in events for s in (e.get("sources") or [])]
    by_source = Counter(all_sources)
    avg_latency = sum(e.get("latency_ms", 0) for e in events) / total
    top_q = Counter(e.get("query", "?") for e in events).most_common(args.top_queries)

    print(f"[recall stats] window={args.days}d · events={total}")
    print(f"  hit_rate           {hit_rate:.1%}  ({with_hits}/{total})")
    print(f"  avg_score          {avg_score:.4f}")
    print(f"  avg_latency_ms     {avg_latency:.0f}")
    print(f"  by_mode            " + ", ".join(f"{m}={c}" for m, c in by_mode.most_common()))
    print(f"  by_source          " + ", ".join(f"{s}={c}" for s, c in by_source.most_common()))
    print(f"  top_queries (top {args.top_queries}):")
    for q, c in top_q:
        q_short = q if len(q) <= 60 else q[:57] + "..."
        print(f"    {c}× {q_short}")
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    payload: dict[str, Any] = {
        "fts_db": str(_brain_db()),
        "fts_db_exists": _brain_db().exists(),
        "rrf_k": RRF_K,
        "retriever_depth": RETRIEVER_DEPTH,
    }
    sys.path.insert(0, str(Path(__file__).parent))
    try:
        import embed_vault  # type: ignore
        client = embed_vault._get_qdrant()
        cols = {c.name for c in client.get_collections().collections}
        payload["qdrant_url"] = embed_vault.QDRANT_URL
        payload["qdrant_collection"] = embed_vault.COLLECTION
        payload["qdrant_collection_exists"] = embed_vault.COLLECTION in cols
        if embed_vault.COLLECTION in cols:
            info = client.get_collection(embed_vault.COLLECTION)
            payload["qdrant_points"] = info.points_count
    except Exception as exc:
        payload["qdrant_error"] = repr(exc)
    print(json.dumps(payload, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="hybrid_retriever.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_q = sub.add_parser("query", help="run a hybrid / fts / vector query")
    p_q.add_argument("text")
    p_q.add_argument("--mode", choices=ValidMode, default="hybrid")
    p_q.add_argument("--top", type=int, default=5)
    p_q.add_argument("--rerank", action="store_true",
                     help="apply cross-encoder re-rank before truncating to --top")
    p_q.add_argument("--format", choices=("json", "human"), default="json",
                     help="output format (default json; 'human' for interactive use)")
    p_q.add_argument("--no-telemetry", action="store_true", dest="no_telemetry",
                     help="skip writing recall-events.jsonl entry")
    p_q.set_defaults(func=_cmd_query)

    p_stats = sub.add_parser("stats", help="aggregate telemetry from recall-events.jsonl")
    p_stats.add_argument("--days", type=int, default=14, help="window in days (default 14)")
    p_stats.add_argument("--top-queries", type=int, default=5, dest="top_queries")
    p_stats.set_defaults(func=_cmd_stats)

    p_s = sub.add_parser("status", help="health of both retrievers")
    p_s.set_defaults(func=_cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
