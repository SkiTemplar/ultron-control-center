"""Pytest suite for templates/settings-hooks.json integrity.

Guards the template<->disk divergence that broke fresh installs: the hook
template once wired ~18 Python scripts that had been purged from disk, so a
fresh `install.ps1` merged hooks pointing at missing scripts. On Windows with
the .venv provisioned, Python exits non-zero on a missing script, and a
non-zero PreToolUse/UserPromptSubmit/Stop hook blocks every prompt/tool/turn
— an unusable session.

These tests assert that:
  1. The template is valid JSON.
  2. Every script the template references actually exists in the repo.

Run in CI / pre-commit so the template can never again point at a script that
is not shipped.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = REPO_ROOT / "templates" / "settings-hooks.json"

# Matches an in-repo script path inside an expanded hook command, e.g.
#   node {USERPROFILE}/.ultron/hooks/scripts/ensure-qdrant.js
#   uv run python {USERPROFILE}/.ultron/scripts/hooks/deny-secrets.py
_SCRIPT_RE = re.compile(r"\{USERPROFILE\}/\.ultron/([^\s\"]+\.(?:js|py|ps1))")


def _iter_commands(node: object):
    """Yield every hook `command` string anywhere in the template tree."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "command" and isinstance(value, str):
                yield value
            else:
                yield from _iter_commands(value)
    elif isinstance(node, list):
        for item in node:
            yield from _iter_commands(item)


def _referenced_scripts() -> list[str]:
    data = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    scripts: set[str] = set()
    for command in _iter_commands(data.get("hooks", {})):
        scripts.update(_SCRIPT_RE.findall(command))
    return sorted(scripts)


def test_template_is_valid_json() -> None:
    json.loads(TEMPLATE.read_text(encoding="utf-8"))


def test_template_references_at_least_one_script() -> None:
    # Guards against a regex/format drift silently matching nothing and
    # making the existence test vacuously pass.
    assert _referenced_scripts(), "no scripts parsed from the hook template"


@pytest.mark.parametrize("rel_path", _referenced_scripts())
def test_referenced_script_exists(rel_path: str) -> None:
    target = REPO_ROOT / rel_path
    assert target.is_file(), (
        f"hook template references {rel_path!r} but it does not exist in the "
        f"repo — a fresh install would wire a missing script and block the "
        f"session. Update templates/settings-hooks.json or ship the script."
    )
