"""
Unit tests for usage_report.py — recommended_action boundaries and BOM guard.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parents[2]
COCKPIT    = SKILL_ROOT / "scripts" / "cockpit"
SCRIPT     = COCKPIT / "usage_report.py"

import usage_report as ur


class TestRecommendedAction:
    @pytest.mark.parametrize("runs,successes,expected", [
        (0,  0, "no_data"),
        (1,  1, "collect_data"),
        (4,  4, "collect_data"),
        (5,  4, "promote"),       # 4/5 = 0.80 exactly — promote threshold is >=0.80
        (5,  5, "promote"),       # 100% ≥0.80
        (10, 8, "promote"),       # 80% ≥0.80
        (10, 7, "keep"),          # 70% — between 0.40 and 0.80
        (5,  1, "review"),        # 20% < 0.40
        (10, 3, "review"),        # 30% < 0.40
        (10, 4, "keep"),          # 40% exactly — keep (not review; threshold is <0.40)
    ])
    def test_thresholds(self, runs, successes, expected):
        assert ur._recommended_action(runs, successes) == expected

    def test_collect_data_boundary(self):
        # runs=4 → always collect_data regardless of success rate
        assert ur._recommended_action(4, 4) == "collect_data"
        assert ur._recommended_action(4, 0) == "collect_data"

    def test_promote_boundary(self):
        # 4/5 = 0.80 exactly → promote (threshold is >=0.80)
        assert ur._recommended_action(5, 4) == "promote"
        # 3/5 = 0.60 → keep (above review threshold, below promote)
        assert ur._recommended_action(5, 3) == "keep"


class TestCollectFromRouteQualityBOM:
    def test_bom_file_loads_correctly(self, tmp_path):
        f = tmp_path / "rq.json"
        data = {
            "version": "1.0", "updated": "",
            "edges": {
                "ultron→alfred": {
                    "from": "ultron", "to": "alfred",
                    "runs": 3, "successes": 3, "last_used": "2026-05-02T10:00:00",
                }
            }
        }
        f.write_bytes(b'\xef\xbb\xbf' + json.dumps(data).encode("utf-8"))
        original = ur.ROUTE_QUALITY
        ur.ROUTE_QUALITY = f
        try:
            result = ur._collect_from_route_quality()
            assert result["ultron"]["runs"] == 3
        finally:
            ur.ROUTE_QUALITY = original

    def test_missing_file_returns_empty(self, tmp_path):
        original = ur.ROUTE_QUALITY
        ur.ROUTE_QUALITY = tmp_path / "nonexistent.json"
        try:
            result = ur._collect_from_route_quality()
            assert len(result) == 0
        finally:
            ur.ROUTE_QUALITY = original


class TestShowCommand:
    def test_show_exits_cleanly(self):
        r = subprocess.run(
            ["uv", "run", "python", str(SCRIPT), "show", "--days", "1"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=SKILL_ROOT, timeout=15,
        )
        assert "Traceback" not in r.stderr, r.stderr[:300]
        assert r.returncode == 0
