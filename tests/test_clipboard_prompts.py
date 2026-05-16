"""Pytest suite for ULTRON v14.1 clipboard prompts (Phase 4).

Covers:
- build_newsletter_prompt: 3 editions render with all variables substituted
- _load_audit_prompt: every audit-button file exists, has a non-empty
  fenced block, substitutes {TODAY}.

Heavy textual imports in tui.py mean we read tui module attrs through
attribute access rather than reimporting it many times.
"""
from __future__ import annotations

import re
import sys
from datetime import datetime
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

# tui imports textual at module level; that's fine for tests but heavy.
# Importing once at module scope.
import tui  # noqa: E402


# ---------------------------------------------------------------------------
# Newsletter template
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("edition", ["tech"])
def test_build_newsletter_prompt_renders(edition: str):
    out = tui.build_newsletter_prompt(edition,
                                       today="2026-05-07",
                                       weekday="Thursday")
    cfg = tui.NEWSLETTER_EDITIONS[edition]
    assert cfg["edition_name"] in out
    assert cfg["header_logo"] in out
    assert cfg["tagline"] in out
    assert cfg["accent"] in out
    assert cfg["sources"] in out
    assert str(cfg["min_news"]) in out
    assert "2026-05-07" in out
    assert "Thursday" in out
    assert f"newsletter-2026-05-07{cfg['output_suffix']}.html" in out
    # No leftover unsubstituted placeholders
    assert "{" not in out or "{{" in out
    assert not re.search(r"\{[a-z_]+\}", out)


def test_only_tech_edition_remains():
    """v14.2.0 Phase 8a: football + space hard-deleted, tech is sole edition."""
    assert set(tui.NEWSLETTER_EDITIONS.keys()) == {"tech"}


def test_newsletter_breaking_banner_in_tech():
    """Tech edition keeps the BREAKING BANNER block."""
    tech = tui.build_newsletter_prompt("tech", today="2026-05-07",
                                        weekday="Thursday")
    assert "BREAKING BANNER" in tech


def test_unknown_edition_raises_keyerror():
    with pytest.raises(KeyError):
        tui.build_newsletter_prompt("not-an-edition")


def test_newsletter_template_file_exists():
    assert tui.NEWSLETTER_TEMPLATE_PATH.exists(), (
        f"Template missing at {tui.NEWSLETTER_TEMPLATE_PATH}")
    text = tui.NEWSLETTER_TEMPLATE_PATH.read_text(encoding="utf-8")
    # Sanity: all required placeholders are present
    for key in ("today", "weekday", "edition_name", "header_logo",
                "tagline", "accent", "topics", "sources", "sections",
                "min_news", "output_suffix", "breaking_banner_block"):
        assert "{" + key + "}" in text, f"missing placeholder {{{key}}}"


# ---------------------------------------------------------------------------
# Audit prompts (TUI buttons)
# ---------------------------------------------------------------------------


def test_audit_prompts_dir_resolves_to_skill_source():
    assert tui.AUDIT_PROMPTS_DIR == tui._SKILL_COCKPIT_DIR / "tui" / "prompts"
    assert tui.AUDIT_PROMPTS_DIR.exists()


@pytest.mark.parametrize("entry", tui.AUDIT_BUTTONS)
def test_audit_prompt_loads_with_content(entry):
    filename, label, _cost, _cli = entry
    body = tui._load_audit_prompt(filename)
    assert body is not None, f"{filename} returned None"
    assert len(body) > 200, f"{filename} body too short ({len(body)} chars)"
    # Six-section uniform structure (per Phase 4.3 spec)
    for section in ("ROLE", "CONTEXT", "INPUTS", "CHECKS", "OUTPUT", "CONSTRAINTS"):
        assert section in body, f"{filename} missing section {section}"


def test_today_substitution_works():
    body = tui._load_audit_prompt("01-memoria.md")
    today = datetime.now().strftime("%Y-%m-%d")
    assert "{TODAY}" not in body
    assert today in body


def test_audit_buttons_count_matches_files():
    files_on_disk = {p.name for p in tui.AUDIT_PROMPTS_DIR.glob("*.md")}
    declared = {entry[0] for entry in tui.AUDIT_BUTTONS}
    missing = declared - files_on_disk
    assert not missing, (
        f"Drift: AUDIT_BUTTONS declares files that don't exist on disk: {missing}")
    # Extras are allowed (e.g. skills-* clipboard prompts loaded by other
    # buttons via the same _load_audit_prompt loader).


def test_load_audit_prompt_returns_none_for_missing_file():
    assert tui._load_audit_prompt("ghost-nonexistent.md") is None


# H4 from code review: defensive path-containment checks
def test_load_audit_prompt_rejects_path_traversal():
    assert tui._load_audit_prompt("../tui.py") is None
    assert tui._load_audit_prompt("..\\tui.py") is None
    assert tui._load_audit_prompt("subdir/file.md") is None
    assert tui._load_audit_prompt("subdir\\file.md") is None
    assert tui._load_audit_prompt("") is None
    assert tui._load_audit_prompt(None) is None  # type: ignore[arg-type]


def test_codex_button_is_only_button_9():
    codex_buttons = [e for e in tui.AUDIT_BUTTONS if e[3] == "codex"]
    assert len(codex_buttons) == 1
    assert codex_buttons[0][0] == "09-prompt-clipboard.md"
