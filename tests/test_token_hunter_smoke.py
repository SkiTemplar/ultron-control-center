"""Smoke test combining all v14.4 TOKEN HUNTER deliverables.

Verifies the live state of every Phase 0..5 surface:
- Phase 0: token_baseline.measure_session_start returns the 5 blocks.
- Phase 1: skill_lazy_loader public API + state file shape.
- Phase 2: cache_telemetry.detector_status returns a verdict.
- Phase 3: memory_dedupe.build_report on a controlled fixture.
- Phase 5: doctor.py registers token:budget:* and cache:* finding categories.

This test is a regression net: if anyone removes a Phase deliverable, this fails.
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
    """Re-roots Path.home() so smoke modules don't touch real state."""
    (tmp_path / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".ultron" / "audits").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".claude" / "projects").mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path


def _reimport(name):
    if name in sys.modules:
        del sys.modules[name]
    return importlib.reload(importlib.import_module(name))


def test_phase0_token_baseline_callable(fake_home):
    """token_baseline.measure_session_start returns the 5 expected blocks."""
    tb = _reimport("token_baseline")
    blocks = tb.measure_session_start()
    names = {b["name"] for b in blocks}
    assert names == {
        "context_md", "MEMORY_md", "claude_md_global",
        "skill_listing", "tool_descriptions",
    }
    for b in blocks:
        assert "tokens" in b
        assert "method" in b


def test_phase1_skill_lazy_loader_api(fake_home):
    """skill_lazy_loader exposes the documented API + tri-mode classifier."""
    sl = _reimport("skill_lazy_loader")
    # Public API
    for name in (
        "compute_overrides", "apply_overrides", "restore_full_listing",
        "build_skill_listing", "is_lazy_mode", "get_state",
        "parse_cc_version", "check_version_floor",
    ):
        assert hasattr(sl, name), f"missing {name}"
    # Empty dir → empty overrides
    assert sl.compute_overrides(mode="lazy") == {}
    assert sl.compute_overrides(mode="full") == {}


def test_phase2_cache_telemetry_classification(fake_home):
    """cache_telemetry.classify_hit_rate covers all verdict tiers."""
    ct = _reimport("cache_telemetry")
    assert ct.classify_hit_rate(0.99, turns=5) == "insufficient"
    assert ct.classify_hit_rate(0.96, turns=100) == "pass"
    assert ct.classify_hit_rate(0.45, turns=100) == "warn"
    assert ct.classify_hit_rate(0.10, turns=100) == "blocking"
    # detector_status returns a dict with verdict key
    status = ct.detector_status()
    assert isinstance(status, dict)
    assert "verdict" in status


def test_phase3_memory_dedupe_report(fake_home):
    """memory_dedupe.build_report on a controlled fixture identifies dups."""
    md = _reimport("memory_dedupe")
    memory = (fake_home / ".ultron" / "MEMORY.md")
    claude = (fake_home / ".claude" / "CLAUDE.md")
    memory.write_text(
        "# MEMORY\n\nUV is the canonical python runner for ULTRON.\n",
        encoding="utf-8",
    )
    claude.write_text(
        "# CLAUDE\n\nUV is the canonical python runner for ULTRON.\n",
        encoding="utf-8",
    )
    report = md.build_report()
    assert report.matches, "expected at least one duplicate"
    assert any(m.kind == "exact" for m in report.matches)


def test_phase5_doctor_registers_new_categories():
    """doctor._ALL_DETECTORS contains the v14.4 P5 wired detectors."""
    # Read directly from real cockpit (not isolated) so we validate the actual file
    doctor_path = COCKPIT / "doctor.py"
    body = doctor_path.read_text(encoding="utf-8")
    assert "_check_token_block_budgets" in body
    assert "_check_cache_hit_rate" in body
    # Both registered in the all-detectors tuple
    assert "_check_token_block_budgets," in body
    assert "_check_cache_hit_rate," in body
    # Cache category surfaced in VALID_CATEGORIES
    assert '"cache",' in body
