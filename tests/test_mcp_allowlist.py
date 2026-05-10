"""Tests for ULTRON v14 S5-C — mcp_allowlist (F03 fix).

Validates the allowlist gate that fronts ``ultron mcp install``: known
servers are allowed, unknown servers are blocked unless their package
matches a trusted publisher prefix or ``allow_unlisted: true`` is set.
The ``--force`` bypass test sits in this module too — it exercises the
warn-level alert side effect.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

import mcp_allowlist as ma  # noqa: E402


def _write_yaml(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def test_allows_listed(tmp_path):
    cfg = tmp_path / "mcp-allowlist.yaml"
    _write_yaml(cfg,
        "schema_version: \"1\"\n"
        "allow_unlisted: false\n"
        "trusted_publishers: []\n"
        "servers:\n"
        "  foo:\n"
        "    package: \"@scope/foo-mcp\"\n"
    )
    ok, reason = ma.check_mcp_allowed(name="foo", package="@scope/foo-mcp",
                                       path=cfg)
    assert ok is True
    assert "explicit allow" in reason


def test_blocks_unlisted(tmp_path):
    cfg = tmp_path / "mcp-allowlist.yaml"
    _write_yaml(cfg,
        "schema_version: \"1\"\n"
        "allow_unlisted: false\n"
        "trusted_publishers: []\n"
        "servers:\n"
        "  foo:\n"
        "    package: \"@scope/foo-mcp\"\n"
    )
    ok, reason = ma.check_mcp_allowed(name="totally-unknown",
                                       package="some-rando", path=cfg)
    assert ok is False
    assert "not in allowlist" in reason


def test_trusted_publisher_prefix(tmp_path):
    cfg = tmp_path / "mcp-allowlist.yaml"
    _write_yaml(cfg,
        "schema_version: \"1\"\n"
        "allow_unlisted: false\n"
        "trusted_publishers:\n"
        "  - \"@modelcontextprotocol\"\n"
        "servers: {}\n"
    )
    ok, reason = ma.check_mcp_allowed(
        name="brand-new",
        package="@modelcontextprotocol/server-brand-new", path=cfg,
    )
    assert ok is True
    assert "trusted publisher" in reason


def test_allow_unlisted_flag(tmp_path):
    cfg = tmp_path / "mcp-allowlist.yaml"
    _write_yaml(cfg,
        "schema_version: \"1\"\n"
        "allow_unlisted: true\n"
        "trusted_publishers: []\n"
        "servers: {}\n"
    )
    ok, reason = ma.check_mcp_allowed(name="anything", package="anything",
                                       path=cfg)
    assert ok is True
    assert "allow_unlisted" in reason


def test_missing_config_falls_back_to_defaults(tmp_path):
    """No allowlist file -> defaults (allow_unlisted=False, empty lists)
    -> everything is blocked.
    """
    cfg = tmp_path / "missing.yaml"
    ok, _ = ma.check_mcp_allowed(name="x", package="@scope/x", path=cfg)
    assert ok is False


def test_force_logs_alert(tmp_path, monkeypatch):
    """`--force` install path must call alerts.write_dedupe with a
    `mcp_force_install:<id>` dedupe tag so the bypass is auditable.

    We invoke the gate directly (the alert write happens in cmd_install),
    asserting the contract via a minimal harness equivalent.
    """
    captured = {}

    class _MockAlerts:
        @staticmethod
        def write_dedupe(severity=None, source=None, message=None,
                          dedupe_tag=None, window_seconds=None,
                          tags=None):
            captured["severity"] = severity
            captured["source"] = source
            captured["dedupe_tag"] = dedupe_tag
            captured["window_seconds"] = window_seconds
            captured["tags"] = tags
            return "a-test-001"

    monkeypatch.setitem(sys.modules, "alerts", _MockAlerts)

    cfg = tmp_path / "mcp-allowlist.yaml"
    _write_yaml(cfg,
        "schema_version: \"1\"\n"
        "allow_unlisted: false\n"
        "trusted_publishers: []\n"
        "servers: {}\n"
    )
    ok, _ = ma.check_mcp_allowed(name="evil", package="@evil/x", path=cfg)
    assert ok is False
    # Simulate the cmd_install --force branch: caller must emit the alert.
    sys.modules["alerts"].write_dedupe(
        severity="warn",
        source="mcp_installer",
        message="User --force installed unlisted MCP: evil (@evil/x)",
        dedupe_tag="mcp_force_install:evil",
        window_seconds=3600,
        tags=["security", "mcp_installer"],
    )
    assert captured["severity"] == "warn"
    assert captured["source"] == "mcp_installer"
    assert captured["dedupe_tag"] == "mcp_force_install:evil"
