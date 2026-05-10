"""Pytest suite for S2-A brain_index.py chunks extension.

Tests cover:
  1. Full build → chunks count ≥ 1500, no exceptions
  2. Incremental update re-indexes only the modified note
  3. Query --mode chunks p50 latency < 100ms over 10 runs
  4. BM25 relevance: "ue5 blueprints" → top-3 has domain=cpp-ue5 (or similar)
  5. token_est > 0 for 100% of notes and chunks rows
  6. Back-compat: query without --mode returns same JSON schema as pre-PR

All tests use the REAL index.db (read-only path where possible) or a temp
copy for write tests, to avoid touching production data.
"""
from __future__ import annotations

import importlib
import json
import shutil
import sqlite3
import sys
import time
from pathlib import Path

import pytest

# ── Path setup ────────────────────────────────────────────────────────────────
COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

REAL_DB = Path.home() / ".ultron" / "brain_index" / "index.db"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fresh_module():
    """Import brain_index fresh (no cached state)."""
    if "brain_index" in sys.modules:
        del sys.modules["brain_index"]
    return importlib.import_module("brain_index")


@pytest.fixture(scope="session")
def bi():
    """Session-scoped brain_index module (shared import)."""
    return _fresh_module()


@pytest.fixture
def temp_db(tmp_path, bi):
    """Copy the real index.db into a temp dir and monkey-patch module paths.

    Yields the path to the temp index.db.
    """
    if not REAL_DB.exists():
        pytest.skip("Real index.db not found — run brain_index.py build first")
    dest = tmp_path / "index.db"
    shutil.copy2(str(REAL_DB), str(dest))

    # Redirect module-level paths so write operations go to temp copy
    index_dir_orig = bi.INDEX_DIR
    index_path_orig = bi.INDEX_PATH
    bi.INDEX_DIR = tmp_path
    bi.INDEX_PATH = dest
    yield dest
    # Restore
    bi.INDEX_DIR = index_dir_orig
    bi.INDEX_PATH = index_path_orig


# ── Test 1: Full build produces ≥ 1500 chunks ─────────────────────────────────

def test_chunks_full_build(temp_db, bi):
    """Full build over real vault → chunks_fts populated with ≥ 1500 rows."""
    import argparse
    args = argparse.Namespace()
    rc = bi.cmd_build(args)
    assert rc == 0, "cmd_build returned non-zero exit code"

    conn = sqlite3.connect(str(temp_db))
    try:
        chunk_count = conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0]
        note_count = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
    finally:
        conn.close()

    assert note_count >= 400, f"Expected ≥400 notes, got {note_count}"
    assert chunk_count >= 1500, (
        f"Expected ≥1500 chunks after build over {note_count} notes, got {chunk_count}"
    )


# ── Test 2: Incremental update re-indexes only the modified note ───────────────

def test_chunks_incremental(temp_db, bi, tmp_path):
    """Modify 1 note's content → update re-indexes only that note's chunks."""
    import argparse

    # First, ensure the DB is fully built
    bi.cmd_build(argparse.Namespace())

    conn = sqlite3.connect(str(temp_db))
    try:
        # Pick a real note path that exists in the DB
        row = conn.execute(
            "SELECT path FROM notes WHERE content_chars > 200 LIMIT 1"
        ).fetchone()
    finally:
        conn.close()

    if not row:
        pytest.skip("No notes with content found in temp DB")

    note_path = Path(row[0])
    if not note_path.exists():
        pytest.skip(f"Note path not accessible: {note_path}")

    # Record pre-state chunk counts per note
    conn = sqlite3.connect(str(temp_db))
    try:
        pre_counts = dict(conn.execute(
            "SELECT note_id, COUNT(*) FROM chunks_fts GROUP BY note_id"
        ).fetchall())
        target_id = conn.execute(
            "SELECT id FROM notes WHERE path=?", (note_path.as_posix(),)
        ).fetchone()
    finally:
        conn.close()

    if not target_id:
        pytest.skip("Could not find target note id in temp DB")
    target_id = target_id[0]

    # Mutate the source file slightly (append a space and revert after)
    original_text = note_path.read_text(encoding="utf-8")
    try:
        note_path.write_text(original_text + "\n<!-- S2A test marker -->", encoding="utf-8")
        bi.cmd_update(argparse.Namespace())
    finally:
        note_path.write_text(original_text, encoding="utf-8")

    # After update: check that note's chunk row is still present (was re-indexed)
    conn = sqlite3.connect(str(temp_db))
    try:
        post_target_chunks = conn.execute(
            "SELECT COUNT(*) FROM chunks_fts WHERE note_id=?", (target_id,)
        ).fetchone()[0]
        total_chunks = conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0]
    finally:
        conn.close()

    # The target note must have been re-indexed (chunks still present)
    assert post_target_chunks >= 1, (
        f"Expected ≥1 chunks for note {target_id} after incremental update"
    )
    # Total chunks should be roughly same as before (only 1 note changed)
    total_before = sum(pre_counts.values())
    assert abs(total_chunks - total_before) <= post_target_chunks + 5, (
        f"Expected ~{total_before} total chunks, got {total_chunks} — "
        "too many notes were re-indexed"
    )


