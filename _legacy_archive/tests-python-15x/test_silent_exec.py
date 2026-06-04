"""Pytest suite for silent_exec wrapper (cockpit/silent_exec.py).

Tests run the wrapper against simple shell commands and inspect the kwargs that
end up reaching subprocess. We monkeypatch ``subprocess.run`` / ``subprocess.Popen``
to capture the merged kwargs without actually spawning where it adds no value.
"""
from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path

import pytest

# Make the cockpit dir importable.
COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))


@pytest.fixture
def silent_exec_module(monkeypatch):
    """Fresh import each test so the ULTRON_DEBUG check re-evaluates."""
    monkeypatch.delenv("ULTRON_DEBUG", raising=False)
    if "silent_exec" in sys.modules:
        del sys.modules["silent_exec"]
    return importlib.import_module("silent_exec")


def test_silent_run_executes_command(silent_exec_module):
    """End-to-end: silent_run actually runs a command and captures output silently."""
    cmd = ["cmd", "/c", "echo hi"] if sys.platform == "win32" else ["echo", "hi"]
    result = silent_exec_module.silent_run(cmd, text=True)
    assert isinstance(result, subprocess.CompletedProcess)
    assert result.returncode == 0
    # capture_output=True default → stdout populated, not None
    assert result.stdout is not None
    assert "hi" in result.stdout


def test_silent_run_adds_creationflags_on_windows(silent_exec_module, monkeypatch):
    """Default kwargs include CREATE_NO_WINDOW + capture_output on Windows."""
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(silent_exec_module.subprocess, "run", fake_run)
    silent_exec_module.silent_run(["whatever"])

    if sys.platform == "win32":
        assert "creationflags" in captured["kwargs"]
        assert captured["kwargs"]["creationflags"] & silent_exec_module.CREATE_NO_WINDOW
    assert captured["kwargs"].get("capture_output") is True


def test_ultron_debug_disables_silencing(silent_exec_module, monkeypatch):
    """ULTRON_DEBUG=1 → no creationflags, no capture_output added."""
    monkeypatch.setenv("ULTRON_DEBUG", "1")
    # is_debug reads env at call time, not import time — no need to reimport
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(silent_exec_module.subprocess, "run", fake_run)
    silent_exec_module.silent_run(["whatever"])

    assert "creationflags" not in captured["kwargs"]
    assert "capture_output" not in captured["kwargs"]


def test_caller_kwargs_override_defaults(silent_exec_module, monkeypatch):
    """Caller-supplied capture_output=False is preserved (caller wins)."""
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(silent_exec_module.subprocess, "run", fake_run)
    silent_exec_module.silent_run(["whatever"], capture_output=False)

    # Caller-provided value must survive intact.
    assert captured["kwargs"]["capture_output"] is False


def test_silent_popen_default_pipes(silent_exec_module, monkeypatch):
    """silent_popen defaults to stdout=PIPE, stderr=PIPE on Windows."""
    captured: dict = {}

    class FakePopen:
        def __init__(self, cmd, **kwargs):
            captured["kwargs"] = kwargs

    monkeypatch.setattr(silent_exec_module.subprocess, "Popen", FakePopen)
    silent_exec_module.silent_popen(["whatever"])

    assert captured["kwargs"].get("stdout") == subprocess.PIPE
    assert captured["kwargs"].get("stderr") == subprocess.PIPE
    if sys.platform == "win32":
        assert "creationflags" in captured["kwargs"]
        assert captured["kwargs"]["creationflags"] & silent_exec_module.CREATE_NO_WINDOW


# ─── Regression tests for Codex peer-review fixes (v4.4) ─────────────────────

def test_caller_creationflags_zero_is_preserved(silent_exec_module, monkeypatch):
    """Codex bug #1: creationflags=0 from caller must win, not be OR'd into CREATE_NO_WINDOW."""
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(silent_exec_module.subprocess, "run", fake_run)
    silent_exec_module.silent_run(["whatever"], creationflags=0)

    # Caller said "no flags" → must be 0, NOT CREATE_NO_WINDOW.
    assert captured["kwargs"]["creationflags"] == 0


def test_silent_popen_capture_output_true_translates_to_pipe(silent_exec_module, monkeypatch):
    """Codex bug #2 (part 1): capture_output=True must be translated, never reach Popen."""
    captured: dict = {}

    class FakePopen:
        def __init__(self, cmd, **kwargs):
            captured["kwargs"] = kwargs

    monkeypatch.setattr(silent_exec_module.subprocess, "Popen", FakePopen)
    silent_exec_module.silent_popen(["whatever"], capture_output=True)

    # capture_output must NOT be in the kwargs that reach Popen (Popen rejects it).
    assert "capture_output" not in captured["kwargs"]
    # And it must have been translated to PIPE pair.
    assert captured["kwargs"].get("stdout") == subprocess.PIPE
    assert captured["kwargs"].get("stderr") == subprocess.PIPE


def test_silent_popen_capture_output_under_debug_does_not_raise(silent_exec_module, monkeypatch):
    """Codex bug #2 (part 2): ULTRON_DEBUG=1 + capture_output=True must NOT TypeError."""
    monkeypatch.setenv("ULTRON_DEBUG", "1")
    captured: dict = {}

    class FakePopen:
        def __init__(self, cmd, **kwargs):
            captured["kwargs"] = kwargs

    monkeypatch.setattr(silent_exec_module.subprocess, "Popen", FakePopen)
    # Pre-fix this raised TypeError because capture_output reached Popen.
    silent_exec_module.silent_popen(["whatever"], capture_output=True)

    assert "capture_output" not in captured["kwargs"]
    # Under debug we still translate the truthy capture_output to PIPE pair
    # (consistent semantics regardless of debug).
    assert captured["kwargs"].get("stdout") == subprocess.PIPE


def test_caller_stdout_only_not_overridden(silent_exec_module, monkeypatch):
    """If caller sets stdout (only), wrapper must not also set stderr from defaults."""
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(silent_exec_module.subprocess, "run", fake_run)
    silent_exec_module.silent_run(["whatever"], stdout=subprocess.DEVNULL)

    assert captured["kwargs"]["stdout"] == subprocess.DEVNULL
    # capture_output must NOT have been added — caller explicitly redirected.
    assert "capture_output" not in captured["kwargs"]


def test_audit_detects_aliased_subprocess_imports(tmp_path, monkeypatch):
    """Codex bug #4: from subprocess import run → run(...) must be flagged."""
    monkeypatch.delenv("ULTRON_DEBUG", raising=False)
    if "audit_silent_exec" in sys.modules:
        del sys.modules["audit_silent_exec"]
    audit = importlib.import_module("audit_silent_exec")

    sample = tmp_path / "sample.py"
    sample.write_text(
        "from subprocess import run, Popen as P\n"
        "run(['echo', 'hi'])\n"
        "P(['sleep', '5'])\n",
        encoding="utf-8",
    )

    hits = audit._audit_python(sample)
    kinds = sorted(h["kind"] for h in hits)
    assert kinds == ["subprocess.Popen", "subprocess.run"], f"got {hits}"
