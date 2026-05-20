"""ULTRON v15.5.21 — anti-regression guard for the ultron skill sub-files.

Catches the v15.2.7 regression: commit 4df7c4f ("curated ULTRON skills,
publishable subset") deleted the skill's mode-*.md / protocols.md sub-files
and nothing noticed for ~3 versions — HIGH / ULTRA / LEARN silently lost
their executable protocol.

If the ultron skill is installed locally, every mode sub-file that SKILL.md
delegates to MUST exist and be non-empty. On a public clone (where the rich
personal ultron skill is intentionally absent) the whole suite is skipped.

See plans/specs/2026-05-20-ultron-modes-plan.md (Fase 4).
"""
from __future__ import annotations

from pathlib import Path

import pytest

_SKILL_DIR = Path.home() / ".claude" / "skills" / "ultron"

# Sub-files SKILL.md delegates each mode's protocol to. Without them the
# `Read mode-*.md` / `Read protocols.md` steps fail and the high modes
# degrade to a no-op.
_REQUIRED_SUBFILES = [
    "mode-low.md",
    "mode-medium.md",
    "mode-high.md",
    "mode-ultra.md",
    "mode-learn.md",
    "protocols.md",
    "memory.md",
]

_skill_installed = (_SKILL_DIR / "SKILL.md").exists()
_skip_reason = "ultron skill not installed locally (public clone) — nothing to guard"


@pytest.mark.skipif(not _skill_installed, reason=_skip_reason)
@pytest.mark.parametrize("subfile", _REQUIRED_SUBFILES)
def test_ultron_skill_subfile_present(subfile):
    """Each mode sub-file referenced by SKILL.md must exist and be non-empty."""
    path = _SKILL_DIR / subfile
    assert path.exists(), (
        f"ultron skill sub-file '{subfile}' is MISSING. SKILL.md references it; "
        f"without it the corresponding mode loses its protocol. "
        f"See plans/specs/2026-05-20-ultron-modes-plan.md."
    )
    assert path.stat().st_size > 0, (
        f"ultron skill sub-file '{subfile}' exists but is EMPTY."
    )


@pytest.mark.skipif(not _skill_installed, reason=_skip_reason)
def test_ultron_skill_md_present():
    """SKILL.md itself — the index every mode selector depends on."""
    skill_md = _SKILL_DIR / "SKILL.md"
    assert skill_md.exists() and skill_md.stat().st_size > 0, (
        "ultron skill SKILL.md is missing or empty — the mode system has no index."
    )
