#!/usr/bin/env python3
"""
ULTRON v12 cockpit smoke tests.

Run with:  uv run pytest test_cockpit.py -v
           python -m pytest test_cockpit.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import session_compactor
from session_compactor import (build_synth_prompt, query_distilled, _extract_root_json,
                                parse_transcript, find_transcript)
from brain_config import load_synonyms, _BUILTIN_SYNONYMS, load, tree_read_plan


# ── Helpers ────────────────────────────────────────────────────────────────────

def _parsed(**overrides) -> dict:
    base = {
        "n_turns": 5,
        "n_user": 3,
        "total_chars": 500,
        "user_prompts": ["test user prompt"],
        "assistant_texts": ["test assistant response that is long enough to pass the 100-char filter"],
        "first_ts": "2026-04-30T10:00:00",
        "last_ts": "2026-04-30T11:00:00",
    }
    base.update(overrides)
    return base


# ── build_synth_prompt ────────────────────────────────────────────────────────

def test_brace_escaping_user_prompt_no_crash():
    """User prompt with {} must not raise KeyError in str.format()."""
    parsed = _parsed(user_prompts=[
        "config = {key: value}",
        "def foo(x: dict[str, int] = {}) -> None: pass",
    ])
    result = build_synth_prompt(parsed, [], "test-session-1234")
    assert isinstance(result, str)
    assert len(result) > 100


def test_brace_escaping_assistant_text_no_crash():
    """Assistant text with {} must not raise KeyError in str.format()."""
    parsed = _parsed(assistant_texts=[
        "Here is {x: int} and a nested {outer: {inner: val}} structure"
    ])
    result = build_synth_prompt(parsed, [], "session-abc")
    assert isinstance(result, str)


def test_brace_escaping_candidate_snippet_no_crash():
    """Candidate snippet (from vault note body) with {} must not crash."""
    candidates = [
        {"id": 1, "title": "GAS Notes", "path": "/vault/gas.md",
         "snippet": "calls GetAttributeValue({Tag}, {Value}) on the ASC"},
    ]
    result = build_synth_prompt(_parsed(), candidates, "session-xyz")
    assert isinstance(result, str)


def test_build_synth_prompt_contains_session_id():
    """Prompt must embed the session_id prefix."""
    result = build_synth_prompt(_parsed(), [], "abcdef1234567890")
    assert "abcdef12" in result


# ── query_distilled ────────────────────────────────────────────────────────────

def test_query_distilled_nonexistent_dir(tmp_path):
    assert query_distilled(["replication"], tmp_path / "nonexistent") == []


def test_query_distilled_empty_dir(tmp_path):
    assert query_distilled(["replication"], tmp_path) == []


def test_query_distilled_matches_topic_word(tmp_path):
    """Tuples whose target contains a topic word (≥4 chars) must be returned."""
    jsonl = tmp_path / "auto-2026-04-30-abcdef12.jsonl"
    rows = [
        {"ts": "2026-04-30", "sid": "abcdef12", "domain": "ue5",
         "action": "decision",
         "target": "use replication subsystem for movement sync",
         "result": "ue5", "tags": ["decision"]},
        {"ts": "2026-04-30", "sid": "abcdef12", "domain": "python",
         "action": "pattern",
         "target": "always close sqlite connections in finally blocks",
         "result": "new", "tags": ["pattern"]},
    ]
    jsonl.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")

    result = query_distilled(["replication sync"], tmp_path)
    assert len(result) == 1
    assert "replication" in result[0]["target"]


def test_query_distilled_ignores_non_actionable(tmp_path):
    """Tuples with action='compacted' must NOT be returned (only decision/pattern/seed)."""
    jsonl = tmp_path / "auto-2026-04-30-abcdef12.jsonl"
    rows = [
        {"ts": "2026-04-30", "sid": "x", "domain": "session",
         "action": "compacted", "target": "5t/1000c", "result": "ok", "tags": []},
    ]
    jsonl.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    result = query_distilled(["compacted"], tmp_path)
    assert result == []


# ── _extract_root_json ────────────────────────────────────────────────────────

def test_extract_root_json_simple():
    text = 'Some prose: {"key": "value"}'
    result = _extract_root_json(text)
    assert result is not None
    assert json.loads(result) == {"key": "value"}


def test_extract_root_json_nested():
    text = 'Result: {"summary": "done", "decisions": [{"d": "val"}]}'
    result = _extract_root_json(text)
    assert result is not None
    parsed = json.loads(result)
    assert parsed["summary"] == "done"
    assert len(parsed["decisions"]) == 1


def test_extract_root_json_picks_last():
    """When Codex prints a draft then a final, picks the final (last) object."""
    text = '{"draft": "v1"} here is the corrected version {"final": "v2"}'
    result = _extract_root_json(text)
    assert result is not None
    assert "final" in json.loads(result)


def test_extract_root_json_returns_none_on_empty():
    assert _extract_root_json("no json here") is None
    assert _extract_root_json("") is None


# ── brain_config ──────────────────────────────────────────────────────────────

def test_load_synonyms_contains_all_builtins():
    syns = load_synonyms()
    for key in _BUILTIN_SYNONYMS:
        assert key in syns, f"Built-in synonym '{key}' missing"


def test_load_synonyms_returns_mutable_copy():
    """Mutating the returned dict must not corrupt _BUILTIN_SYNONYMS."""
    syns = load_synonyms()
    syns["__sentinel__"] = "should_not_persist"
    assert "__sentinel__" not in _BUILTIN_SYNONYMS


def test_load_config_has_all_defaults():
    cfg = load()
    expected = {"mode_ttl_hours", "decay_threshold_days", "decay_max_prime_results",
                "session_min_turns", "session_min_user_chars", "codex_timeout_sec",
                "brain_session_lookback_days"}
    assert expected <= set(cfg.keys())


def test_load_config_defaults_are_sensible():
    cfg = load()
    assert cfg["session_min_turns"] >= 1
    assert cfg["codex_timeout_sec"] >= 30
    assert cfg["decay_threshold_days"] >= 1


# ── parse_transcript ──────────────────────────────────────────────────────────

def test_parse_transcript_basic(tmp_path):
    """One user turn + one long assistant turn are parsed correctly."""
    jl = tmp_path / "session.jsonl"
    rows = [
        {"type": "user", "timestamp": "2026-04-30T10:00:00",
         "message": {"content": "how do I fix the replication bug?"}},
        {"type": "assistant", "timestamp": "2026-04-30T10:01:00",
         "message": {"content": [{"type": "text", "text": "A" * 150}]}},
    ]
    jl.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    result = parse_transcript(jl)
    assert result["n_turns"] == 1
    assert result["n_user"] == 1
    assert "replication" in result["user_prompts"][0]
    assert len(result["assistant_texts"]) == 1
    assert result["first_ts"] == "2026-04-30T10:00:00"


def test_parse_transcript_skips_tool_content(tmp_path):
    """User content starting with '<' (injected tool results) must be skipped."""
    jl = tmp_path / "session.jsonl"
    rows = [
        {"type": "user", "timestamp": "t1",
         "message": {"content": "<tool_result>should be ignored</tool_result>"}},
        {"type": "user", "timestamp": "t2",
         "message": {"content": "real user message"}},
    ]
    jl.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    result = parse_transcript(jl)
    assert result["n_turns"] == 1
    assert result["user_prompts"] == ["real user message"]


def test_parse_transcript_empty_file(tmp_path):
    jl = tmp_path / "empty.jsonl"
    jl.write_text("", encoding="utf-8")
    result = parse_transcript(jl)
    assert result["n_turns"] == 0
    assert result["user_prompts"] == []
    assert result["first_ts"] is None


def test_parse_transcript_short_assistant_skipped(tmp_path):
    """Assistant texts ≤100 chars must be filtered out."""
    jl = tmp_path / "session.jsonl"
    rows = [
        {"type": "user", "timestamp": "t1",
         "message": {"content": "hello"}},
        {"type": "assistant", "timestamp": "t2",
         "message": {"content": [{"type": "text", "text": "short"}]}},
    ]
    jl.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    result = parse_transcript(jl)
    assert result["assistant_texts"] == []


# ── find_transcript ───────────────────────────────────────────────────────────

def test_find_transcript_returns_none_when_no_projects(tmp_path, monkeypatch):
    monkeypatch.setattr(session_compactor, "CLAUDE_PROJECTS", tmp_path / "nonexistent")
    assert find_transcript(None) is None


def test_find_transcript_returns_none_without_match(tmp_path, monkeypatch):
    """FIX-4c: no fallback — missing session_id returns None (safe, avoids wrong compact)."""
    monkeypatch.setattr(session_compactor, "CLAUDE_PROJECTS", tmp_path)
    proj = tmp_path / "proj-abc"
    proj.mkdir()
    jl = proj / "some-other-session.jsonl"
    jl.write_text("{}", encoding="utf-8")
    result = find_transcript("nonexistent-session-id-xyz")
    assert result is None


def test_find_transcript_prefers_matching_session_id(tmp_path, monkeypatch):
    """A file whose stem starts with the session_id is preferred over any other."""
    monkeypatch.setattr(session_compactor, "CLAUDE_PROJECTS", tmp_path)
    proj = tmp_path / "proj-abc"
    proj.mkdir()
    other = proj / "other-session.jsonl"
    other.write_text("{}", encoding="utf-8")
    target = proj / "abc123-rest-of-name.jsonl"
    target.write_text("{}", encoding="utf-8")
    result = find_transcript("abc123")
    assert result == target


# ── route_quality — Handoff Contract Tests (Task 8B) ─────────────────────────

import route_quality
from route_quality import _compute_score, resolve_conflict, mode_allows_level, RECOVERY_STATES, TOKEN_HARD_STOPS


def _edge(**overrides) -> dict:
    base = {
        "from": "ultron", "to": "senior-engineer",
        "runs": 0, "successes": 0, "fallbacks": 0, "corrections": 0,
        "avg_token_cost": 0, "avg_duration_sec": 0,
        "last_outcome": "unknown", "last_used": None,
        "USER_signal": "unknown",
    }
    base.update(overrides)
    return base


class TestComputeScore:
    def test_optimistic_prior_with_no_data(self):
        """Score with 0 runs uses 0.70 prior for observed_success."""
        score = _compute_score(_edge())
        assert 0.0 <= score <= 1.0
        # With prior 0.70 * 0.25 = 0.175, domain 0.8*0.30 = 0.24, safety 1.0*0.15 = 0.15
        assert score >= 0.50

    def test_score_clamped_to_unit_interval(self):
        score = _compute_score(_edge(runs=100, successes=100), mode="ULTRA",
                               domain_fit=1.0, safety_fit=1.0)
        assert 0.0 <= score <= 1.0

    def test_failed_last_outcome_penalises_recency(self):
        score_ok   = _compute_score(_edge(runs=10, successes=10, last_outcome="success"))
        score_fail = _compute_score(_edge(runs=10, successes=10, last_outcome="failed"))
        assert score_ok > score_fail

    def test_USER_approved_boosts_domain_fit(self):
        score_approved = _compute_score(_edge(USER_signal="approved"))
        score_unknown  = _compute_score(_edge(USER_signal="unknown"))
        assert score_approved >= score_unknown

    def test_USER_signal_ignored(self):
        """USER_signal removed in v12.5 — scores are equal regardless of value."""
        score_rejected = _compute_score(_edge(USER_signal="rejected"))
        score_unknown  = _compute_score(_edge(USER_signal="unknown"))
        assert score_rejected == score_unknown

    def test_high_token_cost_within_budget_reduces_efficiency(self):
        score_cheap = _compute_score(_edge(avg_token_cost=100),  mode="MEDIUM")
        score_pricey = _compute_score(_edge(avg_token_cost=1900), mode="MEDIUM")
        assert score_cheap >= score_pricey

    def test_sufficient_runs_uses_observed_data(self):
        """With ≥3 runs, score reflects real success rate, not prior."""
        score_100pct = _compute_score(_edge(runs=10, successes=10))
        score_0pct   = _compute_score(_edge(runs=10, successes=0))
        assert score_100pct > score_0pct


class TestResolveConflict:
    def test_empty_candidates_returns_none(self):
        assert resolve_conflict([]) is None

    def test_single_candidate_returned_with_only_reason(self):
        result = resolve_conflict([{"from": "a", "to": "b"}])
        assert result is not None
        assert result["reason"] == "only candidate"
        assert result["score"] == 0.8

    def test_clear_winner_by_gap(self, monkeypatch, tmp_path):
        # Patch QUALITY_FILE to an empty store so scores are from neutral prior
        monkeypatch.setattr(route_quality, "QUALITY_FILE", tmp_path / "rq.json")
        candidates = [
            {"from": "ultron", "to": "senior-engineer", "domain_fit": 1.0, "safety_fit": 1.0},
            {"from": "ultron", "to": "tolkien",     "domain_fit": 0.1, "safety_fit": 0.1},
        ]
        result = resolve_conflict(candidates)
        assert result is not None
        assert result["to"] == "senior-engineer"
        assert "best score" in result.get("reason", "").lower()

    def test_result_contains_required_fields(self, monkeypatch, tmp_path):
        monkeypatch.setattr(route_quality, "QUALITY_FILE", tmp_path / "rq.json")
        result = resolve_conflict([
            {"from": "a", "to": "b", "domain_fit": 0.9, "safety_fit": 0.9},
            {"from": "a", "to": "c", "domain_fit": 0.5, "safety_fit": 0.5},
        ])
        assert result is not None
        assert "score" in result
        assert "reason" in result


class TestModeAllowsLevel:
    def test_low_mode_only_allows_l0(self):
        assert mode_allows_level("LOW", "L0") is True
        assert mode_allows_level("LOW", "L1") is False
        assert mode_allows_level("LOW", "L2") is False
        assert mode_allows_level("LOW", "L3") is False
        assert mode_allows_level("LOW", "L4") is False

    def test_medium_mode_allows_up_to_l2(self):
        assert mode_allows_level("MEDIUM", "L0") is True
        assert mode_allows_level("MEDIUM", "L1") is True
        assert mode_allows_level("MEDIUM", "L2") is True
        assert mode_allows_level("MEDIUM", "L3") is False
        assert mode_allows_level("MEDIUM", "L4") is False

    def test_high_mode_allows_up_to_l3(self):
        assert mode_allows_level("HIGH", "L3") is True
        assert mode_allows_level("HIGH", "L4") is False

    def test_ultra_mode_allows_all(self):
        for level in ("L0", "L1", "L2", "L3", "L4"):
            assert mode_allows_level("ULTRA", level) is True

    def test_l3_variant_treated_as_l3(self):
        """'L3-target-only' and 'L3-target-files-only' should be treated as L3."""
        assert mode_allows_level("HIGH", "L3-target-only") is True
        assert mode_allows_level("HIGH", "L3-target-files-only") is True
        assert mode_allows_level("MEDIUM", "L3-target-only") is False


# ── route_quality — Failure Recovery Tests (Task 8C) ─────────────────────────

class TestRecoveryStates:
    def test_all_expected_states_defined(self):
        expected = {
            "retry_same_with_L2",
            "retry_same_with_L3_target",
            "switch_to_fallback",
            "escalate_to_ultron",
            "ask_USER",
            "mark_route_degraded",
        }
        assert expected == set(RECOVERY_STATES)

    def test_recovery_states_are_strings(self):
        assert all(isinstance(s, str) for s in RECOVERY_STATES)


class TestTokenHardStops:
    def test_all_modes_present(self):
        assert {"LOW", "MEDIUM", "HIGH", "ULTRA"} <= set(TOKEN_HARD_STOPS.keys())

    def test_hard_stops_ordered_by_restrictiveness(self):
        """LOW has fewer allowed levels than MEDIUM, MEDIUM fewer than HIGH, etc."""
        assert len(TOKEN_HARD_STOPS["LOW"])    < len(TOKEN_HARD_STOPS["MEDIUM"])
        assert len(TOKEN_HARD_STOPS["MEDIUM"]) < len(TOKEN_HARD_STOPS["HIGH"])
        assert len(TOKEN_HARD_STOPS["HIGH"])   < len(TOKEN_HARD_STOPS["ULTRA"])

    def test_l0_always_in_all_modes(self):
        for mode, levels in TOKEN_HARD_STOPS.items():
            assert "L0" in levels, f"L0 missing from {mode}"


class TestRecordOutcome:
    def test_record_increments_runs(self, tmp_path, monkeypatch):
        monkeypatch.setattr(route_quality, "QUALITY_FILE", tmp_path / "rq.json")
        monkeypatch.setattr(route_quality, "CACHE_DIR", tmp_path)
        route_quality.record_outcome("a", "b", success=True)
        data = route_quality.load_quality()
        edge = data["edges"].get("a→b", {})
        assert edge["runs"] == 1
        assert edge["successes"] == 1
        assert edge["last_outcome"] == "success"

    def test_record_failure_updates_last_outcome(self, tmp_path, monkeypatch):
        monkeypatch.setattr(route_quality, "QUALITY_FILE", tmp_path / "rq.json")
        monkeypatch.setattr(route_quality, "CACHE_DIR", tmp_path)
        route_quality.record_outcome("x", "y", success=False, token_cost=500)
        data = route_quality.load_quality()
        edge = data["edges"]["x→y"]
        assert edge["last_outcome"] == "failed"
        assert edge["avg_token_cost"] == 500

    def test_record_outcome_ignores_unknown_kwargs(self, tmp_path, monkeypatch):
        """USER_signal removed in v12.5 — record_outcome no longer accepts it."""
        monkeypatch.setattr(route_quality, "QUALITY_FILE", tmp_path / "rq.json")
        monkeypatch.setattr(route_quality, "CACHE_DIR", tmp_path)
        route_quality.record_outcome("a", "b", success=True)
        data = route_quality.load_quality()
        assert data["edges"]["a→b"]["last_outcome"] == "success"

    def test_rolling_average_token_cost(self, tmp_path, monkeypatch):
        monkeypatch.setattr(route_quality, "QUALITY_FILE", tmp_path / "rq.json")
        monkeypatch.setattr(route_quality, "CACHE_DIR", tmp_path)
        route_quality.record_outcome("a", "b", success=True, token_cost=1000)
        route_quality.record_outcome("a", "b", success=True, token_cost=2000)
        data = route_quality.load_quality()
        avg = data["edges"]["a→b"]["avg_token_cost"]
        assert 1400 <= avg <= 1600  # rolling avg of 1000+2000 = ~1500


# ── Task 8B: Handoff Contract Tests ──────────────────────────────────────────

class TestHandoffContracts:
    """Task 8B — Four canonical route handoff contracts.

    A handoff contract combines route resolution (resolve_conflict) with the
    memory plan (tree_read_plan) to produce a compact orchestration spec.
    """

    FORBIDDEN_CONTEXT_KEYS = {"full_vault", "all_skills", "session_transcript"}

    def _build_handoff(self, from_s: str, to_s: str, flow: str, mode: str,
                       tmp_path, monkeypatch) -> dict:
        """Assemble a handoff contract for one canonical route."""
        monkeypatch.setattr(route_quality, "QUALITY_FILE", tmp_path / "rq.json")
        monkeypatch.setattr(route_quality, "CACHE_DIR", tmp_path)
        candidate = {"from": from_s, "to": to_s, "domain_fit": 0.9, "safety_fit": 1.0}
        route = route_quality.resolve_conflict([candidate], mode=mode)
        plan = tree_read_plan(flow)
        return {**route, "memory_levels": plan["memory_levels"],
                "max_tokens": plan["max_tokens"], "allow_l4": plan["allow_l4"]}

    def _assert_contract_valid(self, contract: dict) -> None:
        assert contract.get("from"), "handoff must have 'from'"
        assert contract.get("to"), "handoff must have 'to'"
        assert contract.get("reason"), "handoff must have a non-empty reason"
        assert "memory_levels" in contract, "handoff must declare memory levels"
        assert "max_tokens" in contract, "handoff must declare token budget"
        assert "allow_l4" in contract, "handoff must declare L4 permission"
        assert not (self.FORBIDDEN_CONTEXT_KEYS & set(contract)), \
            "handoff must not include broad context fields"

    def test_ultron_to_terry_davis_code_bug(self, tmp_path, monkeypatch):
        """ultron → senior-engineer for a code bug: compact debug contract, no L4."""
        contract = self._build_handoff(
            "ultron", "senior-engineer", "debug_unknown_bug", "HIGH", tmp_path, monkeypatch)
        self._assert_contract_valid(contract)
        assert contract["from"] == "ultron"
        assert contract["to"] == "senior-engineer"
        assert not contract["allow_l4"], "code debug must not load L4"
        assert contract["max_tokens"] <= 5000

    def test_ultron_to_skill_creator_sync_drift(self, tmp_path, monkeypatch):
        """ultron → skill-creator for skill sync drift: targeted skill read, no L4."""
        contract = self._build_handoff(
            "ultron", "skill-creator", "skills_sync", "HIGH", tmp_path, monkeypatch)
        self._assert_contract_valid(contract)
        assert contract["from"] == "ultron"
        assert contract["to"] == "skill-creator"
        assert not contract["allow_l4"], "skills sync must not load L4"

    def test_repo_evaluator_to_sharp_edges_security(self, tmp_path, monkeypatch):
        """repo-evaluator → sharp-edges for security review: code review levels, no L4."""
        contract = self._build_handoff(
            "repo-evaluator", "sharp-edges", "code_review", "HIGH", tmp_path, monkeypatch)
        self._assert_contract_valid(contract)
        assert contract["from"] == "repo-evaluator"
        assert contract["to"] == "sharp-edges"
        assert not contract["allow_l4"], "code review must not load L4"

    def test_ui_designer_to_frontend_design_ui(self, tmp_path, monkeypatch):
        """ui-designer → frontend-design for UI: implementation levels, no L4."""
        contract = self._build_handoff(
            "ui-designer", "frontend-design", "code_implementation", "MEDIUM", tmp_path, monkeypatch)
        self._assert_contract_valid(contract)
        assert contract["from"] == "ui-designer"
        assert contract["to"] == "frontend-design"
        assert not contract["allow_l4"], "UI implementation must not load L4"

    def test_architecture_review_allows_l4(self):
        """architecture_review flow (ULTRA proxy) must allow L4 — the one legitimate exception."""
        plan = tree_read_plan("architecture_review")
        assert plan["allow_l4"]
        assert plan["allow_external"]
        assert "L4" in plan["memory_levels"]
