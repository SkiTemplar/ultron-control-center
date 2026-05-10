"""ULTRON v14.8 P5 — Cross-encoder re-ranking.

Adds a precision boost on top of the v14.6 hybrid retriever (BM25 + vector
RRF). The bi-encoder approach (sentence-transformers MPNet) is fast for
recall but loose on precision: it embeds query and document independently
into the same space, missing fine-grained query-document interactions.

A cross-encoder reads `[query, document]` JOINTLY through a transformer and
outputs a single relevance score. This is slow per-pair (~50ms warm) but
the hybrid retriever already narrowed the candidate set to ~20, so total
re-rank cost is ~1s — acceptable for explicit user queries via CLI but
NOT for async hooks (auto-recall stays bi-encoder only).

Default model: `cross-encoder/ms-marco-MiniLM-L-6-v2` (~80 MB, fast,
English-trained but still useful on the mixed ES/EN vault). Swap via
`ULTRON_CROSS_ENCODER_MODEL` env var. Multilingual alternatives:
`BAAI/bge-reranker-v2-m3` (~570 MB, SOTA multilingual) or
`cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` (~115 MB, multilingual).

CLI:
  cross_encoder.py rerank --query "<text>" --candidates <json-file>
  cross_encoder.py status     # model name + load smoke

The module is read-only; it does not mutate Qdrant, the vault, or any
state file. Reranking is a pure transformation of an in-memory list.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import warnings
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

# Silence sentence-transformers / transformers warnings — same approach as
# the auto-recall hook, since both modules import these libraries.
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)
os.environ.setdefault("PYTHONWARNINGS", "ignore")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")


CROSS_ENCODER_MODEL = os.environ.get(
    "ULTRON_CROSS_ENCODER_MODEL",
    "cross-encoder/ms-marco-MiniLM-L-6-v2",
)
DEFAULT_TOP_N = 5
MAX_DOC_CHARS = 1200  # cap per-doc text fed to the cross-encoder

_MODEL = None


def _get_model():
    """Load CrossEncoder lazily. Cached per-process."""
    global _MODEL
    if _MODEL is None:
        from sentence_transformers import CrossEncoder  # type: ignore
        _MODEL = CrossEncoder(CROSS_ENCODER_MODEL)
    return _MODEL


# ── Public API ────────────────────────────────────────────────────────────────


def rerank(
    query: str,
    candidates: list[dict[str, Any]],
    *,
    text_field: str = "snippet",
    top_n: int | None = None,
) -> list[dict[str, Any]]:
    """Re-rank `candidates` by cross-encoder score.

    Each candidate is expected to carry the original document text under
    `text_field` (default 'snippet'). Returns a NEW list (the input is not
    mutated) with each entry augmented with a `rerank_score` field, sorted
    descending by that score.

    `top_n` truncates the input BEFORE re-ranking (fewer pairs ↔ less
    cross-encoder work). Truncation is a CPU-only optimization, not a
    semantic filter — pass top_n=20 to rerank only the top-20 first-stage
    hits, or None to rerank everything.
    """
    if not candidates:
        return []

    if top_n is not None and top_n < len(candidates):
        candidates = candidates[:top_n]

    pairs: list[tuple[str, str]] = []
    for c in candidates:
        text = str(c.get(text_field) or "").strip()
        if len(text) > MAX_DOC_CHARS:
            text = text[:MAX_DOC_CHARS]
        pairs.append((query, text))

    model = _get_model()
    scores = model.predict(pairs, show_progress_bar=False)

    enriched: list[dict[str, Any]] = []
    for c, s in zip(candidates, scores):
        d = dict(c)
        d["rerank_score"] = float(s)
        enriched.append(d)

    enriched.sort(key=lambda x: -x["rerank_score"])
    return enriched


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_rerank(args: argparse.Namespace) -> int:
    if not args.query:
        print("ERROR: --query required", file=sys.stderr)
        return 2
    candidates_path = Path(args.candidates)
    if not candidates_path.exists():
        print(f"ERROR: candidates file not found: {candidates_path}", file=sys.stderr)
        return 2
    try:
        data = json.loads(candidates_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"ERROR: candidates file is not valid JSON: {exc}", file=sys.stderr)
        return 2
    if not isinstance(data, list):
        print("ERROR: candidates JSON must be a list of objects", file=sys.stderr)
        return 2
    started = time.perf_counter()
    out = rerank(args.query, data, text_field=args.text_field, top_n=args.top_n)
    elapsed = round((time.perf_counter() - started) * 1000, 1)
    payload = {
        "query": args.query,
        "model": CROSS_ENCODER_MODEL,
        "input_count": len(data),
        "output_count": len(out),
        "elapsed_ms": elapsed,
        "results": out,
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    payload: dict[str, Any] = {
        "model": CROSS_ENCODER_MODEL,
        "max_doc_chars": MAX_DOC_CHARS,
        "default_top_n": DEFAULT_TOP_N,
    }
    if args.smoke:
        try:
            t = time.perf_counter()
            scores = _get_model().predict([("hello", "world")])
            payload["smoke_ms"] = round((time.perf_counter() - t) * 1000, 1)
            payload["smoke_score"] = float(scores[0])
            payload["smoke_ok"] = True
        except Exception as exc:
            payload["smoke_ok"] = False
            payload["smoke_error"] = repr(exc)[:200]
    print(json.dumps(payload, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cross_encoder.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_r = sub.add_parser("rerank", help="re-rank candidates by cross-encoder score")
    p_r.add_argument("--query", required=True)
    p_r.add_argument("--candidates", required=True, help="path to JSON list of candidates")
    p_r.add_argument("--text-field", default="snippet",
                     help="key in each candidate that holds the document text")
    p_r.add_argument("--top-n", type=int, default=None,
                     help="truncate inputs to N before re-ranking")
    p_r.set_defaults(func=_cmd_rerank)

    p_s = sub.add_parser("status", help="model + smoke")
    p_s.add_argument("--smoke", action="store_true",
                     help="run a 1-pair predict to time cold load")
    p_s.set_defaults(func=_cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
