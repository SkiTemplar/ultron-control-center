"""
Smoke tests for registry_sync.py.

Validates:
- cmd_health and cmd_status exit cleanly (no crash, no NameError)
- cmd_propagate --dry-run does not raise ACTIVITY NameError (B1 fix)
- registry_sync imports cleanly
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parents[2]
COCKPIT    = SKILL_ROOT / "scripts" / "cockpit"
SCRIPT     = COCKPIT / "registry_sync.py"


def run(*args: str, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["uv", "run", "python", str(SCRIPT), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=SKILL_ROOT, timeout=timeout,
    )


class TestRegistrySyncSmoke:
    def test_script_exists(self):
        assert SCRIPT.exists(), f"registry_sync.py not found at {SCRIPT}"

    def test_health_no_crash(self):
        r = run("health")
        assert "Traceback" not in r.stderr, r.stderr[:400]
        assert r.returncode in (0, 1)

    def test_status_no_crash(self):
        r = run("status")
        assert "Traceback" not in r.stderr, r.stderr[:400]
        assert r.returncode in (0, 1)

    def test_propagate_dry_run_no_name_error(self):
        """ACTIVITY NameError was the P1 crash in cmd_propagate (registry_sync B1 fix)."""
        r = run("propagate", "--dry-run", timeout=45)
        assert "NameError" not in r.stderr, r.stderr[:400]
        assert "Traceback" not in r.stderr, r.stderr[:400]
        assert r.returncode in (0, 1)

    def test_health_output_contains_score(self):
        r = run("health")
        combined = r.stdout + r.stderr
        assert "score" in combined.lower() or "health" in combined.lower(), combined[:300]
