"""Pytest suite for ULTRON v14.8 P2 — system_snapshot + validate_full_system.

Layout:
  TestSystemSnapshot      — collectors, render_md, atomic write (8 cases)
  TestValidator           — verdict aggregation, MD render, dispatch (5 cases)
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
    (tmp_path / ".claude" / "skills" / "ultron").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path


def _reimport(name: str):
    if name in sys.modules:
        del sys.modules[name]
    return importlib.import_module(name)


# ── system_snapshot ────────────────────────────────────────────────────────────


class TestSystemSnapshot:

    def test_read_json_safe_handles_bom(self, fake_home):
        ss = _reimport("system_snapshot")
        f = fake_home / "with-bom.json"
        # Write BOM + JSON like PowerShell does
        f.write_text("﻿" + '{"hello": "world"}', encoding="utf-8")
        data = ss._read_json_safe(f)
        assert data == {"hello": "world"}

    def test_collect_version_reads_skill_md_frontmatter(self, fake_home):
        ss = _reimport("system_snapshot")
        skill = fake_home / ".claude" / "skills" / "ultron" / "SKILL.md"
        skill.write_text(
            "---\nname: ultron\nversion: v99.42.7\n---\n# body\n",
            encoding="utf-8",
        )
        out = ss.collect_version()
        assert out["version"] == "v99.42.7"

    def test_collect_version_reports_error_when_missing(self, fake_home):
        ss = _reimport("system_snapshot")
        out = ss.collect_version()
        assert "error" in out

    def test_collect_mode_uses_default_when_no_file(self, fake_home):
        ss = _reimport("system_snapshot")
        out = ss.collect_mode()
        assert out["mode"] == "MEDIUM"
        assert out["source"] == "default"

    def test_collect_mode_reads_state_file(self, fake_home):
        ss = _reimport("system_snapshot")
        f = fake_home / ".ultron" / ".tmp" / "current-session-mode.json"
        f.write_text(json.dumps({"mode": "ULTRA"}), encoding="utf-8")
        out = ss.collect_mode()
        assert out["mode"] == "ULTRA"
        assert out["source"] == "file"

    def test_collect_recall_handles_missing_file(self, fake_home):
        ss = _reimport("system_snapshot")
        out = ss.collect_recall()
        assert out["present"] is False

    def test_collect_recall_extracts_top_hit(self, fake_home):
        ss = _reimport("system_snapshot")
        f = fake_home / ".ultron" / ".tmp" / "last-recall.json"
        f.write_text(json.dumps({
            "captured_at": "2026-05-09T00:00:00",
            "query": "test query",
            "hits": [
                {"path": "/x.md", "score": 0.78, "preview": "x"},
                {"path": "/y.md", "score": 0.65, "preview": "y"},
            ],
        }), encoding="utf-8")
        out = ss.collect_recall()
        assert out["present"] is True
        assert out["hits_count"] == 2
        assert out["top_score"] == 0.78
        assert out["top_path"] == "/x.md"

    def test_render_md_under_token_budget(self, fake_home):
        ss = _reimport("system_snapshot")
        # Synthetic full snapshot
        data = {
            "captured_at": "2026-05-09T00:00:00",
            "version": {"version": "v14.8.0"},
            "mode": {"mode": "MEDIUM"},
            "git": {"sha": "abc1234", "branch": "main", "subject": "test", "dirty": False},
            "qdrant": {"reachable": True, "ultron_vault_points": 267, "collections": ["ultron_vault"]},
            "brain": {"present": True, "notes": 684, "db_size_kb": 24544},
            "skills": {"skills_on": 19, "skills_name_only": 361, "mode": "lazy"},
            "backup": {"sources_ok": "1/5", "age_h": 4.2, "never_run": False},
            "recall": {"present": True, "top_score": 0.58, "top_path": "/path/to/note.md"},
            "doctor": {"blocking": 0, "warn": 174, "info": 2},
            "cache": {"hit_rate": 0.967, "verdict": "pass", "turns": 18000},
        }
        md = ss.render_md(data)
        # Sanity checks
        assert "v14.8.0" in md
        assert "267" in md
        assert "684" in md
        assert "0.58" in md
        # Token budget — must fit comfortably under 200 tokens
        try:
            import tiktoken
            n = len(tiktoken.get_encoding("cl100k_base").encode(md))
            assert n < 200, f"snapshot MD has {n} tokens, exceeds 200 budget"
        except ImportError:
            pytest.skip("tiktoken unavailable")


# ── validate_full_system ───────────────────────────────────────────────────────


class TestValidator:

    def test_verdict_aggregation_pass_when_all_pass(self, fake_home):
        v = _reimport("validate_full_system")
        rep = v.SubsystemReport(name="x", checks=[
            v.CheckResult(name="a", verdict="pass"),
            v.CheckResult(name="b", verdict="pass"),
        ])
        assert rep.verdict == "pass"

    def test_verdict_aggregation_fail_dominates(self, fake_home):
        v = _reimport("validate_full_system")
        rep = v.SubsystemReport(name="x", checks=[
            v.CheckResult(name="a", verdict="pass"),
            v.CheckResult(name="b", verdict="fail"),
            v.CheckResult(name="c", verdict="warn"),
        ])
        assert rep.verdict == "fail"

    def test_verdict_aggregation_warn_when_no_fail(self, fake_home):
        v = _reimport("validate_full_system")
        rep = v.SubsystemReport(name="x", checks=[
            v.CheckResult(name="a", verdict="pass"),
            v.CheckResult(name="b", verdict="warn"),
        ])
        assert rep.verdict == "warn"

    def test_render_md_includes_all_subsystems(self, fake_home):
        v = _reimport("validate_full_system")
        data = {
            "captured_at": "2026-05-09T00:00:00",
            "global_verdict": "pass",
            "checks_summary": {"pass": 3, "warn": 0, "fail": 0},
            "elapsed_s": 1.0,
            "subsystems": [
                {"name": "prompting", "verdict": "pass", "checks": [
                    {"name": "x", "verdict": "pass", "detail": "ok"},
                ]},
                {"name": "memory", "verdict": "pass", "checks": [
                    {"name": "y", "verdict": "pass", "detail": "ok"},
                ]},
                {"name": "skills", "verdict": "pass", "checks": [
                    {"name": "z", "verdict": "pass", "detail": "ok"},
                ]},
            ],
        }
        out = v.render_md(data)
        assert "prompting" in out
        assert "memory" in out
        assert "skills" in out
        assert "PASS" in out
        assert "✅" in out

    def test_timed_wraps_exception_as_fail(self, fake_home):
        v = _reimport("validate_full_system")

        def boom():
            raise RuntimeError("test failure")

        result = v._timed("test_check", boom)
        assert result.verdict == "fail"
        assert "RuntimeError" in result.error
