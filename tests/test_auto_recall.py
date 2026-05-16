"""Pytest suite for ULTRON v14.8 P1 — auto-recall hook.

Tests validate the static surface + decision logic. Live Qdrant + fastembed
calls are NOT exercised here (they require Docker running + ~1GB ONNX cache);
end-to-end is smoke-tested via Start-Process.

Layout:
  TestStateFile         — first-turn-only fired-sessions tracking (4 cases)
  TestFormatReminder    — system-reminder rendering (2 cases)
  TestKillSwitch        — env var ULTRON_AUTO_RECALL respected (3 cases)
  TestMain              — early-exit paths (slash, short, missing) (4 cases)
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
from pathlib import Path

import pytest


HOOKS_DIR = Path(__file__).resolve().parent.parent / "scripts" / "hooks"


def _load_module(home: Path):
    """Fresh import of auto-recall.py with HOME redirected to `home`."""
    # Pre-create dirs the hook expects
    (home / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        "auto_recall_under_test", HOOKS_DIR / "auto-recall.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path


# ── State file (first-turn-only tracking) ──────────────────────────────────────


class TestStateFile:

    def test_load_fired_returns_empty_when_missing(self, home):
        m = _load_module(home)
        assert m._load_fired() == set()

    def test_save_then_load_roundtrip(self, home):
        m = _load_module(home)
        m._save_fired({"s1", "s2", "s3"})
        loaded = m._load_fired()
        assert loaded == {"s1", "s2", "s3"}

    def test_save_caps_at_200_session_ids(self, home):
        m = _load_module(home)
        # 250 ids
        ids = {f"sess-{i:04d}" for i in range(250)}
        m._save_fired(ids)
        # Re-read file and verify cap
        data = json.loads(m._state_path().read_text(encoding="utf-8"))
        assert len(data["session_ids"]) == 200

    def test_load_fired_handles_corrupted_state(self, home):
        m = _load_module(home)
        m._state_path().parent.mkdir(parents=True, exist_ok=True)
        m._state_path().write_text("not-json{{{", encoding="utf-8")
        assert m._load_fired() == set()


# ── _format_reminder rendering ────────────────────────────────────────────────


class TestFormatReminder:

    def test_format_reminder_lists_paths_and_scores(self, home):
        m = _load_module(home)
        hits = [
            {"path": "/a.md", "score": 0.78, "preview": "alpha note content"},
            {"path": "/b.md", "score": 0.65, "preview": "beta note content"},
        ]
        out = m._format_reminder("test query", hits)
        assert "<ultron-recall>" in out
        assert "</ultron-recall>" in out
        assert "/a.md" in out
        assert "/b.md" in out
        assert "0.78" in out
        assert "0.65" in out
        assert "test query" in out

    def test_format_reminder_truncates_long_previews(self, home):
        m = _load_module(home)
        hits = [{"path": "/x.md", "score": 0.9, "preview": "x" * 1000}]
        out = m._format_reminder("q", hits)
        # Preview capped at 200 chars + "..."
        assert "..." in out
        # Single line in the preview
        assert out.count("xxx") < 1000  # not the full 1000

    def test_format_reminder_includes_skill_section_when_match_provided(self, home):
        """v14.8 P4: skill match section rendered when a skill cleared threshold."""
        m = _load_module(home)
        skill = {
            "name": "senior-engineer",
            "score": 0.71,
            "kind": "local",
            "tier": "L1",
            "description": "Senior full-stack engineer — covers shaders, render pipelines, low-level systems.",
            "tags": ["persona"],
        }
        out = m._format_reminder("explain shaders to me", [], skill_match=skill)
        assert "Suggested skill" in out
        assert "senior-engineer" in out
        assert "0.71" in out
        # Disclaimer instructing the model not to invoke blindly
        assert "ONLY if it actually fits" in out

    def test_format_reminder_skill_only_no_vault_hits(self, home):
        """Reminder must render even when vault returned 0 hits but skill matched."""
        m = _load_module(home)
        skill = {"name": "windows-admin", "score": 0.55, "kind": "local",
                 "tier": "L1", "description": "Windows admin", "tags": []}
        out = m._format_reminder("limpia procesos", [], skill_match=skill)
        assert "no relevant notes" in out
        assert "windows-admin" in out


# ── Kill switch via env ───────────────────────────────────────────────────────


class TestKillSwitch:

    def _invoke_main_with_env(
        self, home, monkeypatch, *, knob_value: str, payload: dict,
    ) -> int:
        m = _load_module(home)
        monkeypatch.setenv("ULTRON_AUTO_RECALL", knob_value)
        stdin_bytes = io.StringIO(json.dumps(payload))
        monkeypatch.setattr(sys, "stdin", stdin_bytes)
        return m.main()

    def test_kill_switch_zero_returns_silent(self, home, monkeypatch):
        rc = self._invoke_main_with_env(
            home, monkeypatch, knob_value="0",
            payload={"prompt": "long enough prompt please", "session_id": "k0"},
        )
        assert rc == 0  # EXIT_SILENT

    def test_kill_switch_off_returns_silent(self, home, monkeypatch):
        rc = self._invoke_main_with_env(
            home, monkeypatch, knob_value="off",
            payload={"prompt": "long enough prompt please", "session_id": "ko"},
        )
        assert rc == 0

    def test_unset_default_attempts_recall(self, home, monkeypatch):
        # The test verifies: when knob is unset (default), the kill switch
        # does NOT bail; the hook traverses through state-tracking.
        # We accept rc=0 (Qdrant unavailable) OR rc=2 (recall succeeded);
        # the contract we test is that "kdef" lands in the fired set.
        m = _load_module(home)
        monkeypatch.delenv("ULTRON_AUTO_RECALL", raising=False)
        stdin_bytes = io.StringIO(json.dumps(
            {"prompt": "long enough prompt please verify", "session_id": "kdef"}
        ))
        monkeypatch.setattr(sys, "stdin", stdin_bytes)
        rc = m.main()
        fired = m._load_fired()
        assert "kdef" in fired, "session id should be tracked once we passed the kill switch"
        assert rc in (0, 2), f"hook returned unexpected exit code {rc}"


# ── Main early-exit paths ─────────────────────────────────────────────────────


class TestMain:

    def _run(self, home, monkeypatch, payload):
        m = _load_module(home)
        monkeypatch.setenv("ULTRON_AUTO_RECALL", "1")
        stdin_bytes = io.StringIO(json.dumps(payload))
        monkeypatch.setattr(sys, "stdin", stdin_bytes)
        return m.main(), m

    def test_slash_command_exits_silent(self, home, monkeypatch):
        rc, m = self._run(home, monkeypatch,
                          {"prompt": "/help me", "session_id": "s1"})
        assert rc == 0
        # Slash bailed BEFORE state-write → fired set unchanged
        assert "s1" not in m._load_fired()

    def test_short_prompt_exits_silent(self, home, monkeypatch):
        rc, m = self._run(home, monkeypatch,
                          {"prompt": "hi", "session_id": "s2"})
        assert rc == 0
        assert "s2" not in m._load_fired()

    def test_missing_session_id_exits_silent(self, home, monkeypatch):
        rc, m = self._run(home, monkeypatch,
                          {"prompt": "long enough prompt please", "session_id": ""})
        assert rc == 0

    def test_already_fired_exits_silent(self, home, monkeypatch):
        m = _load_module(home)
        m._save_fired({"s-already"})
        monkeypatch.setenv("ULTRON_AUTO_RECALL", "1")
        stdin_bytes = io.StringIO(json.dumps(
            {"prompt": "long enough prompt please", "session_id": "s-already"}
        ))
        monkeypatch.setattr(sys, "stdin", stdin_bytes)
        rc = m.main()
        assert rc == 0
