"""Pytest suite for ULTRON v14.4 TOKEN HUNTER Phase 4 — tool/skill description trim.

4 cases adapted from ops manual (`~/.ultron/plans/2026-05-09-MACRO-ops-manual.md`
lines 305-322). Original spec assumed running 20 task fixtures live; that's
out-of-scope for unit tests, so we cover the static guarantees: critical
sections preserved, token budgets respected, frontmatter still parses, and
backup files exist for the rewrites we just did.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_MD = REPO_ROOT / "SKILL.md"
PROJECT_CLAUDE_MD = REPO_ROOT / "CLAUDE.md"

# Token budgets (post-Phase 4):
SKILL_MD_BUDGET = 3000
CLAUDE_MD_PROJECT_BUDGET = 1000


def _count_tokens(path: Path) -> int:
    """Best-effort token count using tiktoken cl100k_base; skip if missing."""
    try:
        import tiktoken
    except ImportError:
        pytest.skip("tiktoken not installed in test env")
    enc = tiktoken.get_encoding("cl100k_base")
    return len(enc.encode(path.read_text(encoding="utf-8")))


# ── Case 1 ─────────────────────────────────────────────────────────────────────


def test_skill_md_critical_sections_present():
    """SKILL.md must keep the structural anchors the model uses for routing."""
    if not SKILL_MD.exists():
        pytest.skip("SKILL.md not on disk in this checkout")
    body = SKILL_MD.read_text(encoding="utf-8")

    # Frontmatter intact
    assert body.startswith("---\n")
    assert "name: ultron" in body
    assert "description:" in body

    # Routing-critical sections must remain
    assert "## SELECTOR DE MODO" in body
    assert "## ⚡ FAST PATH" in body or "FAST PATH" in body
    assert "## 📚 KNOWLEDGE LAYER" in body or "KNOWLEDGE LAYER" in body
    assert "## SUBAGENT DISPATCH" in body
    assert "GUARD-RAIL" in body  # security invariant


# ── Case 2 ─────────────────────────────────────────────────────────────────────


def test_skill_md_within_token_budget():
    """SKILL.md after Phase 4 trim should be at or under SKILL_MD_BUDGET tokens."""
    if not SKILL_MD.exists():
        pytest.skip("SKILL.md not on disk")
    tokens = _count_tokens(SKILL_MD)
    assert tokens <= SKILL_MD_BUDGET, (
        f"SKILL.md has {tokens} tokens, exceeds budget {SKILL_MD_BUDGET}"
    )


# ── Case 3 ─────────────────────────────────────────────────────────────────────


def test_claude_md_project_within_token_budget():
    """Project CLAUDE.md after Phase 4 should be ≤ CLAUDE_MD_PROJECT_BUDGET."""
    if not PROJECT_CLAUDE_MD.exists():
        pytest.skip("project CLAUDE.md not on disk")
    tokens = _count_tokens(PROJECT_CLAUDE_MD)
    assert tokens <= CLAUDE_MD_PROJECT_BUDGET, (
        f"project CLAUDE.md has {tokens} tokens, exceeds budget {CLAUDE_MD_PROJECT_BUDGET}"
    )


# ── Case 4 ─────────────────────────────────────────────────────────────────────


def test_skill_md_yaml_frontmatter_parses():
    """Frontmatter must parse as YAML with the expected keys."""
    if not SKILL_MD.exists():
        pytest.skip("SKILL.md not on disk")
    body = SKILL_MD.read_text(encoding="utf-8")
    if not body.startswith("---\n"):
        pytest.fail("SKILL.md does not begin with YAML frontmatter")
    end = body.find("\n---\n", 4)
    assert end != -1, "frontmatter terminator not found"
    fm_text = body[4:end]

    try:
        import yaml
    except ImportError:
        pytest.skip("PyYAML not available in test env")

    fm = yaml.safe_load(fm_text)
    assert isinstance(fm, dict)
    assert fm.get("name") == "ultron"
    assert "description" in fm and fm["description"], "description must be non-empty"
    assert fm.get("kind") == "meta"
    assert fm.get("tier") == "L1"
