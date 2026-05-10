"""Pytest suite for the configurable Usage weekly-reset feature."""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

import tui  # noqa: E402


# ---------------------------------------------------------------------------
# parse_reset_input
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("inp,expected", [
    ("Friday 03:00", (4, 3, 0)),
    ("fri 3", (4, 3, 0)),
    ("vie 03:00", (4, 3, 0)),
    ("4 3 0", (4, 3, 0)),
    ("Monday 14:30", (0, 14, 30)),
    ("dom 23:59", (6, 23, 59)),
    ("lun 0", (0, 0, 0)),
    ("Wednesday", (2, 0, 0)),
    ("invalid garbage", None),
    ("", None),
    (None, None),
    ("8 3 0", None),
    ("Friday 25:00", None),
    ("Friday 03:99", None),
    # M3 from code review: reject period/slash/dash instead of coercing
    ("Friday 3.00", None),
    ("Friday 03/00", None),
    ("Friday 03-00", None),
])
def test_parse_reset_input(inp, expected):
    assert tui.parse_reset_input(inp) == expected


# ---------------------------------------------------------------------------
# Hardening (post code-review)
# ---------------------------------------------------------------------------

def test_load_usage_config_rejects_bool_as_int(tmp_path, monkeypatch):
    """M2: isinstance(True, int) is True in Python — load_usage_config
    must reject bool values explicitly."""
    import json
    fake = tmp_path / "usage-config.json"
    fake.write_text(json.dumps({
        "weekday": True,   # bool — must NOT be accepted
        "hour": False,
        "minute": 0,
    }), encoding="utf-8")
    monkeypatch.setattr(tui, "USAGE_CONFIG_PATH", fake)
    cfg = tui.load_usage_config()
    # All three should fall back to defaults
    assert cfg == tui.USAGE_CONFIG_DEFAULTS


# ---------------------------------------------------------------------------
# compute_week_window
# ---------------------------------------------------------------------------

def test_window_friday_anchor_inside_week():
    # Wednesday 14:00 — last Friday at 03:00 is the anchor
    now = datetime(2026, 5, 6, 14, 0)
    s, e = tui.compute_week_window(now, weekday=4, hour=3, minute=0)
    assert s == datetime(2026, 5, 1, 3, 0)
    assert e == datetime(2026, 5, 8, 3, 0)


def test_window_at_anchor_starts_now():
    now = datetime(2026, 5, 8, 3, 0)
    s, e = tui.compute_week_window(now, weekday=4, hour=3, minute=0)
    assert s == datetime(2026, 5, 8, 3, 0)
    assert e == datetime(2026, 5, 15, 3, 0)


def test_window_just_before_anchor_uses_previous():
    now = datetime(2026, 5, 8, 2, 59)
    s, e = tui.compute_week_window(now, weekday=4, hour=3, minute=0)
    assert s == datetime(2026, 5, 1, 3, 0)
    assert e == datetime(2026, 5, 8, 3, 0)


@pytest.mark.parametrize("wd,h,m", [
    (0, 0, 0),
    (6, 23, 59),
    (2, 12, 30),
    (4, 3, 0),
])
def test_window_is_always_seven_days(wd, h, m):
    now = datetime(2026, 5, 8, 18, 30)
    s, e = tui.compute_week_window(now, wd, h, m)
    assert (e - s).days == 7
    assert s <= now < e


# ---------------------------------------------------------------------------
# load_usage_config / save_usage_config
# ---------------------------------------------------------------------------

def test_load_returns_defaults_when_missing(tmp_path, monkeypatch):
    fake = tmp_path / "usage-config.json"
    monkeypatch.setattr(tui, "USAGE_CONFIG_PATH", fake)
    cfg = tui.load_usage_config()
    assert cfg == {"weekday": 4, "hour": 3, "minute": 0}


def test_load_returns_defaults_on_corrupt_json(tmp_path, monkeypatch):
    fake = tmp_path / "usage-config.json"
    fake.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(tui, "USAGE_CONFIG_PATH", fake)
    assert tui.load_usage_config() == tui.USAGE_CONFIG_DEFAULTS


def test_save_then_load_roundtrip(tmp_path, monkeypatch):
    fake = tmp_path / "usage-config.json"
    monkeypatch.setattr(tui, "USAGE_CONFIG_PATH", fake)
    tui.save_usage_config(weekday=2, hour=14, minute=15)
    assert json.loads(fake.read_text(encoding="utf-8")) == {
        "weekday": 2, "hour": 14, "minute": 15,
    }
    assert tui.load_usage_config() == {"weekday": 2, "hour": 14, "minute": 15}


def test_save_is_atomic(tmp_path, monkeypatch):
    fake = tmp_path / "usage-config.json"
    monkeypatch.setattr(tui, "USAGE_CONFIG_PATH", fake)
    tui.save_usage_config(weekday=4, hour=3, minute=0)
    # No leftover .json.tmp
    assert not (tmp_path / "usage-config.json.tmp").exists()
