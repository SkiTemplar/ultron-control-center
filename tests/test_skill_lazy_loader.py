"""Pytest suite for ULTRON v14.4 TOKEN HUNTER Phase 1 — skill_lazy_loader.py.

15 cases per ops manual (`~/.ultron/plans/2026-05-09-MACRO-ops-manual.md` lines
195-246):

  TestLazySkillBuilder        (10 cases — builder/scoring/override semantics)
  TestDispatcherLazyIntegration (5 cases — fallback, atomic, regression hooks)

Tests run isolated against `tmp_path`; never touch real
~/.claude/settings.local.json or ~/.ultron state.
"""
from __future__ import annotations

import importlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))


# ── Fixtures ───────────────────────────────────────────────────────────────────


@pytest.fixture
def lazy(tmp_path, monkeypatch):
    """Re-import skill_lazy_loader with HOME redirected to tmp_path.

    Creates the dir tree the loader expects:
      .claude/skills/<n>/SKILL.md
      .ultron/sessions/
      .ultron/.tmp/
    """
    fake_home = tmp_path
    (fake_home / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
    (fake_home / ".ultron" / "sessions").mkdir(parents=True, exist_ok=True)
    (fake_home / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    (fake_home / ".ultron" / "config").mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

    if "skill_lazy_loader" in sys.modules:
        del sys.modules["skill_lazy_loader"]
    mod = importlib.import_module("skill_lazy_loader")
    importlib.reload(mod)
    mod._FAKE_HOME = fake_home  # convenience handle for tests
    return mod


def _make_skill(home: Path, name: str, description: str = "Test skill") -> None:
    sk = home / ".claude" / "skills" / name
    sk.mkdir(parents=True, exist_ok=True)
    (sk / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n",
        encoding="utf-8",
    )


def _make_routing_event(
    home: Path,
    date: str,
    target: str,
    tool: str = "Skill",
    ts: str | None = None,
) -> None:
    """Append a routing.jsonl event to ~/.ultron/sessions/<date>/routing.jsonl."""
    sess = home / ".ultron" / "sessions" / date
    sess.mkdir(parents=True, exist_ok=True)
    if ts is None:
        ts = f"{date}T12:00:00+00:00"
    line = json.dumps({
        "ts": ts,
        "session_id": "test-session",
        "tool": tool,
        "target": target,
        "kind": "skill" if tool == "Skill" else "subagent",
        "cwd": str(home),
    })
    with (sess / "routing.jsonl").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


# ── TestLazySkillBuilder (cases 1-10) ──────────────────────────────────────────


class TestLazySkillBuilder:

    def test_lazy_mode_outputs_one_line_per_skill(self, lazy):
        """Case 1: lazy listing produces one entry per local skill."""
        for i in range(10):
            _make_skill(lazy._FAKE_HOME, f"skill-{i:02d}")
        listing = lazy.build_skill_listing(mode="lazy")
        # 10 lines, one per skill
        assert len([l for l in listing.splitlines() if l.strip()]) == 10

    def test_lazy_mode_includes_name_and_verdict(self, lazy):
        """Case 2: each line carries skill name and either full or [name-only]."""
        _make_skill(lazy._FAKE_HOME, "ultron")  # persona → on
        _make_skill(lazy._FAKE_HOME, "obscure-x")  # → name-only

        listing = lazy.build_skill_listing(mode="lazy")
        assert "ultron" in listing
        assert "obscure-x" in listing
        assert "[name-only]" in listing
        assert "<full description>" in listing

    def test_full_mode_contains_no_name_only_marker(self, lazy):
        """Case 3: mode='full' returns all skills with full descriptions."""
        for n in ("a-skill", "b-skill", "c-skill"):
            _make_skill(lazy._FAKE_HOME, n)
        listing = lazy.build_skill_listing(mode="full")
        assert "[name-only]" not in listing
        assert listing.count("<full description>") == 3

    def test_personas_are_pinned_even_with_no_telemetry(self, lazy):
        """Case 4: persona skills stay 'on' regardless of usage."""
        # Only personas, no events. Includes both canonical and legacy alias
        # names — they all must be pinned for backwards-compat with renamed
        # skills (pana/alfred/don-claudio → personal-assistant/windows-admin/gamedev-engineer).
        for p in ("windows-admin", "alfred", "novalbos", "terry-davis"):
            _make_skill(lazy._FAKE_HOME, p)
        _make_skill(lazy._FAKE_HOME, "rando")

        overrides = lazy.compute_overrides(mode="lazy", top_n=2)
        # Even with top_n=2 the personas should all be 'on'
        assert overrides["windows-admin"] == lazy.ON
        assert overrides["alfred"] == lazy.ON  # backwards-compat alias still pinned
        assert overrides["novalbos"] == lazy.ON
        assert overrides["terry-davis"] == lazy.ON
        # Rando has no score and no persona pin → name-only
        assert overrides["rando"] == lazy.NAME_ONLY

    def test_skill_alias_resolution(self, lazy):
        """Case 4b: SKILL_ALIASES maps deprecated names to canonical ones."""
        # Batch 1 (v15.2.0)
        assert lazy.resolve_skill_alias("pana") == "personal-assistant"
        assert lazy.resolve_skill_alias("alfred") == "windows-admin"
        assert lazy.resolve_skill_alias("don-claudio") == "gamedev-engineer"
        # Batch 2 (v15.2.0)
        assert lazy.resolve_skill_alias("einstein") == "research-explainer"
        assert lazy.resolve_skill_alias("jordan-belfort") == "business-strategist"
        assert lazy.resolve_skill_alias("mike-tyson") == "ui-designer"
        assert lazy.resolve_skill_alias("warren") == "investment-advisor"
        assert lazy.resolve_skill_alias("terry-davis") == "senior-engineer"
        # Unknown / already-canonical names pass through
        assert lazy.resolve_skill_alias("senior-engineer") == "senior-engineer"
        assert lazy.resolve_skill_alias("unknown") == "unknown"

    def test_full_mode_returns_empty_overrides(self, lazy):
        """Case 5: mode='full' yields {} (clears all overrides)."""
        _make_skill(lazy._FAKE_HOME, "a")
        _make_skill(lazy._FAKE_HOME, "b")
        overrides = lazy.compute_overrides(mode="full")
        assert overrides == {}

    def test_score_decay_recent_invocations_outweigh_old(self, lazy):
        """Case 6: exp(-Δd/14) gives recent events higher weight."""
        now = datetime.now(timezone.utc)
        events = [
            {"target": "fresh", "_ts_parsed": now - timedelta(days=1)},
            {"target": "stale", "_ts_parsed": now - timedelta(days=13)},
        ]
        scores = lazy.score_skills(events, half_life_days=14, now=now)
        assert scores["fresh"] > scores["stale"]

    def test_score_strips_plugin_prefix(self, lazy):
        """Case 7: 'plugin:skill' canonicalizes to 'skill'."""
        now = datetime.now(timezone.utc)
        events = [
            {"target": "agent-skills:code-reviewer", "_ts_parsed": now},
            {"target": "code-reviewer", "_ts_parsed": now},
        ]
        scores = lazy.score_skills(events, now=now)
        # Both should aggregate under 'code-reviewer'
        assert "code-reviewer" in scores
        assert "agent-skills:code-reviewer" not in scores
        # Two events, each weighted ~1.0 → score ≈ 2.0
        assert scores["code-reviewer"] > 1.5

    def test_handles_skill_dir_without_skill_md(self, lazy):
        """Case 8: a directory without SKILL.md is excluded."""
        bad = lazy._FAKE_HOME / ".claude" / "skills" / "broken"
        bad.mkdir(parents=True)
        # No SKILL.md created
        _make_skill(lazy._FAKE_HOME, "ok")
        skills = lazy.list_local_skills()
        assert "ok" in skills
        assert "broken" not in skills

    def test_routing_excludes_builtin_agents(self, lazy):
        """Case 9: general-purpose / Explore / Plan are filtered."""
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        _make_routing_event(lazy._FAKE_HOME, today, "general-purpose", tool="Agent")
        _make_routing_event(lazy._FAKE_HOME, today, "Explore", tool="Agent")
        _make_routing_event(lazy._FAKE_HOME, today, "real-skill", tool="Skill")
        events = lazy.load_routing_events(window_days=14)
        targets = [e["target"] for e in events]
        assert targets == ["real-skill"]

    def test_top_n_caps_keep_full_set_size(self, lazy):
        """Case 10: keep_full size never exceeds top_n (when no persona pin)."""
        skills = [f"sk-{i:03d}" for i in range(50)]
        for n in skills:
            _make_skill(lazy._FAKE_HOME, n)
        # Synthetic scores: linearly decreasing
        scores = {n: float(50 - i) for i, n in enumerate(skills)}
        keep = lazy.select_keep_full(
            scores, candidate_skills=skills, top_n=10, pin_personas=False
        )
        assert len(keep) == 10
        # Top-10 by score = sk-000..sk-009
        assert keep == {f"sk-{i:03d}" for i in range(10)}


# ── TestDispatcherLazyIntegration (cases 11-15) ────────────────────────────────


class TestDispatcherLazyIntegration:

    def test_apply_overrides_writes_atomically_with_backup(self, lazy):
        """Case 11: apply produces .bak and a state file; atomic rename."""
        _make_skill(lazy._FAKE_HOME, "ultron")
        _make_skill(lazy._FAKE_HOME, "rando")

        target = lazy._FAKE_HOME / ".claude" / "settings.local.json"
        target.write_text(
            json.dumps({"permissions": {"allow": ["Bash(echo)"]}}),
            encoding="utf-8",
        )

        overrides = lazy.compute_overrides(mode="lazy", top_n=1)
        diff = lazy.apply_overrides(overrides, dry_run=False)

        # Backup exists at <target>.bak (extension-appended convention)
        bak = target.parent / "settings.local.json.bak"
        assert bak.exists()
        assert "permissions" in json.loads(bak.read_text(encoding="utf-8"))

        # Settings now contains skillOverrides
        new = json.loads(target.read_text(encoding="utf-8"))
        assert "skillOverrides" in new
        assert "permissions" in new  # preserved
        assert new["skillOverrides"]["ultron"] == lazy.ON
        assert new["skillOverrides"]["rando"] == lazy.NAME_ONLY

        # State file written
        state = json.loads(lazy._state_file().read_text(encoding="utf-8"))
        assert state["mode"] == "lazy"
        assert state["skills_total"] == 2

    def test_restore_removes_overrides_and_records_state(self, lazy):
        """Case 12: restore strips skillOverrides, leaves other keys intact."""
        _make_skill(lazy._FAKE_HOME, "ultron")
        target = lazy._FAKE_HOME / ".claude" / "settings.local.json"
        target.write_text(
            json.dumps({
                "permissions": {"allow": ["Bash(echo)"]},
                "skillOverrides": {"ultron": "name-only"},
            }),
            encoding="utf-8",
        )
        lazy.restore_full_listing(dry_run=False)
        new = json.loads(target.read_text(encoding="utf-8"))
        assert "skillOverrides" not in new
        assert "permissions" in new
        assert lazy.is_lazy_mode() is False

    def test_dry_run_does_not_modify_settings(self, lazy):
        """Case 13: --dry-run never writes."""
        _make_skill(lazy._FAKE_HOME, "ultron")
        target = lazy._FAKE_HOME / ".claude" / "settings.local.json"
        before = json.dumps({"permissions": {}})
        target.write_text(before, encoding="utf-8")

        lazy.apply_overrides(lazy.compute_overrides(mode="lazy"), dry_run=True)
        after = target.read_text(encoding="utf-8")
        assert before == after
        # State file not written
        assert not lazy._state_file().exists()

    def test_corrupted_settings_local_treated_as_empty(self, lazy):
        """Case 14: malformed settings.local.json doesn't crash; falls back."""
        _make_skill(lazy._FAKE_HOME, "ultron")
        target = lazy._FAKE_HOME / ".claude" / "settings.local.json"
        target.write_text("not-json{{{", encoding="utf-8")

        # Should not raise
        diff = lazy.apply_overrides(
            {"ultron": lazy.NAME_ONLY}, dry_run=False
        )
        assert diff["state"]["mode"] == "lazy"
        # New file is valid JSON
        new = json.loads(target.read_text(encoding="utf-8"))
        assert new["skillOverrides"]["ultron"] == lazy.NAME_ONLY

    def test_version_floor_check(self, lazy):
        """Case 15: parse_cc_version + check_version_floor block CC<2.1.129."""
        # Below floor → block
        assert lazy.parse_cc_version("2.1.128 (Claude Code)") == (2, 1, 128)
        ok, msg = lazy.check_version_floor((2, 1, 128))
        assert ok is False
        assert "2.1.129" in msg

        # At floor → allow
        ok, msg = lazy.check_version_floor((2, 1, 129))
        assert ok is True

        # Above floor → allow
        ok, msg = lazy.check_version_floor((2, 1, 200))
        assert ok is True

        # Unparseable → block
        assert lazy.parse_cc_version("garbage") is None
        ok, msg = lazy.check_version_floor(None)
        assert ok is False
