"""Pytest suite for doctor.py D18_SKILL_TRUNCATION detector (Phase 6)."""
from __future__ import annotations

import importlib
import sys
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
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    (tmp_path / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".ultron" / "config").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".claude" / "plugins").mkdir(parents=True, exist_ok=True)
    for mod in ("alerts", "doctor", "token_budget"):
        if mod in sys.modules:
            del sys.modules[mod]
    return tmp_path


@pytest.fixture
def doctor(isolated_home):
    return importlib.import_module("doctor")


def _make_skill(home: Path, namespace: str, name: str) -> None:
    if namespace == "root":
        target = home / ".claude" / "skills" / name / "SKILL.md"
    elif namespace == "plugin":
        target = home / ".claude" / "plugins" / "test-marketplace" / name / "SKILL.md"
    elif namespace == "bundle":
        target = home / ".claude" / "skills" / "bundle-pkg" / name / "SKILL.md"
    else:
        raise ValueError(namespace)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(f"---\nname: {name}\n---\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# _count_skills_on_disk
# ---------------------------------------------------------------------------


def test_count_skills_classifies_by_namespace(doctor, isolated_home):
    _make_skill(isolated_home, "root", "alpha")
    _make_skill(isolated_home, "root", "beta")
    _make_skill(isolated_home, "plugin", "gamma")
    _make_skill(isolated_home, "bundle", "delta")
    counts = doctor._count_skills_on_disk()
    assert counts["root"] == 2
    assert counts["plugin"] == 1
    assert counts["bundle"] == 1
    assert counts["total"] == 4


def test_count_skills_handles_missing_dirs(doctor, tmp_path, monkeypatch):
    """If both skill roots are missing, totals are zero (no crash)."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "nope")
    counts = doctor._count_skills_on_disk()
    assert counts == {"root": 0, "plugin": 0, "bundle": 0, "total": 0}


# ---------------------------------------------------------------------------
# D18 detector behaviour
# ---------------------------------------------------------------------------


def test_d18_silent_under_threshold(doctor, isolated_home):
    for i in range(50):
        _make_skill(isolated_home, "root", f"skill_{i}")
    out = doctor._check_skill_truncation({"thresholds": {}})
    assert out == []


def test_d18_warns_over_threshold(doctor, isolated_home):
    for i in range(150):
        _make_skill(isolated_home, "root", f"r_{i}")
    for i in range(80):
        _make_skill(isolated_home, "plugin", f"p_{i}")
    out = doctor._check_skill_truncation({"thresholds": {}})
    assert len(out) == 1
    f = out[0]
    assert f.id == "skill_truncation:over_threshold"
    assert f.severity == doctor.SEVERITY_WARN
    assert "230" in f.summary  # 150 root + 80 plugin
    assert "root=150" in f.detail
    assert "plugin=80" in f.detail
    assert "skill-truncation-2026-05-07.md" in f.detail


def test_d18_threshold_is_configurable(doctor, isolated_home):
    for i in range(50):
        _make_skill(isolated_home, "root", f"s_{i}")
    # Default threshold (200) -> silent
    assert doctor._check_skill_truncation({"thresholds": {}}) == []
    # Lower threshold (10) -> warn
    out = doctor._check_skill_truncation(
        {"thresholds": {"skill_truncation_warn_at": 10}})
    assert len(out) == 1
    assert "50" in out[0].summary


def test_d18_is_registered_in_all_detectors(doctor):
    assert doctor._check_skill_truncation in doctor._ALL_DETECTORS


def test_d18_category_is_valid(doctor):
    assert "skill_truncation" in doctor.VALID_CATEGORIES


def test_count_skills_skips_cache_dir(doctor, isolated_home):
    """L4: marketplaces/<name>/.../SKILL.md and cache/<name>/.../SKILL.md
    can be the same file under different paths. Only count one."""
    home = isolated_home
    plug = home / ".claude" / "plugins"
    (plug / "marketplaces" / "x" / "skills" / "alpha").mkdir(parents=True)
    (plug / "marketplaces" / "x" / "skills" / "alpha" / "SKILL.md").write_text(
        "---\nname: alpha\n---\n", encoding="utf-8")
    (plug / "cache" / "x" / "skills" / "alpha").mkdir(parents=True)
    (plug / "cache" / "x" / "skills" / "alpha" / "SKILL.md").write_text(
        "---\nname: alpha\n---\n", encoding="utf-8")
    counts = doctor._count_skills_on_disk()
    # cache/ duplicate must NOT be counted
    assert counts["plugin"] == 1, (
        f"cache/ over-counted: plugin={counts['plugin']}")
