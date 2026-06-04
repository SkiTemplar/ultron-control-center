"""Pytest suite for ULTRON v14.7 BACKUP-WATCH.

Tests cover the static guarantees of the backup system: exclusion list parses,
backup script exists and contains the expected pattern flags, doctor D25
detector behaves correctly across the time-tier verdicts (fresh / stale-warn /
stale-blocking / never-run / malformed).

The actual robocopy invocation is NOT tested live — it's a Windows-native
binary and the script invokes it through PowerShell. Live smoke happens once
per session via `weekly-backup.ps1 -DryRun`.
"""
from __future__ import annotations

import importlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
COCKPIT = REPO_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    (tmp_path / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path


# ── Static surface guarantees ──────────────────────────────────────────────────


def test_exclusions_file_exists_and_parses():
    """backup-exclusions.txt is shipped and has the expected sections."""
    excl = Path.home() / ".ultron" / "config" / "backup-exclusions.txt"
    if not excl.exists():
        pytest.skip("exclusions file not present in this checkout")
    body = excl.read_text(encoding="utf-8")
    # Spot-check key categories
    for token in ("Unreal Engine", "Unity", "Web / Node", "Python", "ULTRON internals"):
        assert token in body, f"missing section: {token}"
    # Must contain known build dirs
    for token in ("Binaries/", "node_modules/", "__pycache__/", "Library/"):
        assert token in body, f"missing pattern: {token}"


def test_weekly_backup_script_has_required_flags():
    """The PowerShell script must reference robocopy /MIR + exclusion fan-in."""
    script = Path.home() / ".ultron" / "scripts" / "backup" / "weekly-backup.ps1"
    if not script.exists():
        pytest.skip("backup script not on disk")
    body = script.read_text(encoding="utf-8")
    # Backup root is now configurable via $env:ULTRON_BACKUP_ROOT with a
    # %USERPROFILE%\BACKUP fallback. Assert against both ends of that contract
    # instead of a hardcoded D:\<owner>\BACKUP path.
    for token in ("robocopy", "/MIR", "/XD", "/XF", "/LOG+", "Read-Exclusions",
                  "ULTRON_BACKUP_ROOT", "BackupRoot", "$KeepWeeks"):
        assert token in body, f"missing token: {token}"


# ── D25 detector behavior ──────────────────────────────────────────────────────


@pytest.fixture
def doctor_mod(fake_home):
    if "doctor" in sys.modules:
        del sys.modules["doctor"]
    return importlib.import_module("doctor")


def _write_status(home: Path, last_run_iso: str) -> None:
    status_dir = home / ".ultron" / ".tmp"
    status_dir.mkdir(parents=True, exist_ok=True)
    (status_dir / "backup-last-run.json").write_text(
        json.dumps({"last_run": last_run_iso, "date": last_run_iso[:10]}),
        encoding="utf-8",
    )


def test_d25_no_status_file_returns_info(doctor_mod, fake_home):
    findings = doctor_mod._check_backup_freshness({})
    assert len(findings) == 1
    assert findings[0].id == "backup:never_run"
    assert findings[0].severity == doctor_mod.SEVERITY_INFO


def test_d25_fresh_backup_returns_no_finding(doctor_mod, fake_home):
    fresh = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    _write_status(fake_home, fresh)
    findings = doctor_mod._check_backup_freshness({})
    assert findings == []


def test_d25_stale_8d_returns_warn(doctor_mod, fake_home):
    stale = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
    _write_status(fake_home, stale)
    findings = doctor_mod._check_backup_freshness({})
    assert len(findings) == 1
    assert findings[0].severity == doctor_mod.SEVERITY_WARN
    assert "8d" in findings[0].id or "8d" in findings[0].summary


def test_d25_stale_45d_returns_blocking(doctor_mod, fake_home):
    very_stale = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
    _write_status(fake_home, very_stale)
    findings = doctor_mod._check_backup_freshness({})
    assert len(findings) == 1
    assert findings[0].severity == doctor_mod.SEVERITY_BLOCKING


def test_d25_malformed_status_returns_info(doctor_mod, fake_home):
    status_dir = fake_home / ".ultron" / ".tmp"
    status_dir.mkdir(parents=True, exist_ok=True)
    (status_dir / "backup-last-run.json").write_text("not-json{{", encoding="utf-8")
    findings = doctor_mod._check_backup_freshness({})
    assert len(findings) == 1
    assert findings[0].severity == doctor_mod.SEVERITY_INFO
    assert "unreadable" in findings[0].id
