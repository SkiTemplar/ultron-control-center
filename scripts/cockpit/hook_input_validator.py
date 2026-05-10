"""ULTRON v14 Sprint 5-C — Hook Input Validator.

Each Claude Code hook event has a known JSON shape. Untrusted input from
tools, MCP responses or even malformed payloads can carry control chars,
embedded null bytes, or deeply-nested JSON bombs. This module validates
the stdin payload BEFORE the hook business logic touches it.

USAGE
-----
    from hook_input_validator import safe_load_stdin
    payload = safe_load_stdin("PreToolUse")
    if payload is None:
        sys.exit(0)         # silent drop on bad input — hooks always exit 0

DESIGN INVARIANTS
-----------------
1. NEVER raises in the public API. `validate()` returns ValidationResult,
   `safe_load_stdin()` returns dict | None.
2. All hooks MUST exit 0 — failures route to alerts.write_dedupe.
3. Strict UUID-ish session_id (we accept 8-4-4-4-12 hex with dashes; some
   harness builds use a more relaxed format so we also accept any
   alnum/dash string up to 64 chars as a fallback).
4. Cap string lengths (default 1MB prompt, 100KB others). JSON nesting cap
   = 10 levels.
"""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_COCKPIT_DIR = Path(__file__).resolve().parent
if str(_COCKPIT_DIR) not in sys.path:
    sys.path.insert(0, str(_COCKPIT_DIR))

try:
    import alerts as _alerts  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001
    _alerts = None  # type: ignore[assignment]


MAX_PROMPT_LEN = 1024 * 1024     # 1 MB
MAX_STRING_LEN = 100 * 1024      # 100 KB
MAX_NESTING_DEPTH = 10
MAX_TOOL_NAME = 200

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_RELAXED_SESSION_RE = re.compile(r"^[A-Za-z0-9_\-]{1,128}$")
_TOOL_NAME_RE = re.compile(
    r"^(?:[A-Za-z][A-Za-z0-9_]{0,200}|"
    r"mcp__[a-zA-Z0-9_]+__[a-zA-Z0-9_\-]+)$"
)
_HOOK_EVENT_NAMES = (
    "UserPromptSubmit", "PreToolUse", "PostToolUse",
    "Stop", "SessionStart", "Notification", "SubagentStop",
)


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

@dataclass
class ValidationResult:
    ok: bool
    payload: dict[str, Any] | None = None
    errors: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Sanitization helpers
# ---------------------------------------------------------------------------

# Allow \n and \t inside strings; everything else <0x20 is stripped.
_STRIP_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _sanitize_string(s: str, max_len: int) -> tuple[str | None, list[str]]:
    """Return (cleaned, errors). Cleaned is None if string is unrecoverable."""
    errs: list[str] = []
    if "\x00" in s:
        return None, ["null_byte_in_string"]
    cleaned = _STRIP_CTRL.sub("", s)
    if len(cleaned) > max_len:
        errs.append(f"string_too_long:{len(cleaned)}>{max_len}")
        cleaned = cleaned[:max_len]
    return cleaned, errs


def _check_depth(node: Any, depth: int = 0) -> bool:
    if depth > MAX_NESTING_DEPTH:
        return False
    if isinstance(node, dict):
        return all(_check_depth(v, depth + 1) for v in node.values())
    if isinstance(node, list):
        return all(_check_depth(v, depth + 1) for v in node)
    return True


def _sanitize_tree(node: Any, max_len: int) -> tuple[Any, list[str]]:
    """Recursively sanitize string values in a JSON tree. Drop control chars,
    cap lengths, reject null bytes (returning the parent error)."""
    errs: list[str] = []
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for k, v in node.items():
            if not isinstance(k, str):
                errs.append("non_string_key")
                continue
            new_v, sub_errs = _sanitize_tree(v, max_len)
            errs.extend(sub_errs)
            out[k] = new_v
        return out, errs
    if isinstance(node, list):
        new_list = []
        for item in node:
            new_v, sub_errs = _sanitize_tree(item, max_len)
            errs.extend(sub_errs)
            new_list.append(new_v)
        return new_list, errs
    if isinstance(node, str):
        cleaned, sub_errs = _sanitize_string(node, max_len)
        errs.extend(sub_errs)
        return cleaned if cleaned is not None else "", errs
    return node, errs


