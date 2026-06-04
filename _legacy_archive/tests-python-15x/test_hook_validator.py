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


@pytest.fixture(autouse=True)
def _disable_real_alerts(monkeypatch):
    """Unit tests should not append to the live ~/.ultron alerts bus."""
    monkeypatch.setattr(hv, "_alerts", None)


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


def test_hook_validator_strips_null_bytes_defensively():
    """v15.3.5: NUL bytes are now stripped instead of being a fatal reject.

    Real-world clipboards / IME layers occasionally smuggle a stray
    \\x00 into the prompt; dropping the whole UserPromptSubmit (losing
    the user's message) is a worse UX than quietly removing the byte.
    The ``null_byte_in_string`` tag is still surfaced in ``errors`` as
    informational telemetry so the alerts pipeline can dedupe + count.
    """
    payload = {"hook_event_name": "UserPromptSubmit",
               "prompt": "hi\x00there", "session_id": _VALID_SESSION}
    r = hv.validate("UserPromptSubmit", payload)
    assert r.ok, f"expected ok=True after NUL strip, got errors={r.errors}"
    assert r.payload["prompt"] == "hithere"
    # Telemetry tag still surfaces — the alerts pipeline relies on this.
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


def test_hook_validator_invalid_session_id_is_soft_tag():
    """v15.5.15: an invalid/missing session_id is downgraded to a
    non-fatal telemetry tag (commit 4a1b897). Some Claude Code builds
    omit the field; dropping the whole hook — and the prompt
    side-effect — is worse UX than logging the absence. Same pattern
    as null_byte_in_string (see test above).
    """
    payload = {"hook_event_name": "UserPromptSubmit",
               "prompt": "hi", "session_id": "x" * 200 + "@invalid"}
    r = hv.validate("UserPromptSubmit", payload)
    assert r.ok, f"expected ok=True (soft tag), got errors={r.errors}"
    assert "session_id_invalid" in r.errors


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
    # A non-string prompt is a fatal validation error. (session_id is
    # only a soft tag since v15.5.15, so it can no longer force a hard
    # failure here.)
    payload = json.dumps({"hook_event_name": "UserPromptSubmit",
                          "prompt": 12345, "session_id": _VALID_SESSION})
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    assert hv.safe_load_stdin("UserPromptSubmit") is None


def test_safe_load_stdin_passes_soft_session_id(monkeypatch):
    """v15.5.15: a bad session_id is a soft telemetry tag, not a fatal
    error — safe_load_stdin still returns the payload instead of None."""
    payload = json.dumps({"hook_event_name": "UserPromptSubmit",
                          "prompt": "hi", "session_id": "BAD@"})
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    out = hv.safe_load_stdin("UserPromptSubmit")
    assert out is not None
    assert out["prompt"] == "hi"


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

def test_safe_load_stdin_stays_silent_on_malformed_json(monkeypatch):
    """Malformed JSON is transient hook runtime noise, not user-actionable."""
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
    assert captured == {}


def test_safe_load_stdin_emits_alert_on_validation_error(monkeypatch):
    captured = {}

    class _MockAlerts:
        @staticmethod
        def write_dedupe(**kwargs):
            captured.update(kwargs)
            return "a-test-002"

    monkeypatch.setattr(hv, "_alerts", _MockAlerts)
    payload = json.dumps({"hook_event_name": "UserPromptSubmit",
                          "prompt": 12345, "session_id": _VALID_SESSION})
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    assert hv.safe_load_stdin("UserPromptSubmit") is None
    assert captured.get("dedupe_tag") == "hookval:UserPromptSubmit"
