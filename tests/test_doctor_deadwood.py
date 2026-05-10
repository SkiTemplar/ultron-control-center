"""Pytest suite for doctor.py D17_DEADWOOD detector (Phase 3).

Uses the same isolated_home fixture pattern as test_doctor.py so the
real ~/.ultron is never touched.
"""
from __future__ import annotations

import importlib
import json
import sys
import time
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    # Patch Path.home() too — D17 uses it directly (separate from
    # module-level USERPROFILE-derived constants). Without this patch
    # the relative_to(Path.home()) branch silently falls into the
    # ValueError handler against the real home dir.
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    (tmp_path / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".ultron" / "config").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".ultron" / "audits").mkdir(parents=True, exist_ok=True)
    for mod in ("alerts", "doctor", "token_budget"):
        if mod in sys.modules:
            del sys.modules[mod]
    return tmp_path


@pytest.fixture
def doctor(isolated_home):
    return importlib.import_module("doctor")


def _write_deadwood(home: Path, findings: list[dict]) -> Path:
    target = home / ".ultron" / ".tmp" / "deadwood.json"
    target.write_text(json.dumps(findings, indent=2), encoding="utf-8")
    return target


# ---------------------------------------------------------------------------
# D17 — missing / stale / unreadable
# ---------------------------------------------------------------------------


def test_d17_missing_sidecar_is_info(doctor, isolated_home):
    out = doctor._check_deadwood({"staleness": {}})
    assert len(out) == 1
    assert out[0].id == "deadwood:missing"
    assert out[0].severity == doctor.SEVERITY_INFO
    assert out[0].fix_command is not None  # rebuild command available


def test_d17_stale_sidecar_is_info(doctor, isolated_home):
    target = _write_deadwood(isolated_home, [])
    # Force mtime > 24h ago
    old = time.time() - (48 * 3600)
    import os
    os.utime(target, (old, old))
    out = doctor._check_deadwood({"staleness": {"deadwood_max_hours": 24}})
    assert len(out) == 1
    assert out[0].id == "deadwood:stale"
    assert out[0].severity == doctor.SEVERITY_INFO


def test_d17_unreadable_sidecar_is_warn(doctor, isolated_home):
    target = isolated_home / ".ultron" / ".tmp" / "deadwood.json"
    target.write_text("{not valid json", encoding="utf-8")
    out = doctor._check_deadwood({"staleness": {}})
    assert len(out) == 1
    assert out[0].id == "deadwood:unreadable"
    assert out[0].severity == doctor.SEVERITY_WARN


def test_d17_malformed_sidecar_is_warn(doctor, isolated_home):
    target = isolated_home / ".ultron" / ".tmp" / "deadwood.json"
    target.write_text(json.dumps({"oops": "not a list"}), encoding="utf-8")
    out = doctor._check_deadwood({"staleness": {}})
    assert len(out) == 1
    assert out[0].id == "deadwood:malformed"


# ---------------------------------------------------------------------------
# D17 — fresh sidecar with content
# ---------------------------------------------------------------------------


def test_d17_clean_scan_emits_nothing(doctor, isolated_home):
    _write_deadwood(isolated_home, [
        {"file": str(isolated_home / "x.py"), "line_start": 1,
         "line_end": 1, "kind": "heuristic", "severity": "info",
         "pattern": "deprecated_word", "snippet": "x", "fields": {}},
    ])
    out = doctor._check_deadwood({"staleness": {}})
    # INFO findings are not surfaced; only blocking/warn rolled up
    assert out == []


def test_d17_one_blocking_finding_surfaces_individually(doctor, isolated_home):
    _write_deadwood(isolated_home, [
        {"file": str(isolated_home / "old.py"), "line_start": 42,
         "line_end": 50, "kind": "sentinel", "severity": "blocking",
         "pattern": "ULTRON-DEPRECATED",
         "snippet": "expired sentinel", "fields": {"version": "13.0.0"}},
    ])
    out = doctor._check_deadwood({"staleness": {}})
    blocks = [f for f in out if f.severity == doctor.SEVERITY_BLOCKING]
    assert len(blocks) == 1
    assert "ULTRON-DEPRECATED" in blocks[0].summary
    assert "L42" in blocks[0].summary


def test_d17_blocking_overflow_at_5_surfaced(doctor, isolated_home):
    _write_deadwood(isolated_home, [
        {"file": str(isolated_home / f"f{i}.py"), "line_start": i,
         "line_end": i, "kind": "sentinel", "severity": "blocking",
         "pattern": "P", "snippet": "x", "fields": {}}
        for i in range(7)
    ])
    out = doctor._check_deadwood({"staleness": {}})
    blocks = [f for f in out if f.severity == doctor.SEVERITY_BLOCKING]
    # 5 individual + 1 overflow summary
    assert len(blocks) == 6
    overflow = [f for f in blocks if f.id == "deadwood:blocking:overflow"]
    assert len(overflow) == 1
    assert "+2 more" in overflow[0].summary


def test_d17_warn_findings_collapse_to_one_summary(doctor, isolated_home):
    _write_deadwood(isolated_home, [
        {"file": str(isolated_home / f"f{i}.py"), "line_start": i,
         "line_end": i, "kind": "heuristic", "severity": "warn",
         "pattern": "removed_in_v" if i % 2 else "legacy_marker",
         "snippet": "x", "fields": {}}
        for i in range(10)
    ])
    out = doctor._check_deadwood({"staleness": {}})
    warns = [f for f in out if f.severity == doctor.SEVERITY_WARN]
    assert len(warns) == 1
    assert warns[0].id == "deadwood:warn:summary"
    assert "10 warn" in warns[0].summary
    # Pattern names included in detail
    assert "removed_in_v" in warns[0].detail
    assert "legacy_marker" in warns[0].detail


def test_d17_is_registered_in_all_detectors(doctor):
    assert doctor._check_deadwood in doctor._ALL_DETECTORS


def test_d17_category_is_valid(doctor):
    assert "deadwood" in doctor.VALID_CATEGORIES