# ---------------------------------------------------------------------------
# Schemas — minimal hand-rolled validators (no jsonschema dep needed)
# ---------------------------------------------------------------------------

def _is_session_id(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    return bool(_UUID_RE.match(value) or _RELAXED_SESSION_RE.match(value))


def _validate_user_prompt_submit(payload: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    if payload.get("hook_event_name") != "UserPromptSubmit":
        errs.append("hook_event_name_mismatch")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str):
        errs.append("prompt_not_string")
    elif len(prompt) > MAX_PROMPT_LEN:
        errs.append("prompt_too_long")
    if not _is_session_id(payload.get("session_id", "")):
        errs.append("session_id_invalid")
    return errs


def _validate_pre_tool_use(payload: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    if payload.get("hook_event_name") != "PreToolUse":
        errs.append("hook_event_name_mismatch")
    tool = payload.get("tool_name")
    if not isinstance(tool, str) or not _TOOL_NAME_RE.match(tool):
        errs.append("tool_name_invalid")
    if "tool_input" in payload and not isinstance(payload.get("tool_input"),
                                                    (dict, list, str, int, float, bool, type(None))):
        errs.append("tool_input_invalid_type")
    if not _is_session_id(payload.get("session_id", "")):
        errs.append("session_id_invalid")
    return errs


def _validate_post_tool_use(payload: dict[str, Any]) -> list[str]:
    errs = _validate_pre_tool_use({**payload,
                                    "hook_event_name": "PreToolUse"})
    if payload.get("hook_event_name") != "PostToolUse":
        errs = [e for e in errs if e != "hook_event_name_mismatch"]
        errs.append("hook_event_name_mismatch")
    return errs


def _validate_stop(payload: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    if payload.get("hook_event_name") != "Stop":
        errs.append("hook_event_name_mismatch")
    if not _is_session_id(payload.get("session_id", "")):
        errs.append("session_id_invalid")
    return errs


def _validate_session_start(payload: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    if payload.get("hook_event_name") != "SessionStart":
        errs.append("hook_event_name_mismatch")
    if not _is_session_id(payload.get("session_id", "")):
        errs.append("session_id_invalid")
    src = payload.get("source")
    if src is not None and not isinstance(src, str):
        errs.append("source_not_string")
    return errs


def _validate_notification(payload: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    if payload.get("hook_event_name") != "Notification":
        errs.append("hook_event_name_mismatch")
    if not _is_session_id(payload.get("session_id", "")):
        errs.append("session_id_invalid")
    msg = payload.get("message")
    if not isinstance(msg, str):
        errs.append("message_not_string")
    return errs


def _validate_subagent_stop(payload: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    if payload.get("hook_event_name") != "SubagentStop":
        errs.append("hook_event_name_mismatch")
    if not _is_session_id(payload.get("session_id", "")):
        errs.append("session_id_invalid")
    return errs


_VALIDATORS = {
    "UserPromptSubmit": _validate_user_prompt_submit,
    "PreToolUse": _validate_pre_tool_use,
    "PostToolUse": _validate_post_tool_use,
    "Stop": _validate_stop,
    "SessionStart": _validate_session_start,
    "Notification": _validate_notification,
    "SubagentStop": _validate_subagent_stop,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def validate(event_name: str, payload: Any) -> ValidationResult:
    """Validate + sanitize a hook payload. Always returns a ValidationResult."""
    if event_name not in _HOOK_EVENT_NAMES:
        return ValidationResult(False, None, [f"unknown_event:{event_name}"])
    if not isinstance(payload, dict):
        return ValidationResult(False, None, ["payload_not_object"])
    if not _check_depth(payload):
        return ValidationResult(False, None, ["nesting_too_deep"])

    # Decide the per-string length cap based on event.
    str_cap = MAX_PROMPT_LEN if event_name == "UserPromptSubmit" else MAX_STRING_LEN
    sanitized, sanitize_errs = _sanitize_tree(payload, str_cap)
    if "null_byte_in_string" in sanitize_errs:
        return ValidationResult(False, None, sanitize_errs)

    validator = _VALIDATORS[event_name]
    errs = validator(sanitized) + sanitize_errs
    if errs:
        return ValidationResult(False, sanitized, errs)
    return ValidationResult(True, sanitized, [])


# F-MaxDual-R2-Hnew3: hard byte cap on stdin BEFORE json.loads. A
# 10MB malicious blob would otherwise allocate + parse before any size
# check downstream. 4 MiB is comfortably above the largest legitimate
# UserPromptSubmit payload (prompt cap 1 MB + small metadata) and well
# below memory-pressure territory.
_STDIN_BYTE_CAP = 4 * 1024 * 1024  # 4 MiB


def _read_stdin_bounded(byte_cap: int = _STDIN_BYTE_CAP) -> bytes | None:
    """Read up to *byte_cap* bytes from stdin. Returns None if stdin
    cannot be read. If the stream emits more than *byte_cap* bytes,
    returns the truncated prefix (caller treats as oversize → reject).
    Used by :func:`safe_load_stdin` to fail-closed on payload bombs.
    """
    try:
        if hasattr(sys.stdin, "buffer"):
            buf = sys.stdin.buffer.read(byte_cap + 1)
        else:
            buf = sys.stdin.read(byte_cap + 1).encode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return None
    return buf


def safe_load_stdin(event_name: str) -> dict[str, Any] | None:
    """Drop-in replacement for `json.loads(sys.stdin.read())` that validates
    + sanitizes. Returns None on any failure (caller MUST exit 0 silently).

    F-MaxDual-R2-Hnew3: stdin is read with a hard byte cap; oversize
    payloads are rejected before parsing.
    """
    raw_bytes = _read_stdin_bounded()
    if raw_bytes is None:
        return None
    if not raw_bytes:
        return None
    if len(raw_bytes) > _STDIN_BYTE_CAP:
        _alert("hook_input_validator",
                f"stdin exceeds {_STDIN_BYTE_CAP} byte cap — rejected",
                event_name)
        return None
    try:
        raw = raw_bytes.decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return None
    if "\x00" in raw:
        _alert("hook_input_validator",
                "stdin contains null byte — rejected", event_name)
        return None
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        _alert("hook_input_validator", "stdin is not valid JSON", event_name)
        return None
    result = validate(event_name, payload)
    if not result.ok:
        _alert("hook_input_validator",
                f"validation failed: {', '.join(result.errors[:5])}",
                event_name)
        return None
    return result.payload


def _alert(source: str, message: str, event_name: str) -> None:
    """F02 fix: emit a warn-level alert on validation failure so silent
    drops are observable in `~/.ultron/alerts.jsonl`. Uses the
    `hookval:<event>` dedupe tag the F02 contract requires.
    """
    if _alerts is None:
        return
    try:
        _alerts.write_dedupe(
            severity="warn",
            source=event_name,
            message=f"[{event_name}] {message}",
            dedupe_tag=f"hookval:{event_name}",
            window_seconds=3600,
            tags=["security", "hook_validator", event_name],
        )
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------
# CLI (for manual testing / piping)
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    import argparse
    p = argparse.ArgumentParser(
        prog="hook_input_validator.py",
        description="Validate stdin JSON payload against an ULTRON hook event schema.",
    )
    p.add_argument("event_name", choices=_HOOK_EVENT_NAMES)
    p.add_argument("--json", action="store_true",
                   help="Print sanitized payload as JSON when valid.")
    args = p.parse_args(argv)
    payload = safe_load_stdin(args.event_name)
    if payload is None:
        return 1
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
