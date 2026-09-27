"""Pytest suite for the id/path collision fix in scan_projects.py.

Bug: scan_root() derives `project_id = slug(basename)` and merge_with_existing()
used to overwrite an existing projects.json entry unconditionally whenever the
scanned id matched, even if the paths were different folders. Two folders that
happen to share a basename (the real `~/.ultron` and an ephemeral marketplace
copy at `~/.claude/skills/synced/<uuid>/ultron`, both named "ultron") collided:
the second one silently clobbered the first one's path/ide/language/type/
auto_tags. This mirrors idLibre() in hooks/scripts/ensure-project.js, which
hit the exact same failure mode and documents it in its own docstring.

Tests exercise merge_with_existing() directly against temporary projects.json
files (never the real one) and one end-to-end scenario through scan_root() to
reproduce the reported bug on disk (two temp directories both named "ultron").
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "cockpit" / "scan_projects.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("scan_projects", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def scan_mod(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A fresh scan_projects module instance, fully isolated from the real
    ~/.ultron/cockpit files (projects.json, ide-mappings.json, exclusions)."""
    mod = _load_module()
    monkeypatch.setattr(mod, "PROJECTS_JSON", tmp_path / "projects.json")
    monkeypatch.setattr(mod, "IDE_MAPPINGS_JSON", tmp_path / "ide-mappings.json")
    monkeypatch.setattr(mod, "EXCLUSIONS_JSON", tmp_path / "projects-exclusions.json")
    mod._OVERRIDES = None
    mod._EXCLUSIONS = None
    return mod


def _write_projects(mod, entries: list[dict]) -> None:
    mod.PROJECTS_JSON.write_text(
        json.dumps({"version": "1.0", "projects": entries}, ensure_ascii=False),
        encoding="utf-8",
    )


def _make_project(mod, *, id: str, name: str, path: str, **overrides):
    kwargs = dict(
        id=id,
        name=name,
        path=path,
        ide="VSCode",
        language="unknown",
        type="library",
        status="auto-detected",
        tags=[],
        auto_tags=[],
    )
    kwargs.update(overrides)
    return mod.Project(**kwargs)


class TestMergeHappyPath:
    def test_new_project_with_no_existing_entries_is_added_as_is(self, scan_mod):
        _write_projects(scan_mod, [])
        scanned = [_make_project(scan_mod, id="foo", name="foo", path="C:/dev/foo")]

        result = scan_mod.merge_with_existing(scanned)

        assert [p["id"] for p in result["projects"]] == ["foo"]
        assert result["projects"][0]["path"] == "C:/dev/foo"

    def test_rescan_of_known_project_updates_auto_tags_but_keeps_manual_tags(self, scan_mod):
        _write_projects(scan_mod, [
            {
                "id": "foo", "name": "foo", "path": "C:/dev/foo",
                "ide": "VSCode", "language": "Python", "type": "library",
                "status": "active", "tags": ["mine"], "auto_tags": ["python"],
            }
        ])
        scanned = [_make_project(scan_mod, id="foo", name="foo", path="C:/dev/foo",
                                  auto_tags=["python", "web"])]

        result = scan_mod.merge_with_existing(scanned)

        entry = result["projects"][0]
        assert entry["status"] == "active"       # not downgraded to auto-detected
        assert entry["tags"] == ["mine"]          # manual tags untouched
        assert entry["auto_tags"] == ["python", "web"]  # auto tags refreshed


