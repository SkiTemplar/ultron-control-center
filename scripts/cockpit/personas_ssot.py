#!/usr/bin/env python3
"""
ULTRON v13.0 — Personas SSOT (Sprint 2 FIX-3.1).

Single source of truth for the persona list. Derives from `skill_manifest.json`
(which itself is the canonical SSOT post-Sprint-2).

Before Sprint 2 there were FIVE persona-list sources:
  1. ~/.claude/skills/ultron/hooks/routing-telemetry.py:41-46 (set)
  2. ~/.claude/skills/ultron/scripts/cockpit/skill_manifest.py:42-46 (set)
  3. ~/.ultron/skill_manifest.json (category=persona entries — 13 items)
  4. ~/.claude/skills/ultron/references/routing-tables.md (markdown table)
  5. ~/.claude/skills/ultron/scripts/cockpit/tui.py:1140 LAYER1_PERSONAS

After Sprint 2 there is ONE: this module reads (3) and consumers (1, 2, 4, 5)
import from here.

Public API:
    from personas_ssot import personas, PERSONAS, persona_aliases
    personas()           → list[dict]  (full entries from manifest)
    PERSONAS             → frozenset[str] (canonical names — drop-in replacement
                                          for the legacy hardcoded sets)
    persona_aliases()    → dict[str, str] (legacy_alias → canonical_name —
                                           closes the Kirkardo/kirkardo case dup)
    is_persona(name)     → bool (True if name OR an alias matches a canonical)

Caching: manifest is read once per Python process (cached at module import).
For long-running processes call `refresh()` to force re-read.
"""
from __future__ import annotations

import json
import sys
from functools import lru_cache
from pathlib import Path

# Local import — ultron_paths is the SSOT for filesystem locations (F12)
sys.path.insert(0, str(Path(__file__).parent))
from ultron_paths import SKILL_MANIFEST_JSON


# Legacy aliases that consumers might still pass — map to canonical names.
# Add here when discovering more historical aliases. NEVER add new aliases —
# they should always resolve to the canonical slug.
_LEGACY_ALIASES = {
    "Kirkardo": "repo-evaluator",       # legacy display name
    "kirkardo": "repo-evaluator",       # legacy lowercase variant
}


def _load_manifest() -> dict:
    """Read manifest. Returns empty dict on any error (degrades gracefully)."""
    if not SKILL_MANIFEST_JSON.exists():
        return {}
    try:
        return json.loads(SKILL_MANIFEST_JSON.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


@lru_cache(maxsize=1)
def _persona_entries() -> tuple[dict, ...]:
    """All manifest entries with category=='persona'. Frozen tuple of dicts.

    LRU-cached — call refresh() to invalidate after manifest write.
    """
    manifest = _load_manifest()
    skills = manifest.get("skills", {})
    if not isinstance(skills, dict):
        return ()
    return tuple(
        {**entry, "name": name}
        for name, entry in sorted(skills.items())
        if entry.get("category") == "persona"
    )


def personas() -> list[dict]:
    """Full persona entries (mutable copy). Sorted by name."""
    return [dict(e) for e in _persona_entries()]


@lru_cache(maxsize=1)
def _canonical_names() -> frozenset[str]:
    return frozenset(e["name"] for e in _persona_entries())


def persona_aliases() -> dict[str, str]:
    """Legacy aliases (case variants, old display names) → canonical slug."""
    return dict(_LEGACY_ALIASES)


def is_persona(name: str) -> bool:
    """True if name (or any of its legacy aliases) is a canonical persona."""
    if name in _canonical_names():
        return True
    canonical = _LEGACY_ALIASES.get(name)
    return canonical is not None and canonical in _canonical_names()


def refresh() -> None:
    """Invalidate cache — call after manifest write."""
    _persona_entries.cache_clear()
    _canonical_names.cache_clear()


# ─── Drop-in replacements for legacy hardcoded sets ────────────────────────────

# Equivalent to the legacy `PERSONAS = {...}` set in routing-telemetry.py and
# `_ULTRON_PERSONAS = {...}` in skill_manifest.py — but derived from manifest.
# Includes the canonical names PLUS legacy aliases so existing call sites
# (`if name in PERSONAS:`) keep working without changes.
PERSONAS = frozenset(_canonical_names() | set(_LEGACY_ALIASES.keys()))


# ─── CLI for diagnostics ───────────────────────────────────────────────────────

def main() -> int:
    """CLI: print persona list (one per line) or full JSON with --json."""
    args = set(sys.argv[1:])
    if "--json" in args:
        out = {
            "canonical": sorted(_canonical_names()),
            "aliases": dict(_LEGACY_ALIASES),
            "all_routing_keys": sorted(PERSONAS),
            "count_canonical": len(_canonical_names()),
            "count_with_aliases": len(PERSONAS),
        }
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return 0
    if "--check" in args:
        # Sanity check: verify none of the canonical names collide with aliases
        bad = [a for a in _LEGACY_ALIASES if a in _canonical_names()]
        if bad:
            print(f"FAIL: alias also canonical: {bad}", file=sys.stderr)
            return 1
        for canon in _LEGACY_ALIASES.values():
            if canon not in _canonical_names():
                print(f"FAIL: alias target '{canon}' not in manifest", file=sys.stderr)
                return 1
        print(f"OK: {len(_canonical_names())} canonical, {len(_LEGACY_ALIASES)} aliases, no conflicts")
        return 0
    # default: list canonical names
    for name in sorted(_canonical_names()):
        print(name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
