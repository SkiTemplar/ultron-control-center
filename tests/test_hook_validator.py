"""Tests for ULTRON v14 S5-C — hook_input_validator."""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

import hook_input_validator as hv  # noqa: E402


_VALID_SESSION = "12345678-1234-1234-1234-123456789012"


def test_validate_user_prompt_submit_ok():
    payload = {"hook_event_name": "UserPromptSubmit",
               "prompt": "hello", "session_id": _VALID_SESSION}
    r = hv.validate("UserPromptSubmit", payload)
    assert r.ok
    assert r.payload["prompt"] == "hello"


def test_hook_validator_rejects_oversized_prompt():
    big = "A" * (hv.MAX_PROMPT_LEN + 100)
    payload = {"hook_event_name": "UserPromptSubmit",
               "prompt": big, "session_id": _VALID_SESSION}
    r = hv.validate("UserPromptSubmit", payload)
    assert not r.ok
    assert any("too_long" in e or "string_too_long" in e for e in r.errors)


def test_hook_validator_rejects_null_bytes():
    payload = {"hook_event_name": "UserPromptSubmit",
               "prompt": "hi\x00there", "session_id": _VALID_SESSION}
    r = hv.validate("UserPromptSubmit", payload)
    assert not r.ok
    assert "null_byte_in_string" in r.errors


def test_hook_validator_rejects_deep_nesting():
    nested: dict = {}
    cur = nested
    for _ in range(hv.MAX_NESTING_DEPTH + 5):
        cur["next"] = {}
        cur = cur["next"]
    payload = {"hook_event_name": "UserPromptSubmit",
               "prompt": "hi", "session_id": _VALID_SESSION,
               "extra": nested}
    r = hv.validate("UserPromptSubmit", payload)
    assert not r.ok
    assert "nesting_too_deep" in r.errors


def test_hook_validator_rejects_invalid_session_id():
    payload = {"hook_event_name": "UserPromptSubmit",
               "prompt": "hi", "session_id": "x" * 200 + "@invalid"}
    r = hv.validate("UserPromptSubmit", payload)
    assert not r.ok


def test_validate_pre_tool_use_accepts_mcp_tool_name():
    payload = {"hook_event_name": "PreToolUse",
               "tool_name": "mcp__claude_ai_Notion__notion-search",
               "tool_input": {"query": "x"},
               "session_id": _VALID_SESSION}
    r = hv.validate("PreToolUse", payload)
    assert r.ok


def test_validate_pre_tool_use_rejects_invalid_tool_name():
    payload = {"hook_event_name": "PreToolUse",
               "tool_name": "Bash; rm -rf /",
               "tool_input": {},
               "session_id": _VALID_SESSION}
    r = hv.validate("PreToolUse", payload)
    assert not r.ok
    assert "tool_name_invalid" in r.errors


def test_strips_control_chars_from_string():
    payload = {"hook_event_name": "UserPromptSubmit",
               "prompt": "hello\x01\x02world",
               "session_id": _VALID_SESSION}
    r = hv.validate("UserPromptSubmit", payload)
    assert r.ok
    assert r.payload["prompt"] == "helloworld"


def test_safe_load_stdin_returns_none_on_invalid_json(monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO("{not json"))
    assert hv.safe_load_stdin("UserPromptSubmit") is None


def test_safe_load_stdin_returns_none_on_validation_failure(monkeypatch):
    payload = json.dumps({"hook_event_name": "UserPromptSubmit",
                          "prompt": "x", "session_id": "BAD@"})
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    assert hv.safe_load_stdin("UserPromptSubmit") is None


def test_safe_load_stdin_passes_clean_payload(monkeypatch):
    payload = json.dumps({"hook_event_name": "Stop",
                          "session_id": _VALID_SESSION})
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    out = hv.safe_load_stdin("Stop")
    assert out is not None
    assert out["session_id"] == _VALID_SESSION


def test_unknown_event_name_rejected():
    r = hv.validate("PiratesAhoy", {})
    assert not r.ok
    assert any("unknown_event" in e for e in r.errors)


def test_session_start_optional_source():
    payload = {"hook_event_name": "SessionStart",
               "session_id": _VALID_SESSION, "source": "startup"}
    r = hv.validate("SessionStart", payload)
    assert r.ok


# ---------------------------------------------------------------------------
# F02 — validator must alert on validation failure (not just silently drop)
# ---------------------------------------------------------------------------

def test_safe_load_stdin_emits_alert_on_failure(monkeypatch):
    """Validation failure on stdin must call alerts.write_dedupe with the
    `hookval:<event>` dedupe tag so silent drops are observable.
    """
    captured = {}

    class _MockAlerts:
        @staticmethod
        def write_dedupe(severity=None, source=None, message=None,
                          dedupe_tag=None, window_seconds=None,
                          tags=None):
            captured["severity"] = severity
            captured["source"] = source
            captured["message"] = message
            captured["dedupe_tag"] = dedupe_tag
            captured["window_seconds"] = window_seconds
            captured["tags"] = tags
            return "a-test-001"

    monkeypatch.setattr(hv, "_alerts", _MockAlerts)
    # Send malformed JSON — _alert path fires once.
    monkeypatch.setattr(sys, "stdin", io.StringIO("{not json"))
    out = hv.safe_load_stdin("UserPromptSubmit")
    assert out is None
    assert captured.get("severity") == "warn"
    assert captured.get("dedupe_tag") == "hookval:UserPromptSubmit"
    assert captured.get("source") == "UserPromptSubmit"


def test_safe_load_stdin_emits_alert_on_validation_error(monkeypatch):
    captured = {}

    class _MockAlerts:
        @staticmethod
        def write_dedupe(**kwargs):
            captured.update(kwargs)
            return "a-test-002"

    monkeypatch.setattr(hv, "_alerts", _MockAlerts)
    payload = json.dumps({"hook_event_name": "UserPromptSubmit",
                          "prompt": "x", "session_id": "BAD@"})
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    assert hv.safe_load_stdin("UserPromptSubmit") is None
    assert captured.get("dedupe_tag") == "hookval:UserPromptSubmit"