class TestBasenameCollisionDifferentPath:
    """The exact reported bug: two folders named "ultron" at different paths."""

    def _existing_ultron_entry(self) -> dict:
        return {
            "id": "ultron", "name": "ultron", "path": "C:\\Users\\dev\\.ultron",
            "ide": "vscode", "language": "Rust", "type": "app",
            "status": "manual", "tags": ["ultron"], "auto_tags": ["rust", "typescript"],
            "app_command": "ultron.exe", "color": "#ff00ff",
        }

    def test_existing_entry_survives_untouched_byte_for_byte(self, scan_mod):
        original = self._existing_ultron_entry()
        _write_projects(scan_mod, [original])

        colliding = _make_project(
            scan_mod, id="ultron", name="ultron",
            path="C:/Users/dev/.claude/skills/synced/uuid123/ultron",
            ide="VSCode", language="Markdown", type="skill", auto_tags=["skill"],
        )

        result = scan_mod.merge_with_existing([colliding])

        kept = next(p for p in result["projects"] if p["path"] == original["path"])
        assert kept == original  # untouched: same dict, including fields the
        # Project dataclass doesn't even know about (app_command, color)

    def test_colliding_scan_gets_a_different_free_id(self, scan_mod):
        original = self._existing_ultron_entry()
        _write_projects(scan_mod, [original])

        colliding_path = "C:/Users/dev/.claude/skills/synced/uuid123/ultron"
        colliding = _make_project(
            scan_mod, id="ultron", name="ultron", path=colliding_path,
            ide="VSCode", language="Markdown", type="skill", auto_tags=["skill"],
        )

        result = scan_mod.merge_with_existing([colliding])

        ids = [p["id"] for p in result["projects"]]
        assert ids.count("ultron") == 1  # no duplicate id
        new_entry = next(p for p in result["projects"] if p["path"] == colliding_path)
        assert new_entry["id"] != "ultron"

    def test_collision_is_logged(self, scan_mod, capsys):
        _write_projects(scan_mod, [self._existing_ultron_entry()])
        colliding = _make_project(
            scan_mod, id="ultron", name="ultron",
            path="C:/Users/dev/.claude/skills/synced/uuid123/ultron",
        )

        scan_mod.merge_with_existing([colliding])

        out = capsys.readouterr().out
        assert "[collision]" in out
        assert "ultron" in out

    def test_same_path_different_id_reuses_the_registered_id(self, scan_mod):
        """Casar primero por path: if the path is already registered under some
        id, a scan finding the SAME path (perhaps renamed by hand) reuses it
        rather than fighting over an id."""
        existing = {
            "id": "ultron-app", "name": "ultron", "path": "C:/Users/dev/.ultron",
            "ide": "VSCode", "language": "Rust", "type": "app",
            "status": "active", "tags": [], "auto_tags": [],
        }
        _write_projects(scan_mod, [existing])
        scanned = [_make_project(scan_mod, id="ultron", name="ultron",
                                  path="C:/Users/dev/.ultron")]

        result = scan_mod.merge_with_existing(scanned)

        assert [p["id"] for p in result["projects"]] == ["ultron-app"]


class TestIdempotentRescan:
    def test_two_passes_do_not_duplicate_or_reshuffle_ids(self, scan_mod):
        _write_projects(scan_mod, [
            {
                "id": "ultron", "name": "ultron", "path": "C:/Users/dev/.ultron",
                "ide": "vscode", "language": "Rust", "type": "app",
                "status": "manual", "tags": ["ultron"], "auto_tags": ["rust"],
            }
        ])
        colliding_path = "C:/Users/dev/.claude/skills/synced/uuid123/ultron"
        scanned = [_make_project(scan_mod, id="ultron", name="ultron", path=colliding_path)]

        first = scan_mod.merge_with_existing(scanned)
        _write_projects(scan_mod, first["projects"])

        second = scan_mod.merge_with_existing(scanned)

        first_ids = sorted(p["id"] for p in first["projects"])
        second_ids = sorted(p["id"] for p in second["projects"])
        assert first_ids == second_ids
        assert len(second_ids) == len(set(second_ids))  # no duplicates


class TestScanRootEndToEnd:
    def test_two_directories_named_ultron_do_not_collide_on_disk(self, scan_mod, tmp_path):
        """Reproduces the real bug scenario on disk: a real project directory
        and a marketplace-style copy, both literally named "ultron"."""
        real_ultron = tmp_path / "real" / ".ultron"
        real_ultron.mkdir(parents=True)
        (real_ultron / "Cargo.toml").write_text("[package]\nname='ultron'\n", encoding="utf-8")

        skill_copy = tmp_path / "claude_skills" / "synced" / "some-uuid" / "ultron"
        skill_copy.mkdir(parents=True)
        (skill_copy / "SKILL.md").write_text("---\nname: ultron\n---\n", encoding="utf-8")

        _write_projects(scan_mod, [
            {
                "id": "ultron", "name": "ultron", "path": str(real_ultron),
                "ide": "vscode", "language": "Rust", "type": "app",
                "status": "manual", "tags": ["ultron"], "auto_tags": ["rust"],
            }
        ])

        found_real = scan_mod.scan_root(tmp_path / "real")
        found_skill = scan_mod.scan_root(tmp_path / "claude_skills")
        result = scan_mod.merge_with_existing(found_real + found_skill)

        by_path = {p["path"]: p for p in result["projects"]}
        assert by_path[str(real_ultron)]["language"] == "Rust"  # untouched
        assert by_path[str(real_ultron)]["status"] == "manual"
        skill_entry = by_path[str(skill_copy)]
        assert skill_entry["id"] != "ultron"
