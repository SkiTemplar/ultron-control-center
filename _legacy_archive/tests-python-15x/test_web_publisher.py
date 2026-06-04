"""Pytest suite for ULTRON v14.8 — web_publisher.py.

Tests the rule engine, render_replacement, and apply_substitutions on
isolated tmp_path fixtures so CI never touches the real ~/.ultron/web/.
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
def fake_home(tmp_path, monkeypatch):
    (tmp_path / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".ultron" / "web").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path


def _reimport(name: str):
    if name in sys.modules:
        del sys.modules[name]
    return importlib.import_module(name)


def _write_snapshot(home: Path, **fields) -> None:
    f = home / ".ultron" / ".tmp" / "system-snapshot.json"
    payload = {
        "version": {"version": fields.get("version", "v99.0.0")},
        "brain": {"notes": fields.get("notes", 100)},
        "qdrant": {"ultron_vault_points": fields.get("vectors", 50)},
        "cache": {"hit_rate": fields.get("hit_rate", 0.95)},
        "git": {"sha": "abc1234", "branch": "main"},
    }
    f.write_text(json.dumps(payload), encoding="utf-8")


def _write_index(home: Path, body: str) -> None:
    (home / ".ultron" / "web" / "index.html").write_text(body, encoding="utf-8")


# ── render_replacement ────────────────────────────────────────────────────────


class TestRenderReplacement:

    def test_returns_none_when_field_value_missing(self, fake_home):
        wp = _reimport("web_publisher")
        state = wp.WebState(
            version="", tests_passing=None, notes_indexed=None,
            vault_vectors=None, cache_hit_rate_pct=None,
            release_date="", git_sha="", git_branch="",
        )
        rule = wp.Rule(label="x", pattern=r".", template="{value}", field="version")
        assert wp.render_replacement(rule, state) is None

    def test_returns_template_with_state_fields(self, fake_home):
        wp = _reimport("web_publisher")
        state = wp.WebState(
            version="v9.0.0", tests_passing=42, notes_indexed=100,
            vault_vectors=50, cache_hit_rate_pct=99.0,
            release_date="2026-12-31", git_sha="def", git_branch="main",
        )
        rule = wp.Rule(
            label="combo", pattern=r"x", template="{value} and {release_date}",
            field="version",
        )
        out = wp.render_replacement(rule, state)
        assert out == "v9.0.0 and 2026-12-31"


# ── apply_substitutions ───────────────────────────────────────────────────────


class TestApplySubstitutions:

    def test_dry_run_does_not_write(self, fake_home):
        wp = _reimport("web_publisher")
        _write_snapshot(fake_home, version="v9.9.9", notes=999)
        original = (
            '<title>ULTRON Genesis · v1.0.0</title>\n'
            '<span class="brand">ULTRON <span class="mono dim">v1.0.0</span></span>\n'
        )
        _write_index(fake_home, original)
        report = wp.apply_substitutions(dry_run=True)
        # Some rules should match
        assert report.rules_applied
        # File contents unchanged
        index = fake_home / ".ultron" / "web" / "index.html"
        assert index.read_text(encoding="utf-8") == original
        # No backup created
        assert not (fake_home / ".ultron" / "web" / "index.html.bak").exists()

    def test_apply_creates_backup_and_updates(self, fake_home):
        wp = _reimport("web_publisher")
        _write_snapshot(fake_home, version="v9.9.9", notes=999)
        original = (
            '<title>ULTRON Genesis · v1.0.0</title>\n'
            '<span class="brand">ULTRON <span class="mono dim">v1.0.0</span></span>\n'
            '<span class="version mono">v1.0.0</span>\n'
            '<span>123 tests passing</span>\n'
            '<span>50 notes indexed</span>\n'
        )
        _write_index(fake_home, original)
        report = wp.apply_substitutions(dry_run=False)

        index = fake_home / ".ultron" / "web" / "index.html"
        bak = index.with_suffix(".html.bak")

        assert bak.exists()
        assert bak.read_text(encoding="utf-8") == original
        new = index.read_text(encoding="utf-8")
        assert "v9.9.9" in new
        assert "999 notes indexed" in new
        assert "v1.0.0" not in new

    def test_does_nothing_when_index_missing(self, fake_home):
        wp = _reimport("web_publisher")
        _write_snapshot(fake_home)
        report = wp.apply_substitutions(dry_run=True)
        assert report.rules_applied == []

    def test_no_match_rules_listed_separately(self, fake_home):
        wp = _reimport("web_publisher")
        _write_snapshot(fake_home, version="v9.9.9")
        # HTML missing every targeted pattern
        _write_index(fake_home, "<p>nothing matches here</p>\n")
        report = wp.apply_substitutions(dry_run=True)
        assert report.rules_applied == []
        assert report.rules_no_match  # at least some patterns scanned with no hit


# ── Smoke ────────────────────────────────────────────────────────────────────


def test_collect_state_returns_dataclass(fake_home):
    wp = _reimport("web_publisher")
    state = wp.collect_state()
    assert hasattr(state, "version")
    assert hasattr(state, "release_date")
    # Fallback when no snapshot present
    assert state.version != ""
