"""Pytest suite for ULTRON v14.8 P5 — cross_encoder.py + rerank integration.

Tests the static surface and the rerank() pure function on mocked candidates.
The actual model load (~80 MB ONNX cross-encoder) is NOT exercised — that's
verified manually via `cross_encoder.py status --smoke`.
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest


COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))


def _reimport(name: str):
    if name in sys.modules:
        del sys.modules[name]
    return importlib.import_module(name)


# ── cross_encoder pure surface ────────────────────────────────────────────────


class TestCrossEncoderRerank:

    def test_rerank_empty_returns_empty(self):
        ce = _reimport("cross_encoder")
        assert ce.rerank("any query", []) == []

    def test_rerank_uses_text_field_arg(self, monkeypatch):
        ce = _reimport("cross_encoder")

        captured_pairs = []

        class FakeModel:
            def predict(self, pairs, show_progress_bar=False):
                captured_pairs.extend(pairs)
                return [0.5, -0.2, 0.9]

        monkeypatch.setattr(ce, "_get_model", lambda: FakeModel())

        cands = [
            {"description": "alpha"},
            {"description": "beta"},
            {"description": "gamma"},
        ]
        out = ce.rerank("hello", cands, text_field="description")
        # Order by descending score: gamma (0.9), alpha (0.5), beta (-0.2)
        assert [c["description"] for c in out] == ["gamma", "alpha", "beta"]
        # Pairs were built with the right query + text_field
        assert captured_pairs == [
            ("hello", "alpha"), ("hello", "beta"), ("hello", "gamma"),
        ]

    def test_rerank_truncates_to_top_n_before_predict(self, monkeypatch):
        ce = _reimport("cross_encoder")

        seen_count = []

        class FakeModel:
            def predict(self, pairs, show_progress_bar=False):
                seen_count.append(len(pairs))
                return [0.0] * len(pairs)

        monkeypatch.setattr(ce, "_get_model", lambda: FakeModel())

        cands = [{"snippet": f"doc-{i}"} for i in range(20)]
        out = ce.rerank("q", cands, top_n=5)
        assert seen_count == [5]
        assert len(out) == 5

    def test_rerank_preserves_other_fields(self, monkeypatch):
        ce = _reimport("cross_encoder")

        class FakeModel:
            def predict(self, pairs, show_progress_bar=False):
                return [0.7]

        monkeypatch.setattr(ce, "_get_model", lambda: FakeModel())

        cands = [{"snippet": "x", "path": "/p", "extra": "keep me"}]
        out = ce.rerank("q", cands)
        assert out[0]["path"] == "/p"
        assert out[0]["extra"] == "keep me"
        assert out[0]["rerank_score"] == pytest.approx(0.7)

    def test_rerank_truncates_doc_to_max_chars(self, monkeypatch):
        ce = _reimport("cross_encoder")

        sent_lengths = []

        class FakeModel:
            def predict(self, pairs, show_progress_bar=False):
                sent_lengths.extend(len(d) for _, d in pairs)
                return [0.0] * len(pairs)

        monkeypatch.setattr(ce, "_get_model", lambda: FakeModel())

        long_doc = "x" * (ce.MAX_DOC_CHARS + 500)
        ce.rerank("q", [{"snippet": long_doc}])
        # Cap enforced
        assert sent_lengths[0] == ce.MAX_DOC_CHARS


# ── hybrid_retriever._maybe_rerank integration ────────────────────────────────


class TestHybridRerankIntegration:

    def test_maybe_rerank_disabled_returns_input(self):
        hr = _reimport("hybrid_retriever")
        hits = [hr.HybridHit(path="/a", score=0.5),
                hr.HybridHit(path="/b", score=0.4)]
        out = hr._maybe_rerank("q", hits, enabled=False, depth=20)
        assert out is hits  # same object — no-op

    def test_maybe_rerank_skips_when_fewer_than_two(self):
        hr = _reimport("hybrid_retriever")
        single = [hr.HybridHit(path="/a", score=0.5)]
        out = hr._maybe_rerank("q", single, enabled=True, depth=20)
        assert out == single

    def test_hybrid_query_rerank_flag_threads_through(self, monkeypatch):
        """rerank=True must call _maybe_rerank with the right enabled=True."""
        hr = _reimport("hybrid_retriever")

        captured = {}

        original_maybe = hr._maybe_rerank

        def spy(text, hits, *, enabled, depth):
            captured["enabled"] = enabled
            captured["text"] = text
            return hits

        monkeypatch.setattr(hr, "_maybe_rerank", spy)
        monkeypatch.setattr(hr, "fts_search", lambda q, *, top: [])
        monkeypatch.setattr(hr, "vector_search", lambda q, *, top: [])

        hr.hybrid_query("test", mode="hybrid", top=3, rerank=True)
        assert captured["enabled"] is True
        assert captured["text"] == "test"

        # Restore (defensive)
        monkeypatch.setattr(hr, "_maybe_rerank", original_maybe)
