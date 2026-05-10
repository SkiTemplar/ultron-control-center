#!/usr/bin/env python3
"""ULTRON HOOK · prompt-feedback-capture · v14.5 META-PROMPTER Phase 2.

Captures Skill tool outputs for the prompt-improver feedback corpus. Runs as
PostToolUse hook for matcher=Skill (separate from routing-telemetry which
records the dispatch event without the output body).

Output shape (per JSONL line in ~/.ultron/.tmp/prompt-feedback.jsonl):
  {
    "ts": "2026-05-08T18:30:00+00:00",
    "session_id": "abc123",
    "kind": "sample",
    "target": "<skill-name>",
    "output": "<truncated + PII-filtered text>",
    "output_chars": 12345,
    "output_sha1": "deadbeef..."
  }

Anti-laundering invariants:
  * Never modifies the tool output that goes to the model.
  * PII filter strips emails, common API key patterns, Windows usernames in
    absolute paths.
  * Output truncated to MAX_CAPTURED_CHARS (default 4000) — enough to feed the
    improver, small enough to avoid log bloat.
  * stdout is empty on success — the hook NEVER injects anything into the
    conversation context.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

MAX_CAPTURED_CHARS = 4000

_FEEDBACK_FILE = Path.home() / ".ultron" / ".tmp" / "prompt-feedback.jsonl"

# PII filter — covers the common offenders. Not a complete privacy guarantee.
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_API_KEY_RE = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|"
    r"AKIA[0-9A-Z]{16}|xoxb-[0-9A-Za-z-]{20,})\b"
)
_USER_PATH_RE = re.compile(
    r"(?:[A-Za-z]:[\\/])?(?:Users|home)[\\/](\w+)",
)


def pii_filter(text: str) -> str:
    if not text:
        return ""
    out = _EMAIL_RE.sub("<email>", text)
    out = _API_KEY_RE.sub("<key>", out)
    # Replace usernames in paths with <user>; preserves structure for debug
    out = _USER_PATH_RE.sub(lambda m: m.group(0).replace(m.group(1), "<user>"), out)
    return out


def _flatten_response(tool_response: object) -> str:
    """Best-effort string from tool_response of various shapes."""
    if tool_response is None:
        return ""
    if isinstance(tool_response, str):
        return tool_response
    if isinstance(tool_response, list):
        parts = []
        for item in tool_response:
            if isinstance(item, dict):
                parts.append(item.get("text") or json.dumps(item, ensure_ascii=False))
            else:
                parts.append(str(item))
        return "\n".join(parts)
    if isinstance(tool_response, dict):
        for key in ("text", "content", "output", "result"):
            v = tool_response.get(key)
            if isinstance(v, str):
                return v
        return json.dumps(tool_response, ensure_ascii=False)
    return str(tool_response)


def main() -> int:
    try:
        data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        return 0

    if data.get("tool_name") != "Skill":
        return 0
    target = (data.get("tool_input") or {}).get("skill")
    if not target:
        return 0

    raw = _flatten_response(data.get("tool_response"))
    if not raw:
        return 0

    filtered = pii_filter(raw)
    if len(filtered) > MAX_CAPTURED_CHARS:
        filtered = filtered[:MAX_CAPTURED_CHARS] + "...[truncated]"

    sha1 = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "session_id": data.get("session_id") or "?",
        "kind": "sample",
        "target": target,
        "output": filtered,
        "output_chars": len(raw),
        "output_sha1": sha1,
    }

    _FEEDBACK_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        with _FEEDBACK_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
