"""pytest tests for mcp_broker.py — security-critical component."""
import json
import pytest
from mcp_broker import is_safe_command, validate_jsonrpc, _sha256, load_allowlist


# ── is_safe_command ──────────────────────────────────────────────────────────

class TestIsSafeCommand:
    def test_valid_node_absolute(self):
        ok, _ = is_safe_command(["node", "/abs/path/server.js"])
        assert ok

    def test_valid_known_interpreter(self):
        ok, _ = is_safe_command(["python3", "script.py"])
        assert ok

    def test_reject_shell_pipe(self):
        ok, _ = is_safe_command(["node", "a|b"])
        assert not ok

    def test_reject_semicolon(self):
        ok, _ = is_safe_command(["node", "a;b"])
        assert not ok

    def test_reject_backtick(self):
        ok, _ = is_safe_command(["node", "back`tick`"])
        assert not ok

    def test_reject_dollar_var(self):
        ok, _ = is_safe_command(["node", "$HOME/server.js"])
        assert not ok

    def test_reject_subshell(self):
        ok, _ = is_safe_command(["node", "$(evil)"])
        assert not ok

    def test_reject_empty_list(self):
        ok, _ = is_safe_command([])
        assert not ok

    def test_reject_non_string_arg(self):
        ok, _ = is_safe_command(["node", 42])  # type: ignore
        assert not ok

    def test_reject_non_list(self):
        ok, _ = is_safe_command("node server.js")  # type: ignore
        assert not ok


# ── validate_jsonrpc ─────────────────────────────────────────────────────────

class TestValidateJsonrpc:
    def test_valid_request(self):
        ok, _ = validate_jsonrpc('{"jsonrpc":"2.0","method":"tools/list","id":1}')
        assert ok

    def test_valid_notification(self):
        ok, _ = validate_jsonrpc('{"jsonrpc":"2.0","method":"notifications/initialized"}')
        assert ok

    def test_reject_not_json(self):
        ok, _ = validate_jsonrpc("not json at all")
        assert not ok

    def test_reject_wrong_version(self):
        ok, _ = validate_jsonrpc('{"jsonrpc":"1.0","method":"x","id":1}')
        assert not ok

    def test_reject_missing_method(self):
        ok, _ = validate_jsonrpc('{"jsonrpc":"2.0","id":1}')
        assert not ok

    def test_reject_empty_method(self):
        ok, _ = validate_jsonrpc('{"jsonrpc":"2.0","method":"","id":1}')
        assert not ok

    def test_reject_non_object(self):
        ok, _ = validate_jsonrpc('["jsonrpc","2.0"]')
        assert not ok

    def test_reject_missing_jsonrpc(self):
        ok, _ = validate_jsonrpc('{"method":"tools/list","id":1}')
        assert not ok


# ── _sha256 ──────────────────────────────────────────────────────────────────

def test_sha256_str():
    result = _sha256("hello")
    assert result.startswith("sha256:")
    assert len(result) == len("sha256:") + 64


def test_sha256_bytes():
    result = _sha256(b"hello")
    assert result == _sha256("hello")


# ── load_allowlist ───────────────────────────────────────────────────────────

def test_load_allowlist_missing_file(tmp_path, monkeypatch):
    import mcp_broker
    monkeypatch.setattr(mcp_broker, "ALLOWLIST_PATH", tmp_path / "nonexistent.json")
    result = load_allowlist()
    assert result == {"servers": {}}


def test_load_allowlist_valid(tmp_path, monkeypatch):
    import mcp_broker
    data = {"servers": {"test": {"command": ["node", "s.js"]}}}
    p = tmp_path / "allowlist.json"
    p.write_text(json.dumps(data))
    monkeypatch.setattr(mcp_broker, "ALLOWLIST_PATH", p)
    result = load_allowlist()
    assert "test" in result["servers"]
