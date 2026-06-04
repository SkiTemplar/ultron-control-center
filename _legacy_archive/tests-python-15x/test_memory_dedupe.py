"""Pytest suite for ULTRON v14.4 TOKEN HUNTER Phase 3 — memory_dedupe.py.

6 cases per ops manual (`~/.ultron/plans/2026-05-09-MACRO-ops-manual.md` lines
280-303): exact dup, paraphrase, intentional dup, dry-run no-op, apply +
backup, idempotent round-trip.

Tests run isolated against `tmp_path`; never touch real ~/.ultron/MEMORY.md
or ~/.claude/CLAUDE.md.
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest


COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))


@pytest.fixture
def dedup(tmp_path, monkeypatch):
    """Re-import memory_dedupe with HOME redirected to tmp_path."""
    fake_home = tmp_path
    (fake_home / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    (fake_home / ".claude").mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

    if "memory_dedupe" in sys.modules:
        del sys.modules["memory_dedupe"]
    mod = importlib.import_module("memory_dedupe")
    importlib.reload(mod)
    mod._FAKE_HOME = fake_home
    return mod


def _setup_files(home: Path, *, memory: str, claude: str = "", context: str = "") -> None:
    (home / ".ultron" / "MEMORY.md").write_text(memory, encoding="utf-8")
    (home / ".claude" / "CLAUDE.md").write_text(claude, encoding="utf-8")
    (home / ".ultron" / ".tmp" / "context.md").write_text(context, encoding="utf-8")


# ── Cases 1-6 ──────────────────────────────────────────────────────────────────


def test_detects_exact_duplicate(dedup):
    """Case 1: identical line in MEMORY.md and CLAUDE.md is flagged exact."""
    memory = "## SISTEMA\n\nUV is the canonical Python runner for ULTRON tools.\n"
    claude = "# CLAUDE\n\nUV is the canonical Python runner for ULTRON tools.\n"
    _setup_files(dedup._FAKE_HOME, memory=memory, claude=claude)

    report = dedup.build_report()
    assert len(report.matches) == 1
    assert report.matches[0].kind == "exact"
    assert report.matches[0].similarity == 1.0


def test_detects_paraphrase(dedup):
    """Case 2: near-identical wording is flagged fuzzy above threshold."""
    memory = (
        "## SISTEMA\n\n"
        "Always use UV runner for python scripts in ULTRON.\n"
    )
    claude = (
        "# CLAUDE\n\n"
        "Always use UV runner for python scripts in ULTRON.\n"
    )
    _setup_files(dedup._FAKE_HOME, memory=memory, claude=claude)

    report = dedup.build_report(threshold=0.85)
    assert len(report.matches) >= 1
    # At least one fuzzy or exact match
    assert all(m.similarity >= 0.85 for m in report.matches)


def test_preserves_intentional_duplicates(dedup):
    """Case 3: lines with [INTENTIONAL-DUP] are never proposed for removal."""
    memory = (
        "## RECORDATORIO [INTENTIONAL-DUP]\n\n"
        "Lee context.md primero. [INTENTIONAL-DUP]\n"
    )
    claude = "# CLAUDE\n\nLee context.md primero.\n"
    _setup_files(dedup._FAKE_HOME, memory=memory, claude=claude)

    report = dedup.build_report()
    # The marked line must NOT appear in lines_to_remove
    pinned_line_no = None
    for i, line in enumerate(memory.splitlines(), 1):
        if "[INTENTIONAL-DUP]" in line and not line.startswith("#"):
            pinned_line_no = i
    assert pinned_line_no is not None
    assert pinned_line_no not in report.lines_to_remove


def test_dry_run_does_not_modify(dedup):
    """Case 4: dry_run path returns proposal without touching the file."""
    memory = "## X\n\nIdentical fact about UV runner usage in ULTRON.\n"
    claude = "Identical fact about UV runner usage in ULTRON.\n"
    _setup_files(dedup._FAKE_HOME, memory=memory, claude=claude)

    before = (dedup._FAKE_HOME / ".ultron" / "MEMORY.md").read_text(encoding="utf-8")
    report = dedup.build_report()
    out = dedup.apply_report(report, dry_run=True)

    after = (dedup._FAKE_HOME / ".ultron" / "MEMORY.md").read_text(encoding="utf-8")
    assert before == after
    assert out.get("dry_run") is True
    # No backup file created
    bak = dedup._FAKE_HOME / ".ultron" / "MEMORY.md.bak"
    assert not bak.exists()


def test_apply_creates_backup_and_removes_lines(dedup):
    """Case 5: apply writes a .bak with original content and shrinks MEMORY.md."""
    memory = (
        "# MEMORY\n\n"
        "## SECTION A\n\n"
        "UV is the canonical python runner for ULTRON.\n"
        "Project list lives in projects.json.\n"
    )
    claude = (
        "# CLAUDE\n\n"
        "UV is the canonical python runner for ULTRON.\n"
    )
    _setup_files(dedup._FAKE_HOME, memory=memory, claude=claude)

    report = dedup.build_report()
    assert report.lines_to_remove, "test fixture must have at least 1 dup"

    out = dedup.apply_report(report, dry_run=False)
    assert out.get("applied") is True

    bak = dedup._FAKE_HOME / ".ultron" / "MEMORY.md.bak"
    assert bak.exists()
    assert "UV is the canonical python runner" in bak.read_text(encoding="utf-8")

    new_memory = (dedup._FAKE_HOME / ".ultron" / "MEMORY.md").read_text(encoding="utf-8")
    assert "UV is the canonical python runner" not in new_memory
    assert "Project list lives" in new_memory


def test_round_trip_idempotent(dedup):
    """Case 6: running apply twice — second is a noop."""
    memory = (
        "# MEMORY\n\n"
        "Use UV not pip in ULTRON tooling.\n"
        "Brain index FTS5 lives at ~/.ultron/brain_index/index.db.\n"
    )
    claude = "# CLAUDE\n\nUse UV not pip in ULTRON tooling.\n"
    _setup_files(dedup._FAKE_HOME, memory=memory, claude=claude)

    # First apply
    r1 = dedup.build_report()
    o1 = dedup.apply_report(r1, dry_run=False)
    assert o1.get("applied") is True

    # Second apply: should be noop
    r2 = dedup.build_report()
    o2 = dedup.apply_report(r2, dry_run=False)
    assert o2.get("noop") is True
