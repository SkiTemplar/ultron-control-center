#!/usr/bin/env python3
"""ULTRON validate-push hook.

PreToolUse matcher: Bash. Intercepts attempts to force-push to a protected
branch (main / master / release/*) and blocks them. Anything else passes
through untouched. Designed to coexist with block-dangerous-bash.py — that
hook handles `rm -rf /`-style suicide commands; this one handles git
specifically.

Block decision: exit 2 with a one-line stderr message. Claude Code treats
exit 2 from a PreToolUse hook as a hard refusal — the Bash tool call is
cancelled and the assistant sees the stderr.
"""
from __future__ import annotations

import json
import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

PROTECTED_BRANCHES = {"main", "master", "release", "production"}

# Permissive matchers — we want to catch every form the user might type.
# `git push -f`, `git push --force`, `git push --force-with-lease`, etc.
FORCE_FLAG_RE = re.compile(
    r"(?<!\S)(--force(?:-with-lease)?|-f)(?!\S)",
    re.IGNORECASE,
)
GIT_PUSH_RE = re.compile(r"(?<!\S)git\s+push(?!\S)", re.IGNORECASE)


def _extract_cmd(payload: dict) -> str:
    tool_input = payload.get("tool_input") or payload.get("toolInput") or {}
    if isinstance(tool_input, dict):
        cmd = tool_input.get("command") or tool_input.get("cmd") or ""
        if isinstance(cmd, str):
            return cmd
    if isinstance(payload.get("command"), str):
        return payload["command"]  # legacy shape
    return ""


def _mentions_protected_branch(cmd: str) -> bool:
    # Tokenise naively — sufficient for the patterns we care about.
    tokens = re.split(r"\s+", cmd.strip())
    for tok in tokens:
        # Strip leading refs/heads/ if the user spelled it out.
        bare = tok.split(":", 1)[-1]  # local:remote -> remote
        bare = bare.removeprefix("refs/heads/").lower()
        if bare in PROTECTED_BRANCHES:
            return True
        # release/foo, production/bar
        if "/" in bare and bare.split("/", 1)[0] in PROTECTED_BRANCHES:
            return True
    return False


def main() -> int:
    try:
        raw = sys.stdin.read()
    except Exception:  # noqa: BLE001
        raw = ""
    if not raw.strip():
        return 0

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return 0  # not a JSON payload — nothing to validate

    cmd = _extract_cmd(payload)
    if not cmd:
        return 0
    if not GIT_PUSH_RE.search(cmd):
        return 0
    if not FORCE_FLAG_RE.search(cmd):
        return 0
    if not _mentions_protected_branch(cmd):
        # force push to a feature branch is fine — common pattern.
        return 0

    sys.stderr.write(
        "[ULTRON validate-push] Blocked: force-push to a protected branch "
        "(main/master/release/production). If this is intentional, run the "
        "git command yourself in an external terminal so the hook can't "
        "see it, or temporarily disable this hook in "
        "~/.claude/settings.json.\n"
    )
    # Also log to the alerts bus if available.
    try:
        sys.path.insert(0, os.path.expanduser("~/.ultron/scripts/cockpit"))
        import alerts as _alerts  # type: ignore[import-not-found]
        _alerts.write_dedupe(
            "warn",
            "validate_push",
            f"force-push to protected branch blocked: {cmd[:200]}",
            dedupe_tag="validate_push_force",
            window_seconds=60,
            tags=["git", "security"],
        )
    except Exception:  # noqa: BLE001
        pass
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        try:
            sys.stderr.write(f"[validate_push] non-fatal error: {exc}\n")
        except Exception:  # noqa: BLE001
            pass
        sys.exit(0)