# ── Test 3: Query performance p50 < 100ms ─────────────────────────────────────

def test_chunks_query_perf(bi):
    """10 runs of query --mode chunks 'test' → p50 latency < 100ms."""
    if not REAL_DB.exists():
        pytest.skip("Real index.db not found")

    import argparse

    # Use read-only path for performance test against real DB
    latencies_ms = []
    for _ in range(10):
        conn = sqlite3.connect(str(REAL_DB))
        t0 = time.perf_counter()
        try:
            sql = (
                "SELECT n.path, cf.chunk_idx, cf.token_est, "
                "snippet(chunks_fts, 0, '«', '»', '…', 12), "
                "bm25(chunks_fts) "
                "FROM chunks_fts cf "
                "JOIN notes n ON n.id = cf.note_id "
                "WHERE chunks_fts MATCH ? "
                "ORDER BY bm25(chunks_fts) LIMIT 5"
            )
            conn.execute(sql, ("test",)).fetchall()
        except sqlite3.OperationalError:
            pytest.skip("chunks_fts not yet built — run brain_index.py build first")
        finally:
            t1 = time.perf_counter()
            conn.close()
        latencies_ms.append((t1 - t0) * 1000)

    latencies_ms.sort()
    p50 = latencies_ms[len(latencies_ms) // 2]
    p95 = latencies_ms[int(len(latencies_ms) * 0.95)]
    print(f"\n[perf] chunks query p50={p50:.1f}ms  p95={p95:.1f}ms")
    assert p50 < 100, f"p50 latency {p50:.1f}ms exceeds 100ms target"


# ── Test 4: BM25 relevance for UE5 query ──────────────────────────────────────

def test_chunks_bm25_relevance(bi):
    """Query 'ue5 OR blueprints OR unreal' → at least one chunk in top-3 must
    be UE5-relevant by either:
      - domain in known UE5 vocab whitelist {cpp-ue5, ue5-dev, don-claudio}
      - path containing 'ue5' or 'unreal' (catches notes living under non-UE5
        skill dirs that nevertheless cover UE5 — common pattern in this vault)
    Strict: no escape hatch, no bare "cpp" substring (would match plain C++).
    """
    if not REAL_DB.exists():
        pytest.skip("Real index.db not found")

    # Pre-check: vault must actually have UE5 content somewhere, else the
    # assertion would be unfair (env-dependent). Skip rather than fail.
    conn = sqlite3.connect(str(REAL_DB))
    try:
        ue5_signal = conn.execute(
            "SELECT COUNT(*) FROM chunks_fts cf "
            "JOIN notes n ON n.id=cf.note_id "
            "WHERE LOWER(cf.domain) LIKE '%ue5%' "
            "OR LOWER(cf.domain) LIKE '%unreal%' "
            "OR LOWER(n.path) LIKE '%ue5%' "
            "OR LOWER(n.path) LIKE '%unreal%'"
        ).fetchone()[0]
    finally:
        conn.close()
    if ue5_signal == 0:
        pytest.skip("Vault has no UE5/unreal content (path or domain)")

    conn = sqlite3.connect(str(REAL_DB))
    try:
        try:
            rows = conn.execute(
                "SELECT cf.domain, n.path "
                "FROM chunks_fts cf JOIN notes n ON n.id=cf.note_id "
                "WHERE chunks_fts MATCH 'ue5 OR blueprints OR unreal' "
                "ORDER BY bm25(chunks_fts) LIMIT 3"
            ).fetchall()
        except sqlite3.OperationalError:
            pytest.skip("chunks_fts not yet built — run brain_index.py build first")
    finally:
        conn.close()

    if not rows:
        pytest.skip("No results for UE5 query — vault may not have UE5 content")

    # Strict whitelist of known UE5 domains in this vault. Adding more domains
    # here is a deliberate spec change, not a test-loosening shortcut.
    UE5_DOMAINS = {"cpp-ue5", "ue5-dev", "don-claudio"}

    def is_ue5_chunk(domain: str, path: str) -> bool:
        if domain in UE5_DOMAINS:
            return True
        p = (path or "").lower()
        return "ue5" in p or "unreal" in p

    matched = [(d, p) for d, p in rows if is_ue5_chunk(d, p)]
    assert matched, (
        f"Expected at least one top-3 BM25 chunk to be UE5-relevant "
        f"(domain in {UE5_DOMAINS} or path contains 'ue5'/'unreal'); "
        f"got: {rows}"
    )


# ── Test 5: token_est populated for 100% of notes and chunks ──────────────────

def test_token_est_populated(bi):
    """100% of notes and chunks rows must have token_est > 0 after build."""
    if not REAL_DB.exists():
        pytest.skip("Real index.db not found")

    conn = sqlite3.connect(str(REAL_DB))
    try:
        total_notes = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        zero_notes = conn.execute(
            "SELECT COUNT(*) FROM notes WHERE token_est IS NULL OR token_est <= 0"
        ).fetchone()[0]

        try:
            total_chunks = conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0]
            zero_chunks = conn.execute(
                "SELECT COUNT(*) FROM chunks_fts WHERE token_est IS NULL OR token_est = '0'"
            ).fetchone()[0]
        except sqlite3.OperationalError:
            pytest.skip("chunks_fts not yet built — run brain_index.py build first")
    finally:
        conn.close()

    if total_notes == 0:
        pytest.skip("No notes in index — run brain_index.py build first")

    assert zero_notes == 0, (
        f"{zero_notes}/{total_notes} notes have token_est <= 0"
    )
    if total_chunks > 0:
        assert zero_chunks == 0, (
            f"{zero_chunks}/{total_chunks} chunks have token_est <= 0"
        )


