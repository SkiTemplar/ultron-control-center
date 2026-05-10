"""Shared pytest helpers for hook tests.

Each hook is invoked as a subprocess (mirrors Claude Code's PreToolUse/PostToolUse
contract: JSON via stdin, optional JSON response via stdout). We don't import the
hook modules directly because they're CLI scripts that call sys.exit().
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

HOOKS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "hooks"

BLOCK_BASH_HOOK    = HOOKS_DIR / "block-dangerous-bash.py"
AUTO_APPROVE_HOOK  = HOOKS_DIR / "auto-approve-readonly.py"


def _run_hook(hook_path: Path, payload: dict) -> dict | None:
    """Invoke a hook with a JSON stdin payload. Return parsed stdout dict or None.

    Returns None if hook produces no output (== allow / abstain in Claude Code
    permission semantics).
    """
    result = subprocess.run(
        [sys.executable, str(hook_path)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=5,
    )
    if not result.stdout.strip():
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        pytest.fail(
            f"Hook {hook_path.name} returned non-JSON stdout:\n{result.stdout}"
        )
        return None


def _decision(response: dict | None) -> str:
    """Extract permissionDecision from hook response. 'abstain' if no output."""
    if response is None:
        return "abstain"
    return (
        response.get("hookSpecificOutput", {}).get("permissionDecision", "abstain")
    )


@pytest.fixture
def block_bash():
    """Returns (command:str) -> 'allow' | 'deny' | 'abstain'."""
    def _check(command: str) -> str:
        payload = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": command},
        }
        return _decision(_run_hook(BLOCK_BASH_HOOK, payload))
    return _check


@pytest.fixture
def auto_approve():
    """Returns (tool:str, tool_input:dict) -> 'allow' | 'deny' | 'abstain'."""
    def _check(tool: str, tool_input: dict) -> str:
        payload = {
            "hook_event_name": "PreToolUse",
            "tool_name": tool,
            "tool_input": tool_input,
        }
        return _decision(_run_hook(AUTO_APPROVE_HOOK, payload))
    return _check
