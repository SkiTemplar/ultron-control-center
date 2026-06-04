"""Tests for the deny-secrets PreToolUse hook (v15.5.21).

The hook blocks Read/Edit/Write/Bash access to credential files (.env,
private keys, ~/.ssh/, ~/.aws/credentials, secrets.json). It blocks by
SPECIFIC credential-file patterns, not a generic *secret* substring —
the latter would flag legit code like secrets_scanner.py and blow the
"<1% false positive" target.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parents[1]
HOOK_PATH = SKILL_ROOT / "scripts" / "hooks" / "deny-secrets.py"
VENV_PYTHON = SKILL_ROOT / ".venv" / "Scripts" / "python.exe"
PYTHON_EXE = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable


def _load():
    spec = importlib.util.spec_from_file_location("deny_secrets", HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_hook = _load()


# ── Sensitive paths must be blocked across file tools ──────────────────────────

@pytest.mark.parametrize("path", [
    ".env",
    ".env.local",
    "C:/Users/x/project/.env.production",
    "/home/x/.ssh/id_rsa",
    "C:/Users/x/.ssh/known_hosts",
    "secrets.json",
    "config/credentials.json",
    "deploy/service-account-prod.json",
    "certs/server.pem",
    "build/app.pfx",
    "keys/private.key",
    "C:/Users/x/.aws/credentials",
    "~/.ssh/id_ed25519",
])
def test_blocks_sensitive_path_on_read(path):
    assert _hook.classify("Read", {"file_path": path}) is not None, path


@pytest.mark.parametrize("tool", ["Read", "Edit", "Write"])
def test_blocks_dotenv_across_file_tools(tool):
    assert _hook.classify(tool, {"file_path": ".env"}) is not None


# ── False-positive guards — these MUST NOT be blocked ──────────────────────────

@pytest.mark.parametrize("path", [
    ".env.example",
    ".env.sample",
    ".env.template",
    "scripts/cockpit/secrets_scanner.py",
    "scripts/cockpit/secrets_manager.py",
    "docs/token-budget.md",
    "README.md",
    "config/settings.json",
    "control-center/src/components/Plans.tsx",
])
def test_allows_safe_path(path):
    assert _hook.classify("Read", {"file_path": path}) is None, path


# ── Bash commands that read credential files ───────────────────────────────────

def test_blocks_bash_reading_ssh_key():
    assert _hook.classify("Bash", {"command": "cat ~/.ssh/id_rsa"}) is not None


def test_blocks_bash_reading_dotenv():
    assert _hook.classify("Bash", {"command": "cat .env"}) is not None


def test_allows_innocuous_bash():
    assert _hook.classify("Bash", {"command": "ls -la && git status"}) is None


# ── Tools the hook does not intercept ──────────────────────────────────────────

def test_ignores_non_file_tools():
    assert _hook.classify("Grep", {"pattern": ".env"}) is None


# ── End-to-end subprocess contract ─────────────────────────────────────────────

def _invoke(payload: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        [PYTHON_EXE, str(HOOK_PATH)],
        input=json.dumps(payload).encode("utf-8"),
        capture_output=True, timeout=10,
    )


def test_subprocess_denies_env_read():
    proc = _invoke({"hook_event_name": "PreToolUse", "tool_name": "Read",
                    "tool_input": {"file_path": ".env"}})
    assert proc.returncode == 0
    out = json.loads(proc.stdout.decode("utf-8"))
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_subprocess_silent_on_safe_read():
    proc = _invoke({"hook_event_name": "PreToolUse", "tool_name": "Read",
                    "tool_input": {"file_path": "README.md"}})
    assert proc.returncode == 0
    assert proc.stdout.decode("utf-8").strip() == ""
