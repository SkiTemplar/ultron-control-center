"""Pytest suite for ULTRON v14.4 TOKEN HUNTER Phase 0 — token_baseline.py.

Tests run isolated against tmp_path; never touch the real
~/.ultron/audits or ~/.ultron/.tmp. The 12 cases planned by the ops manual
are split as:
  Active (10): 1, 2, 3, 4, 6, 7, 8, 9, 10, 11
  Skipped (2): 5 (waits for v14.4 Phase 1 lazy listing)
               12 (waits for v14.4 Phase 5 D22 doctor detector)
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


@pytest.fixture
def tb(tmp_path, monkeypatch):
    """Re-import token_baseline with USER_HOME redirected to tmp_path."""
    fake_home = tmp_path
    (fake_home / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    (fake_home / ".ultron" / "audits").mkdir(parents=True, exist_ok=True)
    (fake_home / ".claude").mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

    if "token_baseline" in sys.modules:
        del sys.modules["token_baseline"]
    mod = importlib.import_module("token_baseline")
    importlib.reload(mod)
    return mod


# ── Case 1 ─────────────────────────────────────────────────────────────────────


def test_measures_context_md_in_isolation(tb):
    """Case 1: context.md content is measured correctly when present alone."""
    sample = "ULTRON CONTEXT line one\nLine two with more content."
    tb.CONTEXT_MD.write_text(sample, encoding="utf-8")

    result = tb.measure_block("context_md", sample)

    assert result["name"] == "context_md"
    assert result["chars"] == len(sample)
    assert result["bytes"] == len(sample.encode("utf-8"))
    assert result["tokens"] > 0
    assert result["method"] == "tiktoken-cl100k"


# ── Case 2 ─────────────────────────────────────────────────────────────────────


def test_measures_memory_md_in_isolation(tb):
    """Case 2: MEMORY.md content measured independently of other blocks."""
    sample = "# Memory Index\n\n- [Plan A](a.md) — note one\n- [Plan B](b.md) — note two"
    tb.MEMORY_MD.write_text(sample, encoding="utf-8")

    result = tb.measure_block("MEMORY_md", sample)

    assert result["chars"] == len(sample)
    assert result["tokens"] >= 5  # at minimum the heading + bullets


# ── Case 3 ─────────────────────────────────────────────────────────────────────


def test_measures_claude_md_global(tb):
    """Case 3: global CLAUDE.md is read and measured."""
    sample = "# CLAUDE.md\n\nUser global instructions go here.\n\n## Section"
    tb.GLOBAL_CLAUDE_MD.write_text(sample, encoding="utf-8")

    blocks = tb.measure_session_start()
    cm = next(b for b in blocks if b["name"] == "claude_md_global")
    assert cm["chars"] == len(sample)
    assert cm["tokens"] > 0


# ── Case 4 ─────────────────────────────────────────────────────────────────────


def test_measures_skill_listing_full(tb):
    """Case 4: skill listing approximation reads manifest cache."""
    cache = {
        "skills": [
            {"name": "alpha", "description": "first skill"},
            {"name": "beta", "description": "second skill description here"},
        ]
    }
    tb.MANIFEST_CACHE.write_text(json.dumps(cache), encoding="utf-8")

    blocks = tb.measure_session_start()
    sl = next(b for b in blocks if b["name"] == "skill_listing")
    assert sl["chars"] > 0
    assert sl["tokens"] > 0
    # Both names should appear when rendered.
    rendered = tb._estimate_skill_listing()
    assert "alpha" in rendered and "beta" in rendered


# ── Case 5 (skipped) ───────────────────────────────────────────────────────────


@pytest.mark.skip(reason="waits for v14.4 Phase 1 lazy listing — skill_lazy_loader.py")
def test_measures_skill_listing_lazy(tb):
    pass


# ── Case 6 ─────────────────────────────────────────────────────────────────────


def test_total_equals_sum_of_blocks(tb):
    """Case 6: JSON snapshot total equals sum of per-block tokens."""
    tb.CONTEXT_MD.write_text("x" * 100, encoding="utf-8")
    tb.MEMORY_MD.write_text("y" * 200, encoding="utf-8")

    measurements = tb.measure_session_start()
    json_path = tb.write_json(measurements, "2026-05-08T00:00:00")

    payload = json.loads(json_path.read_text(encoding="utf-8"))
    assert payload["totals"]["tokens"] == sum(b["tokens"] for b in measurements)
    assert payload["totals"]["bytes"] == sum(b["bytes"] for b in measurements)


# ── Case 7 ─────────────────────────────────────────────────────────────────────


def test_reproducible_across_runs(tb):
    """Case 7: same input produces same output across 3 runs (variance < 2%)."""
    tb.CONTEXT_MD.write_text("repeatable content " * 20, encoding="utf-8")
    tb.MEMORY_MD.write_text("memory content " * 50, encoding="utf-8")

    runs = [tb.measure_session_start() for _ in range(3)]
    totals = [sum(b["tokens"] for b in r) for r in runs]
    assert totals[0] == totals[1] == totals[2]


# ── Case 8 ─────────────────────────────────────────────────────────────────────


def test_handles_missing_context_md(tb):
    """Case 8: missing context.md returns empty block (no crash)."""
    # context.md intentionally not created
    assert not tb.CONTEXT_MD.exists()

    blocks = tb.measure_session_start()
    cm = next(b for b in blocks if b["name"] == "context_md")
    assert cm["bytes"] == 0
    assert cm["chars"] == 0
    assert cm["tokens"] == 0


# ── Case 9 ─────────────────────────────────────────────────────────────────────


def test_handles_unicode_in_context(tb):
    """Case 9: Unicode (Spanish + emojis + en-dash) measured correctly."""
    sample = "Acción · revisión — comprobar 🚀 está OK · señal de inicio"
    tb.CONTEXT_MD.write_text(sample, encoding="utf-8")

    blocks = tb.measure_session_start()
    cm = next(b for b in blocks if b["name"] == "context_md")
    assert cm["chars"] == len(sample)
    # bytes > chars because of multi-byte UTF-8
    assert cm["bytes"] > cm["chars"]
    assert cm["tokens"] > 0


# ── Case 10 ────────────────────────────────────────────────────────────────────


def test_token_count_correlates_with_tiktoken(tb):
    """Case 10: our count exactly matches tiktoken cl100k_base."""
    import tiktoken
    enc = tiktoken.get_encoding("cl100k_base")
    sample = "The quick brown fox jumps over the lazy dog. " * 10
    expected = len(enc.encode(sample))

    result = tb.measure_block("ad_hoc", sample)

    assert result["tokens"] == expected


# ── Case 11 ────────────────────────────────────────────────────────────────────


def test_writes_tsv_atomically(tb):
    """Case 11: TSV write uses temp + replace (no partial files left over)."""
    tb.CONTEXT_MD.write_text("hello", encoding="utf-8")

    measurements = tb.measure_session_start()
    out = tb.write_tsv(measurements, "2026-05-08")

    assert out.exists()
    content = out.read_text(encoding="utf-8")
    # Header present
    assert content.startswith("block_name\tbytes\tchars\ttokens_estimated\ttokens_method\n")
    # Tab-separated rows for each block
    lines = content.strip().splitlines()
    assert len(lines) == 1 + len(measurements)
    # No leftover .tmp file
    leftover = out.with_suffix(out.suffix + ".tmp")
    assert not leftover.exists()


# ── Case 12 (skipped) ──────────────────────────────────────────────────────────


@pytest.mark.skip(reason="waits for v14.4 Phase 5 D22_TOKEN_BASELINE doctor detector")
def test_doctor_reads_baseline(tb):
    pass


# ── CLI smoke tests (snapshot + budget + diff) ─────────────────────────────────


def test_cli_snapshot_writes_outputs(tb):
    """CLI snapshot command produces TSV + JSON, returns 0."""
    tb.CONTEXT_MD.write_text("ctx", encoding="utf-8")

    rc = tb.main(["snapshot"])
    assert rc == 0
    assert tb.JSON_OUT.exists()
    # At least one TSV in audits dir
    tsvs = list(tb.AUDITS_DIR.glob("token-baseline-*.tsv"))
    assert len(tsvs) >= 1


def test_cli_diff_against_baseline(tb):
    """CLI diff command compares current vs saved baseline JSON."""
    # Snapshot one state
    tb.CONTEXT_MD.write_text("first content", encoding="utf-8")
    tb.main(["snapshot"])
    baseline_json = tb.JSON_OUT.read_text(encoding="utf-8")

    # Save baseline copy
    saved = tb.AUDITS_DIR / "saved-baseline.json"
    saved.write_text(baseline_json, encoding="utf-8")

    # Mutate state
    tb.CONTEXT_MD.write_text("second content with a lot more text " * 5,
                              encoding="utf-8")

    rc = tb.main(["diff", str(saved)])
    assert rc == 0
