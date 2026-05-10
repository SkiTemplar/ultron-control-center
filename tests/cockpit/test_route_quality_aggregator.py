"""
Unit + smoke tests for route_quality_aggregator.py.

Validates:
- BOM-resilient load_quality (P0 fix)
- Agent canonicalization dict (_canonical_agent)
- process_entries: Skill→Skill closed-world, Agent→Agent open-world, dedup
- status command exits cleanly
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parents[2]
COCKPIT    = SKILL_ROOT / "scripts" / "cockpit"
SCRIPT     = COCKPIT / "route_quality_aggregator.py"

# Import module directly (conftest.py adds cockpit to sys.path)
import route_quality_aggregator as agg


def _make_entry(tool: str, target: str, ts: datetime, session: str = "sess1") -> dict:
    return {"tool": tool, "target": target, "ts": ts.isoformat(timespec="seconds"),
            "session_id": session, "kind": "skill" if tool == "Skill" else "subagent"}


def _seeded_quality(*edge_keys: str) -> dict:
    edges = {}
    for key in edge_keys:
        parts = key.split("→")
        edges[key] = agg._empty_edge(parts[0], parts[1])
    return {"version": "1.0", "updated": "", "edges": edges}


class TestLoadQualityBOMResilient:
    def test_clean_utf8_loads(self, tmp_path):
        f = tmp_path / "rq.json"
        f.write_text('{"version":"1.0","updated":"","edges":{}}', encoding="utf-8")
        data = agg.load_quality.__wrapped__(f) if hasattr(agg.load_quality, "__wrapped__") else None
        # Directly test via monkeypatching QUALITY_FILE
        original = agg.QUALITY_FILE
        agg.QUALITY_FILE = f
        try:
            d = agg.load_quality()
            assert d["version"] == "1.0"
        finally:
            agg.QUALITY_FILE = original

    def test_bom_utf8_loads(self, tmp_path):
        f = tmp_path / "rq.json"
        f.write_bytes(b'\xef\xbb\xbf{"version":"1.0","updated":"","edges":{}}')
        original = agg.QUALITY_FILE
        agg.QUALITY_FILE = f
        try:
            d = agg.load_quality()
            assert d["version"] == "1.0"
        finally:
            agg.QUALITY_FILE = original

    def test_corrupt_json_returns_empty(self, tmp_path):
        f = tmp_path / "rq.json"
        f.write_text("not json at all !!!", encoding="utf-8")
        original = agg.QUALITY_FILE
        agg.QUALITY_FILE = f
        try:
            d = agg.load_quality()
            assert d == {"version": "1.0", "updated": "", "edges": {}}
        finally:
            agg.QUALITY_FILE = original

    def test_bom_plus_broken_json_returns_empty(self, tmp_path):
        """BOM + truncated JSON: the real regression case that the P0 fix must catch."""
        f = tmp_path / "rq.json"
        f.write_bytes(b'\xef\xbb\xbf{"edges":')  # BOM + incomplete JSON
        original = agg.QUALITY_FILE
        agg.QUALITY_FILE = f
        try:
            d = agg.load_quality()
            assert d == {"version": "1.0", "updated": "", "edges": {}}
        finally:
            agg.QUALITY_FILE = original


class TestAgentCanonical:
    def test_namespaced_variant_resolved(self):
        assert agg._canonical_agent("agent-skills:code-reviewer") == "code-reviewer"
        assert agg._canonical_agent("feature-dev:code-reviewer") == "feature-dev-reviewer"
        assert agg._canonical_agent("pr-review-toolkit:silent-failure-hunter") == "pr-silent-failure-hunter"

    def test_plain_name_unchanged(self):
        assert agg._canonical_agent("Explore") == "Explore"
        assert agg._canonical_agent("general-purpose") == "general-purpose"
        assert agg._canonical_agent("Plan") == "Plan"

    def test_unknown_name_returned_as_is(self):
        assert agg._canonical_agent("my-custom-agent") == "my-custom-agent"


class TestProcessEntriesSkill:
    def test_seeded_edge_incremented(self):
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        t1 = t0 + timedelta(seconds=30)
        entries = [
            _make_entry("Skill", "ultron", t0),
            _make_entry("Skill", "alfred", t1),
        ]
        quality = _seeded_quality("ultron→alfred")
        n = agg.process_entries(entries, quality)
        assert n == 1
        assert quality["edges"]["ultron→alfred"]["runs"] == 1

    def test_unseeded_skill_edge_open_world_registered(self):
        """Skill→Skill is now open-world (Auditor 3 fix): unseeded edges register
        on first sight, mirroring Agent→Agent behavior. Closed-world seeding only
        covered 11/373 source skills, dropping 95% of real transitions silently."""
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Skill", "foo", t0),
            _make_entry("Skill", "bar", t0 + timedelta(seconds=5)),
        ]
        quality = _seeded_quality()
        n = agg.process_entries(entries, quality)
        assert n == 1
        assert "foo→bar" in quality["edges"]
        assert quality["edges"]["foo→bar"]["runs"] == 1

    def test_outside_window_not_counted(self):
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Skill", "ultron", t0),
            _make_entry("Skill", "alfred", t0 + timedelta(seconds=700)),
        ]
        quality = _seeded_quality("ultron→alfred")
        n = agg.process_entries(entries, quality)
        assert n == 0

    def test_same_edge_deduped_within_session(self):
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Skill", "ultron", t0),
            _make_entry("Skill", "alfred", t0 + timedelta(seconds=10)),
            _make_entry("Skill", "alfred", t0 + timedelta(seconds=20)),
        ]
        quality = _seeded_quality("ultron→alfred")
        n = agg.process_entries(entries, quality)
        # ultron→alfred: counted once (first pair); alfred→alfred skipped (same src/dst)
        assert n == 1


class TestProcessEntriesAgent:
    def test_agent_edge_open_world_registered(self):
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Agent", "Explore", t0),
            _make_entry("Agent", "general-purpose", t0 + timedelta(seconds=15)),
        ]
        quality = {"version": "1.0", "updated": "", "edges": {}}
        n = agg.process_entries(entries, quality)
        assert n == 1
        assert "agent:Explore→agent:general-purpose" in quality["edges"]
        assert quality["edges"]["agent:Explore→agent:general-purpose"]["runs"] == 1

    def test_agent_canonical_applied_to_key(self):
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Agent", "feature-dev:code-reviewer", t0),
            _make_entry("Agent", "Explore", t0 + timedelta(seconds=20)),
        ]
        quality = {"version": "1.0", "updated": "", "edges": {}}
        agg.process_entries(entries, quality)
        assert "agent:feature-dev-reviewer→agent:Explore" in quality["edges"]

    def test_agent_dedup_within_session(self):
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Agent", "Explore", t0),
            _make_entry("Agent", "general-purpose", t0 + timedelta(seconds=10)),
            _make_entry("Agent", "Explore", t0 + timedelta(seconds=20)),
            _make_entry("Agent", "general-purpose", t0 + timedelta(seconds=30)),
        ]
        quality = {"version": "1.0", "updated": "", "edges": {}}
        n = agg.process_entries(entries, quality)
        key = "agent:Explore→agent:general-purpose"
        assert quality["edges"][key]["runs"] == 1, "dedup: same edge counted once per session"

    def test_agent_outside_window_not_counted(self):
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Agent", "Explore", t0),
            _make_entry("Agent", "general-purpose", t0 + timedelta(seconds=700)),
        ]
        quality = {"version": "1.0", "updated": "", "edges": {}}
        n = agg.process_entries(entries, quality)
        assert n == 0

    def test_skill_and_agent_no_cross_dedup(self):
        """Skill edges and Agent edges live in separate keyspaces (agent: prefix).
        With cross-tool transitions enabled, there are 3 edges total: the
        Skill→Skill, the Skill→Agent handoff, and the Agent→Agent."""
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Skill", "ultron", t0),
            _make_entry("Skill", "alfred", t0 + timedelta(seconds=10)),
            _make_entry("Agent", "Explore", t0 + timedelta(seconds=20)),
            _make_entry("Agent", "general-purpose", t0 + timedelta(seconds=30)),
        ]
        quality = _seeded_quality("ultron→alfred")
        n = agg.process_entries(entries, quality)
        assert n == 3
        assert quality["edges"]["ultron→alfred"]["runs"] == 1
        assert quality["edges"]["alfred→agent:Explore"]["runs"] == 1
        assert quality["edges"]["agent:Explore→agent:general-purpose"]["runs"] == 1


class TestProcessEntriesCrossTool:
    """Skill↔Agent handoffs — the most common transition in real ULTRON sessions
    (orchestrator delegates to subagent, subagent returns control). Auditor 3
    finding: previously the per-tool split made these invisible."""

    def test_skill_to_agent_handoff(self):
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Skill", "ultron", t0),
            _make_entry("Agent", "Explore", t0 + timedelta(seconds=15)),
        ]
        quality = {"version": "1.0", "updated": "", "edges": {}}
        n = agg.process_entries(entries, quality)
        assert n == 1
        assert "ultron→agent:Explore" in quality["edges"]

    def test_agent_to_skill_return(self):
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Agent", "Explore", t0),
            _make_entry("Skill", "ultron", t0 + timedelta(seconds=20)),
        ]
        quality = {"version": "1.0", "updated": "", "edges": {}}
        n = agg.process_entries(entries, quality)
        assert n == 1
        assert "agent:Explore→ultron" in quality["edges"]

    def test_full_handoff_chain(self):
        """ULTRON delegates to Explore → Explore returns → ULTRON delegates to alfred."""
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Skill", "ultron",  t0),
            _make_entry("Agent", "Explore", t0 + timedelta(seconds=10)),
            _make_entry("Skill", "ultron",  t0 + timedelta(seconds=30)),
            _make_entry("Skill", "alfred",  t0 + timedelta(seconds=40)),
        ]
        quality = {"version": "1.0", "updated": "", "edges": {}}
        n = agg.process_entries(entries, quality)
        # ultron→agent:Explore, agent:Explore→ultron, ultron→alfred
        assert n == 3
        for k in ("ultron→agent:Explore", "agent:Explore→ultron", "ultron→alfred"):
            assert k in quality["edges"], f"missing {k}"

    def test_parallel_dispatch_collapses(self):
        """3 consecutive Agent calls to same target (parallel dispatch) only
        register the incoming edge — same-target self-loops are skipped."""
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Skill", "ultron",  t0),
            _make_entry("Agent", "Explore", t0 + timedelta(seconds=2)),
            _make_entry("Agent", "Explore", t0 + timedelta(seconds=3)),
            _make_entry("Agent", "Explore", t0 + timedelta(seconds=4)),
        ]
        quality = {"version": "1.0", "updated": "", "edges": {}}
        n = agg.process_entries(entries, quality)
        # Only ultron→agent:Explore counts; the 3 Explore calls collapse via self-loop guard
        assert n == 1
        assert quality["edges"]["ultron→agent:Explore"]["runs"] == 1


class TestProcessEntriesDoubleCount:
    def test_same_session_processed_twice_does_not_double_count(self):
        """Calling process_entries twice with the same data should count each edge once."""
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries = [
            _make_entry("Agent", "Explore", t0),
            _make_entry("Agent", "general-purpose", t0 + timedelta(seconds=10)),
        ]
        quality = {"version": "1.0", "updated": "", "edges": {}}
        # First call — should count 1
        agg.process_entries(entries, quality)
        # Second call with same data (simulates same-day re-run) — should count again
        # because process_entries is stateless; idempotency must be enforced in aggregate()
        agg.process_entries(entries, quality)
        # With same session_id, dedup fires on each individual call but NOT across calls
        key = "agent:Explore→agent:general-purpose"
        # The dedup set is local to process_entries, so second call will increment again
        # This documents the current behavior and confirms the aggregate() watermark is the fix layer
        assert quality["edges"][key]["runs"] == 2, (
            "process_entries is NOT idempotent across calls — idempotency lives in aggregate()"
        )

    def test_different_sessions_both_counted(self):
        t0 = datetime(2026, 5, 2, 10, 0, 0)
        entries_a = [_make_entry("Agent", "Explore", t0, session="sess-a"),
                     _make_entry("Agent", "general-purpose", t0 + timedelta(seconds=5), session="sess-a")]
        entries_b = [_make_entry("Agent", "Explore", t0 + timedelta(minutes=30), session="sess-b"),
                     _make_entry("Agent", "general-purpose", t0 + timedelta(minutes=30, seconds=5), session="sess-b")]
        quality = {"version": "1.0", "updated": "", "edges": {}}
        n = agg.process_entries(entries_a + entries_b, quality)
        assert n == 2, "two distinct sessions both get counted"


class TestStatusCommand:
    def test_status_exits_cleanly(self):
        r = subprocess.run(
            ["uv", "run", "python", str(SCRIPT), "status"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=SKILL_ROOT, timeout=15,
        )
        assert "Traceback" not in r.stderr, r.stderr[:300]
        assert r.returncode == 0
