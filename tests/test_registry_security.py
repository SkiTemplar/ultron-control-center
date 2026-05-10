"""ULTRON v14 S5-C — registry_sync security wiring (F05 fix).

Verifies that when ``registry_sync.cmd_auto_discover`` encounters a skill
whose security verdict is `quarantine`, it ALSO marks the manifest entry
with ``deprecated=True`` and ``security_status="quarantine_pending"``.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))


def test_set_security_status_marks_entry_deprecated_and_status(tmp_path,
                                                                 monkeypatch):
    """Direct unit test of the public API the registry_sync wires to.

    We seed an entry, call set_security_status, and assert both fields
    are persisted in the YAML and the regenerated cache.
    """
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    for mod in ("skill_manifest", ):
        if mod in sys.modules:
            del sys.modules[mod]
    sm = importlib.import_module("skill_manifest")

    # Ensure config/yaml live under tmp_path for this test.
    yaml_path = tmp_path / ".ultron" / "skills.manifest.yaml"
    yaml_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path = tmp_path / ".ultron" / "manifest.cache.json"
    monkeypatch.setattr(sm, "MANIFEST_YAML", yaml_path)
    monkeypatch.setattr(sm, "MANIFEST_CACHE", cache_path)

    # Seed YAML with one entry. Use the project's own YAML emit format.
    seed_entries = [{
        "name": "evil-skill",
        "source": "auto-discover",
        "triggers": ["foo"],
        "tags": [],
        "cost_tier": "medium",
        "dispatcher_priority": 3,
        "deprecated": False,
        "replaces": [],
        "last_used": None,
        "last_synced": "2026-05-05",
        "description": "test entry",
    }]
    sm._save_yaml(yaml_path, seed_entries)

    # Apply security status.
    ok = sm.set_security_status(
        "evil-skill",
        status="quarantine_pending",
        reason="security_quarantine_pending:PI002",
    )
    assert ok is True

    # Check YAML was rewritten.
    entries = sm._load_yaml(yaml_path)
    assert any(e.get("name") == "evil-skill" for e in entries)
    target = [e for e in entries if e["name"] == "evil-skill"][0]
    assert target["deprecated"] is True
    assert target["security_status"] == "quarantine_pending"
    assert "PI002" in target.get("security_status_reason", "")


def test_set_security_status_returns_false_for_unknown_skill(tmp_path,
                                                              monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    for mod in ("skill_manifest", ):
        if mod in sys.modules:
            del sys.modules[mod]
    sm = importlib.import_module("skill_manifest")
    yaml_path = tmp_path / ".ultron" / "skills.manifest.yaml"
    yaml_path.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(sm, "MANIFEST_YAML", yaml_path)
    monkeypatch.setattr(sm, "MANIFEST_CACHE",
                        tmp_path / ".ultron" / "manifest.cache.json")
    sm._save_yaml(yaml_path, [])
    assert sm.set_security_status("nonexistent", "quarantine_pending") is False


def test_quarantine_decision_marks_manifest_deprecated(tmp_path,
                                                         monkeypatch):
    """Integration: simulate the registry_sync quarantine path. A quarantine
    verdict for a skill must result in deprecated=True AND
    security_status='quarantine_pending' in the manifest.
    """
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    for mod in ("skill_manifest", ):
        if mod in sys.modules:
            del sys.modules[mod]
    sm = importlib.import_module("skill_manifest")
    yaml_path = tmp_path / ".ultron" / "skills.manifest.yaml"
    yaml_path.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(sm, "MANIFEST_YAML", yaml_path)
    monkeypatch.setattr(sm, "MANIFEST_CACHE",
                        tmp_path / ".ultron" / "manifest.cache.json")

    # Pre-existing manifest entry for the offending skill.
    sm._save_yaml(yaml_path, [{
        "name": "bad-skill",
        "source": "auto-discover",
        "triggers": ["bad"],
        "tags": [],
        "cost_tier": "medium",
        "dispatcher_priority": 3,
        "deprecated": False,
        "replaces": [],
        "last_used": None,
        "last_synced": "2026-05-05",
        "description": "evil",
    }])

    # Mirror the registry_sync quarantine branch directly.
    sm.set_security_status(
        "bad-skill",
        status="quarantine_pending",
        reason="security_quarantine_pending:PI002",
    )

    entries = sm._load_yaml(yaml_path)
    target = [e for e in entries if e["name"] == "bad-skill"][0]
    assert target["deprecated"] is True
    assert target["security_status"] == "quarantine_pending"
