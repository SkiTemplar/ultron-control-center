"""
ULTRON v13.0 — Path resolver SSOT (Sprint 2 F12).

Single source of truth for every filesystem path used by the cockpit, hooks,
and personas. Resolves in this priority order:

    1. Environment variable overrides (ULTRON_HOME, ULTRON_VAULT, etc.)
    2. ~/.ultron/paths.json overrides (if file exists, JSON object)
    3. Default conventions (Path.home() / ".ultron", etc.)

Why this exists:
    Before F12, paths were duplicated across 60+ scripts:
      - cockpit_base.py had COCKPIT_DIR, NEWS_DIR, PROJECTS_JSON
      - brain_index.py had its own ULTRON_DIR / "brain_index" / "index.db"
      - audit_index.py had Path.home() / ".ultron" / "cockpit" / "audits"
      - _categorize_skills.py:458 had a HARDCODED `r"C:/Users/<name>/..."` path
      - Hooks PS1 used $env:USERPROFILE inline strings
    Different scripts assumed different roots, breaking on test environments
    and producing the multi-shell config drift documented as root cause #5 by
    Codex Phase 2.

Usage:

    from ultron_paths import P
    P.cockpit / "audits" / "INDEX.json"   # Path object
    P.skill_manifest_json                  # Path object — typed access
    P.brain_index_db                       # Path object
    str(P.vault)                           # str if a tool needs it

Or for legacy code that imports module-level constants:

    from ultron_paths import (
        ULTRON_HOME, COCKPIT_DIR, VAULT_DIR,
        SKILL_MANIFEST_JSON, BRAIN_INDEX_DB, AUDITS_DIR,
        PENDING_ACTIONS_JSON, ROUTE_QUALITY_JSON,
    )

Override via env (CI, tests, alternate users):

    PowerShell:  $env:ULTRON_HOME = "D:/ultron-test"
    Bash:        export ULTRON_HOME=/tmp/ultron-test

Override via ~/.ultron/paths.json (persistent custom layout):

    {
      "ultron_home": "D:/ultron",
      "vault":       "D:/ultron-vault",
      "claude_home": "D:/.claude"
    }

For PowerShell scripts use the sibling `ultron-paths.ps1` (dot-source).
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ─── Resolution helpers ────────────────────────────────────────────────────────

def _read_overrides() -> dict:
    """Read ~/.ultron/paths.json if it exists. Silent on errors."""
    candidate = Path.home() / ".ultron" / "paths.json"
    if not candidate.exists():
        return {}
    try:
        return json.loads(candidate.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


_OVERRIDES = _read_overrides()


def _resolve(env_key: str, json_key: str, default: Path) -> Path:
    """Env > paths.json > default. Returns absolute Path."""
    if env_key in os.environ:
        return Path(os.environ[env_key]).expanduser().resolve()
    if json_key in _OVERRIDES:
        return Path(_OVERRIDES[json_key]).expanduser().resolve()
    return default


# ─── Anchor directories (the four roots) ──────────────────────────────────────

USER_HOME = Path.home()

ULTRON_HOME  = _resolve("ULTRON_HOME",  "ultron_home",  USER_HOME / ".ultron")
VAULT_DIR    = _resolve("ULTRON_VAULT", "vault",        USER_HOME / ".ultron-vault")
CLAUDE_HOME  = _resolve("CLAUDE_HOME",  "claude_home",  USER_HOME / ".claude")
CODEX_HOME   = _resolve("CODEX_HOME",   "codex_home",   USER_HOME / ".codex")
GEMINI_HOME  = _resolve("GEMINI_HOME",  "gemini_home",  USER_HOME / ".gemini")


# ─── ULTRON_HOME structure ────────────────────────────────────────────────────

COCKPIT_DIR        = ULTRON_HOME / "cockpit"
HOOKS_DIR          = ULTRON_HOME / "scripts" / "hooks"
TMP_DIR            = ULTRON_HOME / ".tmp"
AUDITS_DIR         = COCKPIT_DIR / "audits"
NEWS_DIR           = COCKPIT_DIR / "news"
PLANS_DIR          = ULTRON_HOME / "plans"
SESSIONS_DIR       = ULTRON_HOME / "sessions"
ARCHIVE_DIR        = ULTRON_HOME / "archive"
BRAIN_INDEX_DIR    = ULTRON_HOME / "brain_index"
SKILL_CACHE_DIR    = ULTRON_HOME / "skill_cache"
SKILL_DISCOVERIES_DIR = ULTRON_HOME / "skill_discoveries"

# Manifests / canonical data files
SKILL_MANIFEST_JSON   = ULTRON_HOME / "skill_manifest.json"
SKILLS_REGISTRY_JSON  = ULTRON_HOME / "skills-registry.json"  # to be deprecated FIX-3
AGENT_MANIFEST_JSON   = ULTRON_HOME / "agent_manifest.json"   # to be deprecated FIX-3
INDEX_MD              = ULTRON_HOME / "INDEX.md"
BACKGROUND_TASKS_JSON = ULTRON_HOME / "background_tasks.json"

# Cockpit data files
PROJECTS_JSON         = COCKPIT_DIR / "projects.json"
PENDING_ACTIONS_JSON  = COCKPIT_DIR / "pending_actions.json"
NEWS_ALERTS           = NEWS_DIR / "ALERTS.md"
NEWS_SEEN             = NEWS_DIR / "seen.json"
AUDITS_INDEX_JSON     = AUDITS_DIR / "INDEX.json"

# Brain index
BRAIN_INDEX_DB        = BRAIN_INDEX_DIR / "index.db"

# Telemetry
ROUTE_QUALITY_JSON    = SKILL_CACHE_DIR / "route_quality.json"

# Tmp / runtime
CURRENT_SESSION_JSON  = TMP_DIR / "current-session.json"
CURRENT_SESSION_MODE  = TMP_DIR / "current-session-mode.json"
LAST_STOP_SYNC        = TMP_DIR / "last-stop-sync.json"
PENDING_ACTIONS_PRIME = TMP_DIR / "pending-actions-primed.json"
DECAY_PRIME           = TMP_DIR / "decay-prime.json"


# ─── CLAUDE_HOME structure ────────────────────────────────────────────────────

CLAUDE_SETTINGS_JSON  = CLAUDE_HOME / "settings.json"
CLAUDE_SKILLS_DIR     = CLAUDE_HOME / "skills"
CLAUDE_AGENTS_DIR     = CLAUDE_HOME / "agents"
CLAUDE_HISTORY_JSONL  = CLAUDE_HOME / "history.jsonl"
CLAUDE_PROJECTS_DIR   = CLAUDE_HOME / "projects"
CLAUDE_CREDENTIALS    = CLAUDE_HOME / ".credentials.json"

# ULTRON skill paths (where the cockpit/hooks code actually lives)
ULTRON_SKILL_DIR        = CLAUDE_SKILLS_DIR / "ultron"
ULTRON_SKILL_HOOKS_DIR  = ULTRON_SKILL_DIR / "hooks"      # Python hooks
ULTRON_SKILL_SCRIPTS    = ULTRON_SKILL_DIR / "scripts"
ULTRON_COCKPIT_PY_DIR   = ULTRON_SKILL_SCRIPTS / "cockpit"  # Python cockpit modules
ULTRON_REFERENCES_DIR   = ULTRON_SKILL_DIR / "references"
ULTRON_TESTS_DIR        = ULTRON_SKILL_DIR / "tests"
ULTRON_SKILL_CLAUDE_MD  = ULTRON_SKILL_DIR / "CLAUDE.md"
ULTRON_SKILL_SKILL_MD   = ULTRON_SKILL_DIR / "SKILL.md"


# ─── VAULT structure ──────────────────────────────────────────────────────────

VAULT_INDEX_DIR       = VAULT_DIR / "00_INDEX"
VAULT_KNOWLEDGE_DIR   = VAULT_DIR / "10_KNOWLEDGE"
VAULT_DECISIONS_DIR   = VAULT_DIR / "20_DECISIONS"
VAULT_PATTERNS_DIR    = VAULT_DIR / "30_PATTERNS"
VAULT_SKILLS_DIR      = VAULT_DIR / "40_SKILLS"        # de-indexed since F8
VAULT_SESSIONS_LOG    = VAULT_DIR / "50_SESSIONS_LOG"
VAULT_CC_MEMORIES     = VAULT_DIR / "CC-memories"
VAULT_GITLEAKS_TOML   = VAULT_DIR / ".gitleaks.toml"


# ─── External CLI homes ───────────────────────────────────────────────────────

CODEX_AUTH_JSON       = CODEX_HOME / "auth.json"
CODEX_CONFIG_TOML     = CODEX_HOME / "config.toml"
GEMINI_OAUTH_JSON     = GEMINI_HOME / "oauth_creds.json"
GEMINI_SETTINGS_JSON  = GEMINI_HOME / "settings.json"


# ─── Convenience facade (typed dot access) ────────────────────────────────────

@dataclass(frozen=True)
class _Paths:
    """Frozen dataclass facade for IDE autocompletion + typed access.

    Use this when you want a typed accessor: `from ultron_paths import P; P.vault`.
    Use the module-level constants when you want classic-style imports.
    """
    user_home:               Path = USER_HOME
    ultron:                  Path = ULTRON_HOME
    vault:                   Path = VAULT_DIR
    claude:                  Path = CLAUDE_HOME
    codex:                   Path = CODEX_HOME
    gemini:                  Path = GEMINI_HOME

    cockpit:                 Path = COCKPIT_DIR
    hooks:                   Path = HOOKS_DIR
    tmp:                     Path = TMP_DIR
    audits:                  Path = AUDITS_DIR
    news:                    Path = NEWS_DIR
    plans:                   Path = PLANS_DIR
    sessions:                Path = SESSIONS_DIR
    archive:                 Path = ARCHIVE_DIR
    brain_index_dir:         Path = BRAIN_INDEX_DIR
    skill_cache:             Path = SKILL_CACHE_DIR
    skill_discoveries:       Path = SKILL_DISCOVERIES_DIR

    skill_manifest_json:     Path = SKILL_MANIFEST_JSON
    skills_registry_json:    Path = SKILLS_REGISTRY_JSON
    agent_manifest_json:     Path = AGENT_MANIFEST_JSON
    index_md:                Path = INDEX_MD
    background_tasks_json:   Path = BACKGROUND_TASKS_JSON
    projects_json:           Path = PROJECTS_JSON
    pending_actions_json:    Path = PENDING_ACTIONS_JSON
    audits_index_json:       Path = AUDITS_INDEX_JSON
    brain_index_db:          Path = BRAIN_INDEX_DB
    route_quality_json:      Path = ROUTE_QUALITY_JSON
    current_session_json:    Path = CURRENT_SESSION_JSON
    current_session_mode:    Path = CURRENT_SESSION_MODE

    claude_settings_json:    Path = CLAUDE_SETTINGS_JSON
    claude_skills_dir:       Path = CLAUDE_SKILLS_DIR
    claude_agents_dir:       Path = CLAUDE_AGENTS_DIR
    claude_history_jsonl:    Path = CLAUDE_HISTORY_JSONL
    claude_projects_dir:     Path = CLAUDE_PROJECTS_DIR
    claude_credentials:      Path = CLAUDE_CREDENTIALS

    ultron_skill_dir:        Path = ULTRON_SKILL_DIR
    ultron_skill_hooks:      Path = ULTRON_SKILL_HOOKS_DIR
    ultron_cockpit_py:       Path = ULTRON_COCKPIT_PY_DIR
    ultron_references:       Path = ULTRON_REFERENCES_DIR
    ultron_tests:            Path = ULTRON_TESTS_DIR

    vault_knowledge:         Path = VAULT_KNOWLEDGE_DIR
    vault_decisions:         Path = VAULT_DECISIONS_DIR
    vault_patterns:          Path = VAULT_PATTERNS_DIR
    vault_skills:            Path = VAULT_SKILLS_DIR
    vault_sessions_log:      Path = VAULT_SESSIONS_LOG
    vault_cc_memories:       Path = VAULT_CC_MEMORIES
    vault_gitleaks_toml:     Path = VAULT_GITLEAKS_TOML

    codex_auth_json:         Path = CODEX_AUTH_JSON
    codex_config_toml:       Path = CODEX_CONFIG_TOML
    gemini_oauth_json:       Path = GEMINI_OAUTH_JSON
    gemini_settings_json:    Path = GEMINI_SETTINGS_JSON


P = _Paths()


# ─── Self-describe ────────────────────────────────────────────────────────────

def list_all() -> dict[str, str]:
    """Return all known paths as a flat dict (for diagnostics / `ultron paths` CLI)."""
    from dataclasses import fields
    return {f.name: str(getattr(P, f.name)) for f in fields(P)}


def main() -> int:
    """CLI: print all resolved paths as JSON. Useful for shell tooling parity."""
    print(json.dumps(list_all(), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