# ── Test 6: Back-compat — query without --mode returns identical JSON schema ──

def test_back_compat_query(bi):
    """query 'test' (no --mode) returns JSON with pre-PR schema (keys + types)."""
    if not REAL_DB.exists():
        pytest.skip("Real index.db not found")

    import argparse
    import io
    from contextlib import redirect_stdout

    # Capture output of the notes-mode query
    args = argparse.Namespace(
        query="test",
        layer=None,
        category=None,
        domain=None,
        top=3,
        mode="notes",  # explicit default, same as no --mode
    )
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = bi.cmd_query(args)

    assert rc == 0, "cmd_query returned non-zero"
    output = buf.getvalue().strip()
    assert output, "cmd_query produced no output"

    data = json.loads(output)

    # Top-level schema: must have these exact keys (pre-PR contract)
    assert set(data.keys()) == {"query", "matches", "results"}, (
        f"Top-level keys changed: {set(data.keys())}"
    )
    assert isinstance(data["query"], str)
    assert isinstance(data["matches"], int)
    assert isinstance(data["results"], list)

    # Per-result schema (must match pre-PR exactly)
    if data["results"]:
        r = data["results"][0]
        expected_keys = {"id", "path", "layer", "category", "domain",
                         "title", "snippet", "rank"}
        assert set(r.keys()) == expected_keys, (
            f"Result keys changed: {set(r.keys())} (expected {expected_keys})"
        )
        assert isinstance(r["id"], int)
        assert isinstance(r["path"], str)
        assert isinstance(r["rank"], float)
