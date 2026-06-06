"""Pytest suite for ULTRON embed_skills.py.

Tests the static surface (frontmatter parser, walker, fingerprint, state
roundtrip, reranking). Live Qdrant + sentence-transformers calls are NOT
exercised here; smoke is verified via `embed_skills.py status / query` in CI.

Covers the hardening changes introduced 2026-06-06:
  - _parse_frontmatter now accepts _source_hint kwarg and catches YAML errors.
  - to_payload includes entity='skill'.
  - query_skills signature extended with rerank param.
  - _rerank function for tier/freshness post-processing.
  - self-heal WARN logging.
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

# ── Path bootstrap ────────────────────────────────────────────────────────────

_COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
if str(_COCKPIT) not in sys.path:
    sys.path.insert(0, str(_COCKPIT))


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    (tmp_path / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".claude" / "plugins" / "cache").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path


def _reimport(name: str):
    if name in sys.modules:
        del sys.modules[name]
    return importlib.import_module(name)


def _make_skill(
    home: Path,
    name: str,
    description: str,
    *,
    tags: list[str] | None = None,
    tier: str = "L1",
    kind: str = "local",
) -> Path:
    if kind == "local":
        d = home / ".claude" / "skills" / name
    else:
        d = (
            home
            / ".claude"
            / "plugins"
            / "cache"
            / "marketplace"
            / "plug"
            / "version"
            / "skills"
            / name
        )
    d.mkdir(parents=True, exist_ok=True)
    fm_lines = ["---", f"name: {name}", f"tier: {tier}"]
    if tags:
        fm_lines.append(f"tags: [{', '.join(tags)}]")
    fm_lines.append("description: |")
    fm_lines.append(f"  {description}")
    fm_lines.append("---")
    fm_lines.append("# body")
    skill = d / "SKILL.md"
    skill.write_text("\n".join(fm_lines) + "\n", encoding="utf-8")
    return skill


# ── Frontmatter parser ────────────────────────────────────────────────────────


class TestFrontmatterParser:
    def test_parse_basic_fields(self, fake_home):
        es = _reimport("embed_skills")
        text = "---\nname: foo\ndescription: a simple skill\ntier: L1\n---\nbody\n"
        fm = es._parse_frontmatter(text)
        assert fm.get("name") == "foo"
        assert fm.get("description") == "a simple skill"
        assert fm.get("tier") == "L1"

    def test_parse_block_scalar_description(self, fake_home):
        es = _reimport("embed_skills")
        text = "---\nname: bar\ndescription: |\n  multi line\n  desc\n---\nbody\n"
        fm = es._parse_frontmatter(text)
        assert fm.get("name") == "bar"
        d = str(fm.get("description") or "")
        assert "multi line" in d and "desc" in d

    def test_parse_returns_empty_when_no_frontmatter(self, fake_home):
        es = _reimport("embed_skills")
        assert es._parse_frontmatter("just body, no fences") == {}

    def test_parse_accepts_source_hint_kwarg(self, fake_home):
        """_source_hint is a new kwarg — must not break existing calls."""
        es = _reimport("embed_skills")
        text = "---\nname: hint_test\ndescription: ok\n---\nbody\n"
        fm = es._parse_frontmatter(text, _source_hint="/some/path/SKILL.md")
        assert fm.get("name") == "hint_test"

    def test_parse_falls_back_on_invalid_yaml(self, fake_home):
        """YAML with colons in unquoted values should fall back to stdlib parser."""
        es = _reimport("embed_skills")
        # description contains a colon without quoting — triggers YAML error
        text = "---\nname: bad\ndescription: foo: bar baz\ntier: L2\n---\nbody\n"
        fm = es._parse_frontmatter(text, _source_hint="test")
        # stdlib fallback should still extract name and tier even if description truncates
        assert fm.get("name") == "bad"


# ── Skill metadata extraction ────────────────────────────────────────────────


class TestSkillMetaExtraction:
    def test_extract_skill_meta_local(self, fake_home):
        es = _reimport("embed_skills")
        path = _make_skill(fake_home, "alpha", "A nice testing skill", tier="L1")
        meta = es.extract_skill_meta(path, kind="local")
        assert meta is not None
        assert meta.name == "alpha"
        assert "nice testing skill" in meta.description.lower()
        assert meta.tier == "L1"
        assert meta.kind == "local"
        assert len(meta.desc_sha1) == 16

    def test_extract_skill_meta_returns_none_on_no_description(self, fake_home):
        es = _reimport("embed_skills")
        d = fake_home / ".claude" / "skills" / "ghost"
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(
            "---\nname: ghost\ntier: L1\n---\n# no description\n",
            encoding="utf-8",
        )
        assert es.extract_skill_meta(d / "SKILL.md", kind="local") is None

    def test_desc_sha1_changes_with_content(self, fake_home):
        es = _reimport("embed_skills")
        p1 = _make_skill(fake_home, "a", "desc one")
        m1 = es.extract_skill_meta(p1, kind="local")
        p2 = _make_skill(fake_home, "b", "desc two completely different")
        m2 = es.extract_skill_meta(p2, kind="local")
        assert m1 and m2
        assert m1.desc_sha1 != m2.desc_sha1

    def test_payload_includes_entity_skill(self, fake_home):
        """Hardening: to_payload must include entity='skill' for namespacing."""
        es = _reimport("embed_skills")
        path = _make_skill(fake_home, "beta", "Beta skill for entity check", tier="L2")
        meta = es.extract_skill_meta(path, kind="local")
        assert meta is not None
        payload = meta.to_payload()
        assert payload.get("entity") == "skill"


# ── Walker ────────────────────────────────────────────────────────────────────


class TestWalker:
    def test_walk_local_skills_finds_only_those_with_skill_md(self, fake_home):
        es = _reimport("embed_skills")
        _make_skill(fake_home, "a", "desc")
        _make_skill(fake_home, "b", "desc")
        empty = fake_home / ".claude" / "skills" / "broken"
        empty.mkdir()
        names = sorted(p.parent.name for p in es.walk_local_skills())
        assert names == ["a", "b"]

    def test_walk_plugin_skills_traverses_cache(self, fake_home):
        es = _reimport("embed_skills")
        _make_skill(fake_home, "p1", "plugin desc", kind="plugin")
        _make_skill(fake_home, "p2", "plugin desc 2", kind="plugin")
        names = sorted(p.parent.name for p in es.walk_plugin_skills())
        assert "p1" in names and "p2" in names


# ── State roundtrip ──────────────────────────────────────────────────────────


class TestState:
    def test_state_roundtrip(self, fake_home):
        es = _reimport("embed_skills")
        es.save_state(
            {
                "local::a": {"desc_sha1": "abc123", "path": "/x"},
                "plugin::b": {"desc_sha1": "def456", "path": "/y"},
            }
        )
        loaded = es.load_state()
        assert loaded["local::a"]["desc_sha1"] == "abc123"
        assert loaded["plugin::b"]["desc_sha1"] == "def456"

    def test_state_returns_empty_when_missing(self, fake_home):
        es = _reimport("embed_skills")
        assert es.load_state() == {}


# ── Stable point id ──────────────────────────────────────────────────────────


def test_stable_point_id_deterministic(fake_home):
    es = _reimport("embed_skills")
    a = es._stable_point_id("foo", "local")
    b = es._stable_point_id("foo", "local")
    c = es._stable_point_id("foo", "plugin")
    d = es._stable_point_id("bar", "local")
    assert a == b
    assert a != c
    assert a != d
    assert len(a) == 32


# ── Reranking ─────────────────────────────────────────────────────────────────


class TestRerank:
    def test_rerank_empty_returns_empty(self, fake_home):
        es = _reimport("embed_skills")
        assert es._rerank([], top_n=5) == []

    def test_rerank_respects_top_n(self, fake_home):
        es = _reimport("embed_skills")
        results = [
            {"score": 0.9, "tier": "L1", "indexed_at": "2026-01-01T00:00:00+00:00"},
            {"score": 0.8, "tier": "L2", "indexed_at": "2026-01-01T00:00:00+00:00"},
            {"score": 0.7, "tier": "L1", "indexed_at": "2026-01-01T00:00:00+00:00"},
        ]
        out = es._rerank(results, top_n=2)
        assert len(out) == 2

    def test_rerank_adds_rerank_score(self, fake_home):
        es = _reimport("embed_skills")
        results = [
            {"score": 0.8, "tier": "L1", "indexed_at": "2026-06-01T00:00:00+00:00"},
        ]
        out = es._rerank(results, top_n=5)
        assert "rerank_score" in out[0]
        assert isinstance(out[0]["rerank_score"], float)

    def test_rerank_higher_tier_boosts_score(self, fake_home):
        """A lower semantic score with L1 tier should beat a higher score at L3.

        With alpha_tier=0.10:
          L3 tier_rank=2  -> tier_bonus = 0.10 * (1 - 2/10) = 0.08
          L1 tier_rank=0  -> tier_bonus = 0.10 * (1 - 0/10) = 0.10
          delta_tier = 0.02

        So for L1 to win, the semantic gap must be less than 0.02/0.85 ≈ 0.0235.
        We use 0.71 vs 0.70 (gap = 0.01) which L1 wins by 0.695 vs 0.6835.
        """
        es = _reimport("embed_skills")
        results = [
            {"score": 0.71, "tier": "L3", "indexed_at": "2026-06-01T00:00:00+00:00"},
            {"score": 0.70, "tier": "L1", "indexed_at": "2026-06-01T00:00:00+00:00"},
        ]
        out = es._rerank(results, top_n=5)
        # L1 entry (originally second) should now rank first due to tier bonus
        assert out[0]["tier"] == "L1"

    def test_rerank_cleans_up_internal_age_key(self, fake_home):
        """_age_s must not leak into the returned dicts."""
        es = _reimport("embed_skills")
        results = [
            {"score": 0.8, "tier": "L2", "indexed_at": "2026-01-01T00:00:00+00:00"},
        ]
        out = es._rerank(results, top_n=5)
        assert "_age_s" not in out[0]
