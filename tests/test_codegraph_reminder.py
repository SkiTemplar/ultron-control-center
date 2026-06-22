"""Pytest suite for hooks/scripts/codegraph-reminder.js behaviour.

The PreToolUse CodeGraph nudge must fire BEFORE the agent explores the tree or
reads code blind, so it has to cover the tools an agent actually uses to locate
things: Read, Grep, Glob and the blind-exploration Bash commands (find/ls/grep/
rg/cat/head/tail/...). It must NOT fire on build/run Bash (cargo/npm/git/...) or
on non-code Read (.md/.json) — that would be noise.

Root cause it guards (session 2026-06-22): the nudge used to match only
`Read|Grep`, so an agent that located a file via `Glob cockpit/projects/**` +
`ls` got no nudge and explored the filesystem by hand instead of using the
CodeGraph index that already had the answer.

These are hermetic: each case uses a unique session_id (the nudge fires once per
session via a tmp marker) and the markers are cleaned up afterwards.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import uuid
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
HOOK = REPO_ROOT / "hooks" / "scripts" / "codegraph-reminder.js"
# REPO_ROOT is ~/.ultron, which the hook treats as having a global CodeGraph
# index (the `underUltron` check), so any target under it is "applicable".
ULTRON = str(REPO_ROOT)


def _run_hook(tool_name: str, tool_input: dict, session_id: str | None = None,
              cwd: str = ULTRON) -> tuple[str, str]:
    sid = session_id or f"test-{uuid.uuid4().hex}"
    payload = json.dumps({
        "tool_name": tool_name,
        "tool_input": tool_input,
        "cwd": cwd,
        "session_id": sid,
    })
    r = subprocess.run(
        ["node", str(HOOK)],
        input=payload, capture_output=True, text=True, timeout=20,
    )
    return r.stdout, sid


def _fired(stdout: str) -> bool:
    s = (stdout or "").strip()
    if not s:
        return False
    try:
        out = json.loads(s)
    except json.JSONDecodeError:
        return False
    ctx = (out.get("hookSpecificOutput", {}) or {}).get("additionalContext", "") or ""
    return "CodeGraph" in ctx


@pytest.fixture(autouse=True, scope="module")
def _cleanup_markers():
    yield
    tmp = Path(tempfile.gettempdir())
    for m in tmp.glob("ultron-cg-reminder-test-*"):
        try:
            m.unlink()
        except OSError:
            pass


# --- positive: tools used to locate/read code blind should nudge -------------

def test_glob_fires():
    out, _ = _run_hook("Glob", {"pattern": "**/*.rs", "path": ULTRON})
    assert _fired(out)


def test_bash_find_fires():
    out, _ = _run_hook("Bash", {"command": "find cockpit/projects -name kanban.json"})
    assert _fired(out)


def test_bash_ls_fires():
    out, _ = _run_hook("Bash", {"command": "ls -la cockpit/projects/"})
    assert _fired(out)


def test_bash_grep_fires():
    out, _ = _run_hook("Bash", {"command": "grep -rn orchestrate_prompt control-center/src"})
    assert _fired(out)


def test_read_code_fires():
    out, _ = _run_hook("Read", {"file_path": ULTRON + "/control-center/src-tauri/src/lib.rs"})
    assert _fired(out)


# --- negative: build/run Bash and non-code Read must stay silent --------------

def test_bash_cargo_does_not_fire():
    out, _ = _run_hook("Bash", {"command": "cargo test --lib --quiet"})
    assert not _fired(out)


def test_bash_git_does_not_fire():
    out, _ = _run_hook("Bash", {"command": "git status --short"})
    assert not _fired(out)


def test_bash_cargo_piped_to_tail_does_not_fire():
    # A trailing `| tail` is post-processing, not blind exploration.
    out, _ = _run_hook("Bash", {"command": "cargo test --lib | tail -5"})
    assert not _fired(out)


def test_read_markdown_does_not_fire():
    out, _ = _run_hook("Read", {"file_path": ULTRON + "/README.md"})
    assert not _fired(out)


def test_glob_outside_index_does_not_fire():
    out, _ = _run_hook("Glob", {"pattern": "*.txt", "path": "C:/Windows/Temp"},
                       cwd="C:/Windows/Temp")
    assert not _fired(out)


# --- once-per-session de-dup (anti-spam = quality) ---------------------------

def test_once_per_session():
    out1, sid = _run_hook("Glob", {"path": ULTRON})
    out2, _ = _run_hook("Glob", {"path": ULTRON}, session_id=sid)
    assert _fired(out1)
    assert not _fired(out2)
