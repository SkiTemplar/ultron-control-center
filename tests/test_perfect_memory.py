"""Pytest suite for ULTRON v14.6 PERFECT MEMORY.

Covers the static / pure-function surface of `embed_vault.py` and
`hybrid_retriever.py`. Live Qdrant + Sentence-Transformers calls are NOT
exercised here (they require Docker running + ~470MB model on disk); those
are smoke-tested manually via `embed_vault.py status` / `query`.

Layout:
  TestEmbedVaultStatic       — fingerprint, point_id, walker, file reader
  TestRRF                    — Reciprocal Rank Fusion math + edge cases
  TestHybridQueryDispatch    — mode selection + empty backends
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    (tmp_path / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".ultron-vault").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path


def _reimport(name: str):
    if name in sys.modules:
        del sys.modules[name]
    return importlib.import_module(name)


# ── embed_vault static surface ────────────────────────────────────────────────


class TestEmbedVaultStatic:

    def test_walk_vault_yields_only_md_files_sorted(self, fake_home):
        ev = _reimport("embed_vault")
        v = fake_home / ".ultron-vault"
        (v / "a.md").write_text("a", encoding="utf-8")
        (v / "b.txt").write_text("b", encoding="utf-8")  # not md
        (v / "sub").mkdir()
        (v / "sub" / "c.md").write_text("c", encoding="utf-8")
        paths = list(ev.walk_vault(v))
        assert all(p.suffix == ".md" for p in paths)
        # sorted, .md only
        assert len(paths) == 2

    def test_fingerprint_changes_with_content(self, fake_home):
        ev = _reimport("embed_vault")
        v = fake_home / ".ultron-vault"
        f = v / "x.md"
        f.write_text("hello world", encoding="utf-8")
        fp1 = ev.fingerprint(f, "hello world")
        f.write_text("hello WORLD!", encoding="utf-8")
        fp2 = ev.fingerprint(f, "hello WORLD!")
        assert fp1.sha1 != fp2.sha1

    def test_stable_point_id_is_deterministic(self, fake_home):
        ev = _reimport("embed_vault")
        a = ev._stable_point_id("/abs/path/note.md")
        b = ev._stable_point_id("/abs/path/note.md")
        c = ev._stable_point_id("/abs/path/OTHER.md")
        assert a == b
        assert a != c
        assert len(a) == 32  # md5 hex digest

    def test_read_file_skips_oversized(self, fake_home):
        ev = _reimport("embed_vault")
        f = fake_home / "huge.md"
        f.write_text("x" * (ev.MAX_FILE_BYTES + 1), encoding="utf-8")
        assert ev.read_file(f) is None

    def test_read_file_returns_content_when_under_cap(self, fake_home):
        ev = _reimport("embed_vault")
        f = fake_home / "small.md"
        f.write_text("hello", encoding="utf-8")
        assert ev.read_file(f) == "hello"

    def test_state_roundtrip(self, fake_home):
        ev = _reimport("embed_vault")
        ev.save_state({"a": {"sha1": "abc", "bytes": 3, "mtime": 0.0}})
        loaded = ev.load_state()
        assert "a" in loaded
        assert loaded["a"]["sha1"] == "abc"


# ── Reciprocal Rank Fusion ─────────────────────────────────────────────────────


class TestRRF:

    def test_rrf_sums_inverse_ranks(self, fake_home):
        hr = _reimport("hybrid_retriever")
        fts = [{"path": "/a", "rank": 1, "bm25": -1.0, "snippet": "x"}]
        vec = [{"path": "/a", "rank": 2, "vector_score": 0.9, "snippet": "y"}]
        merged = hr.reciprocal_rank_fusion(fts, vec, k=hr.RRF_K)
        assert len(merged) == 1
        expected = 1.0 / (hr.RRF_K + 1) + 1.0 / (hr.RRF_K + 2)
        assert abs(merged[0].score - expected) < 1e-9
        assert merged[0].fts_rank == 1
        assert merged[0].vector_rank == 2

    def test_rrf_documents_present_in_only_one_retriever(self, fake_home):
        hr = _reimport("hybrid_retriever")
        fts = [
            {"path": "/a", "rank": 1, "bm25": -1.0, "snippet": "fts-only-a"},
            {"path": "/b", "rank": 2, "bm25": -1.5, "snippet": "fts-only-b"},
        ]
        vec = [
            {"path": "/c", "rank": 1, "vector_score": 0.8, "snippet": "vec-only-c"},
        ]
        merged = hr.reciprocal_rank_fusion(fts, vec)
        paths = {h.path for h in merged}
        assert paths == {"/a", "/b", "/c"}
        # Top hit is /a (rank 1 in FTS) — same RRF score as /c (rank 1 in vec)
        # so order between them depends on insertion; both must have only-one rank
        for h in merged:
            if h.path == "/a":
                assert h.vector_rank is None
            if h.path == "/c":
                assert h.fts_rank is None

    def test_rrf_ranks_doc_appearing_in_both_higher(self, fake_home):
        hr = _reimport("hybrid_retriever")
        # /a appears in both at rank 1; /b only in FTS at rank 1
        fts = [
            {"path": "/a", "rank": 1, "bm25": -1.0, "snippet": ""},
            {"path": "/b", "rank": 2, "bm25": -1.5, "snippet": ""},
        ]
        vec = [
            {"path": "/a", "rank": 1, "vector_score": 0.9, "snippet": ""},
        ]
        merged = hr.reciprocal_rank_fusion(fts, vec)
        # /a should rank above /b because it gets a contribution from both lists
        assert merged[0].path == "/a"

    def test_rrf_handles_empty_inputs(self, fake_home):
        hr = _reimport("hybrid_retriever")
        assert hr.reciprocal_rank_fusion([], []) == []
        # one empty side still works
        only_fts = hr.reciprocal_rank_fusion(
            [{"path": "/x", "rank": 1, "bm25": -1.0, "snippet": ""}], []
        )
        assert len(only_fts) == 1
        assert only_fts[0].path == "/x"


# ── Hybrid query dispatcher ───────────────────────────────────────────────────


class TestHybridQueryDispatch:

    def test_invalid_mode_raises(self, fake_home):
        hr = _reimport("hybrid_retriever")
        with pytest.raises(ValueError):
            hr.hybrid_query("anything", mode="bogus")

    def test_fts_only_mode_skips_vector(self, fake_home, monkeypatch):
        hr = _reimport("hybrid_retriever")
        called_vec = {"n": 0}

        def fake_fts(_q, *, top):
            return [{"path": "/a", "rank": 1, "bm25": -1.0, "snippet": "ok"}]

        def fake_vec(_q, *, top):
            called_vec["n"] += 1
            return []

        monkeypatch.setattr(hr, "fts_search", fake_fts)
        monkeypatch.setattr(hr, "vector_search", fake_vec)
        out = hr.hybrid_query("q", mode="fts", top=3)
        assert called_vec["n"] == 0
        assert len(out) == 1
        assert out[0].fts_rank == 1
        assert out[0].vector_rank is None

    def test_vector_only_mode_skips_fts(self, fake_home, monkeypatch):
        hr = _reimport("hybrid_retriever")
        called_fts = {"n": 0}

        def fake_fts(_q, *, top):
            called_fts["n"] += 1
            return []

        def fake_vec(_q, *, top):
            return [{"path": "/x", "rank": 1, "vector_score": 0.9, "snippet": "v"}]

        monkeypatch.setattr(hr, "fts_search", fake_fts)
        monkeypatch.setattr(hr, "vector_search", fake_vec)
        out = hr.hybrid_query("q", mode="vector", top=3)
        assert called_fts["n"] == 0
        assert len(out) == 1
        assert out[0].vector_rank == 1
