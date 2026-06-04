"""Tests for ULTRON v14 S5-C — settings_integrity."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

import settings_integrity as si  # noqa: E402


@pytest.fixture
def isolated_settings(tmp_path, monkeypatch):
    settings_path = tmp_path / ".claude" / "settings.json"
    settings_path.parent.mkdir(parents=True)
    snapshots_path = tmp_path / ".ultron" / "integrity" / "settings.snapshots.jsonl"
    monkeypatch.setattr(si, "SETTINGS_JSON", settings_path)
    monkeypatch.setattr(si, "SNAPSHOTS_FILE", snapshots_path)
    monkeypatch.setattr(si, "ULTRON_HOME", tmp_path / ".ultron")
    monkeypatch.setattr(si, "CLAUDE_HOME", tmp_path / ".claude")
    return settings_path, snapshots_path


def _write_settings(path: Path, mcps: dict, hooks: dict, plugins: dict) -> None:
    path.write_text(json.dumps({
        "mcpServers": mcps, "hooks": hooks, "enabledPlugins": plugins,
    }, indent=2), encoding="utf-8")


def test_settings_snapshot_records_state(isolated_settings):
    settings, snapshots = isolated_settings
    _write_settings(settings,
                    mcps={"foo": {"command": "x"}},
                    hooks={"PreToolUse": [{"hooks": [{"command": "py /a/b.py"}]}]},
                    plugins={"plug-a": True})
    snap = si.take_snapshot(trigger="manual")
    assert snap.mcps_count == 1
    assert snap.plugins_count == 1
    assert snap.hooks_count == 1
    assert snapshots.exists()
    data = [json.loads(l) for l in snapshots.read_text(encoding="utf-8").splitlines() if l]
    assert data[0]["mcps_count"] == 1


def test_settings_diff_detects_added_mcp(isolated_settings):
    settings, _ = isolated_settings
    _write_settings(settings, mcps={"foo": {"command": "x"}},
                    hooks={}, plugins={})
    si.take_snapshot(trigger="manual", user_authorized=True)

    _write_settings(settings,
                    mcps={"foo": {"command": "x"}, "bar": {"command": "y"}},
                    hooks={}, plugins={})
    diff = si.diff_against_last(authorized_only=True)
    assert "bar" in diff.mcps_added
    assert diff.has_changes


def test_settings_diff_detects_removed_mcp(isolated_settings):
    settings, _ = isolated_settings
    _write_settings(settings,
                    mcps={"foo": {"command": "x"}, "bar": {"command": "y"}},
                    hooks={}, plugins={})
    si.take_snapshot(trigger="manual")
    _write_settings(settings, mcps={"foo": {"command": "x"}}, hooks={}, plugins={})
    diff = si.diff_against_last()
    assert "bar" in diff.mcps_removed


def test_settings_diff_no_changes(isolated_settings):
    settings, _ = isolated_settings
    _write_settings(settings, mcps={"foo": {"command": "x"}}, hooks={}, plugins={})
    si.take_snapshot()
    diff = si.diff_against_last()
    assert not diff.has_changes


def test_verify_returns_no_snapshot_finding_when_first_run(isolated_settings):
    settings, _ = isolated_settings
    _write_settings(settings, mcps={"foo": {"command": "x"}}, hooks={}, plugins={})
    findings = si.verify()
    types = {f.finding_type for f in findings}
    assert "no_snapshot" in types
    # F09 fix: missing baseline is severity=warn, not info.
    no_snap = [f for f in findings if f.finding_type == "no_snapshot"]
    assert no_snap and no_snap[0].severity == "warn"


def test_verify_warns_on_added_mcp_after_baseline(isolated_settings):
    settings, _ = isolated_settings
    _write_settings(settings, mcps={"foo": {"command": "x"}}, hooks={}, plugins={})
    si.take_snapshot()
    _write_settings(settings,
                    mcps={"foo": {"command": "x"}, "newmcp": {"command": "z"}},
                    hooks={}, plugins={})
    findings = si.verify()
    types = [f.finding_type for f in findings]
    assert "mcp_added" in types


def test_walk_hook_paths_extracts_basename():
    cmd = "C:/python.exe C:/foo/bar/baz.py --flag"
    out = si._walk_hook_paths({"PreToolUse": [
        {"hooks": [{"command": cmd}]}
    ]})
    assert "PreToolUse:baz.py" in out


def test_unauthorized_snapshot_is_ignored_by_default(isolated_settings):
    settings, _ = isolated_settings
    _write_settings(settings, mcps={"a": {}}, hooks={}, plugins={})
    si.take_snapshot(trigger="manual", user_authorized=True)

    _write_settings(settings, mcps={"a": {}, "evil": {}}, hooks={}, plugins={})
    si.take_snapshot(trigger="auto", user_authorized=False)

    diff = si.diff_against_last(authorized_only=True)
    # evil should still appear as added when comparing to AUTHORIZED baseline
    assert "evil" in diff.mcps_added
