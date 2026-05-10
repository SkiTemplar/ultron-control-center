"""Tests for ULTRON v14 S5-C — skill_provenance."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

import skill_provenance as prov  # noqa: E402


@pytest.fixture
def isolated_state(tmp_path, monkeypatch):
    skills_root = tmp_path / ".claude" / "skills"
    skills_root.mkdir(parents=True)
    state_file = tmp_path / ".ultron" / "skill-provenance.json"
    monkeypatch.setattr(prov, "SKILLS_ROOT", skills_root)
    monkeypatch.setattr(prov, "PROVENANCE_FILE", state_file)
    monkeypatch.setattr(prov, "ULTRON_HOME", tmp_path / ".ultron")
    return skills_root, state_file


def _make_skill(root: Path, name: str, content: str = "body") -> Path:
    d = root / name
    d.mkdir()
    (d / "SKILL.md").write_text(content, encoding="utf-8")
    return d


def test_provenance_records_install(isolated_state):
    skills_root, state_file = isolated_state
    _make_skill(skills_root, "alpha")
    prov.record_install("alpha", source_kind="local")
    data = json.loads(state_file.read_text(encoding="utf-8"))
    assert "alpha" in data["skills"]
    assert data["skills"]["alpha"]["source_kind"] == "local"
    assert data["skills"]["alpha"]["skill_md_sha1"]


def test_provenance_detects_drift(isolated_state):
    skills_root, _ = isolated_state
    d = _make_skill(skills_root, "beta", "original")
    prov.record_install("beta", source_kind="local")
    # Modify the SKILL.md to simulate drift.
    (d / "SKILL.md").write_text("modified", encoding="utf-8")
    findings = prov.verify_integrity()
    drift = [f for f in findings if f.skill_name == "beta"
             and f.finding_type == "drift"]
    assert drift


def test_provenance_detects_missing_record(isolated_state):
    skills_root, _ = isolated_state
    _make_skill(skills_root, "gamma")  # not recorded
    findings = prov.verify_integrity()
    types = {(f.skill_name, f.finding_type) for f in findings}
    assert ("gamma", "missing_record") in types


def test_provenance_detects_missing_skill(isolated_state):
    skills_root, _ = isolated_state
    _make_skill(skills_root, "delta")
    prov.record_install("delta", source_kind="local")
    # Remove the skill from disk.
    import shutil
    shutil.rmtree(skills_root / "delta")
    findings = prov.verify_integrity()
    types = {(f.skill_name, f.finding_type) for f in findings}
    assert ("delta", "missing_skill") in types


def test_compute_skill_md_sha1_returns_empty_for_missing(tmp_path):
    assert prov.compute_skill_md_sha1(tmp_path / "no_such") == ""


def test_compute_skill_md_sha1_stable(tmp_path):
    d = tmp_path / "x"
    d.mkdir()
    (d / "SKILL.md").write_text("hello", encoding="utf-8")
    h1 = prov.compute_skill_md_sha1(d)
    h2 = prov.compute_skill_md_sha1(d)
    assert h1 == h2
    assert len(h1) == 40


def test_audit_returns_summary(isolated_state):
    skills_root, _ = isolated_state
    _make_skill(skills_root, "a")
    _make_skill(skills_root, "b")
    prov.record_install("a", source_kind="local")
    prov.record_install("b", source_kind="github",
                         source_url="https://github.com/x/y")
    rep = prov.audit()
    assert rep["total_recorded"] == 2
    assert rep["by_kind"]["local"] == 1
    assert rep["by_kind"]["github"] == 1


def test_infer_source_kind():
    assert prov._infer_source_kind("local") == "local"
    assert prov._infer_source_kind("github:x/y") == "github"
    assert prov._infer_source_kind("@addy-agent-skills") == "marketplace"
    assert prov._infer_source_kind(None) == "unknown"


# ---------------------------------------------------------------------------
# F04 — cross-process lock for record_install
# ---------------------------------------------------------------------------

def test_provenance_concurrent_record_install(tmp_path):
    """Two subprocesses recording different skills under the same
    USERPROFILE must both persist (no lost write). Uses subprocess.Popen
    rather than multiprocessing because Windows pytest + ``spawn`` is
    fragile and the harness needs a deterministic gate.
    """
    import subprocess
    import time as _time
    import json as _json

    # Wire up the isolated home through the env so child Python runs see it.
    env = dict(os.environ)
    env["USERPROFILE"] = str(tmp_path)
    env["HOME"] = str(tmp_path)
    env["PYTHONPATH"] = str(SKILL_ROOT / "scripts" / "cockpit")

    skills_root = tmp_path / ".claude" / "skills"
    skills_root.mkdir(parents=True)
    (skills_root / "alpha").mkdir()
    (skills_root / "alpha" / "SKILL.md").write_text("a", encoding="utf-8")
    (skills_root / "beta").mkdir()
    (skills_root / "beta" / "SKILL.md").write_text("b", encoding="utf-8")

    # Each child program waits until a sentinel file appears, then records.
    sentinel = tmp_path / "go.flag"
    program = (
        "import os, sys, time\n"
        f"sys.path.insert(0, r'{SKILL_ROOT / 'scripts' / 'cockpit'}')\n"
        "import skill_provenance as p\n"
        f"sentinel = r'{sentinel}'\n"
        "for _ in range(200):\n"
        "    if os.path.exists(sentinel): break\n"
        "    time.sleep(0.01)\n"
        "name = sys.argv[1]\n"
        "p.record_install(name, source_kind='local')\n"
    )

    procs = []
    for name in ("alpha", "beta"):
        procs.append(subprocess.Popen(
            [sys.executable, "-c", program, name],
            env=env, cwd=str(tmp_path),
        ))
    # Brief delay then drop the sentinel so both procs race the lock.
    _time.sleep(0.2)
    sentinel.write_text("go", encoding="utf-8")
    for proc in procs:
        proc.wait(timeout=15)
        assert proc.returncode == 0, "child record_install failed"

    state_file = tmp_path / ".ultron" / "skill-provenance.json"
    assert state_file.exists(), "provenance file not written"
    data = _json.loads(state_file.read_text(encoding="utf-8"))
    assert "alpha" in data["skills"], (
        f"alpha record lost — concurrent write was not serialized. "
        f"state={data}"
    )
    assert "beta" in data["skills"], (
        f"beta record lost — concurrent write was not serialized. "
        f"state={data}"
    )
