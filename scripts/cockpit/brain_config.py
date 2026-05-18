#!/usr/bin/env python3
"""
ULTRON v12 BRAIN — central config loader.

Single source of truth for tunables that were previously hardcoded across
multiple scripts. Reads ~/.ultron/cockpit/brain-config.json. If absent,
returns built-in defaults and (optionally) writes the defaults file so
the user can edit it.

Tunables (with defaults):
    mode_ttl_hours              24      memory_sync.cmd_should_push
    decay_threshold_days        14      decay_queue.cmd_prime
    decay_max_prime_results     3       decay_queue.cmd_prime
    session_min_turns           4       session_compactor (skip below)
    session_min_user_chars      200     session_compactor (skip below)
    codex_timeout_sec           120     session_compactor
    brain_session_lookback_days 30      brain_index source discovery

FTS5 synonym expansion (W3.2):
    load_synonyms() -> dict[str, str]
        Returns merged dict: _BUILTIN_SYNONYMS + user overrides from
        SYNONYMS_PATH (~/.ultron/cockpit/query-synonyms.json).
        Keys are short terms (e.g. "desync"); values are FTS5 OR expressions
        (e.g. "desync OR replication OR NetUpdate OR RPC OR sync").
        Used by session_compactor.py and brain_index.py cmd_query.

CLI:
    brain_config.py show                Pretty-print effective config
    brain_config.py get <key>           Print one value (script-friendly)
    brain_config.py set <key> <value>   Update + persist (auto-types)
    brain_config.py reset               Restore defaults
    brain_config.py path                Print config file path
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CONFIG_DIR = Path.home() / ".ultron" / "cockpit"
CONFIG_PATH = CONFIG_DIR / "brain-config.json"
SYNONYMS_PATH = CONFIG_DIR / "query-synonyms.json"

DEFAULTS: dict[str, int | float | str] = {
    "mode_ttl_hours": 24,
    "decay_threshold_days": 14,
    "decay_max_prime_results": 3,
    "session_min_turns": 4,
    "session_min_user_chars": 200,
    "codex_timeout_sec": 120,
    "brain_session_lookback_days": 30,
}


_BUILTIN_SYNONYMS: dict[str, str] = {
    # UE5 / netcode
    "desync":       "desync OR replication OR NetUpdate OR RPC OR sync",
    "lag":          "lag OR replication OR netcode OR latency OR RTT",
    "multiplayer":  "multiplayer OR replication OR netcode OR session OR listen",
    "rollback":     "rollback OR netcode OR desync OR replication",
    # GAS / Unreal systems
    "ability":      "ability OR GAS OR GameplayAbility OR ASC OR AttributeSet",
    "attribute":    "attribute OR AttributeSet OR GAS OR GameplayEffect",
    "input":        "input OR InputAction OR IMC OR EnhancedInput OR mapping",
    "crash":        "crash OR assert OR ensure OR UFUNCTION OR nullptr",
    # Python tooling
    "package":      "package OR uv OR pip OR pyproject OR dependency",
    "lint":         "lint OR ruff OR mypy OR ty OR format",
    "test":         "test OR pytest OR hypothesis OR coverage OR fixture",
    # Web / Supabase
    "auth":         "auth OR supabase OR GoTrue OR RLS OR cookie OR session",
    "ssr":          "ssr OR nextjs OR ServerComponent OR ServerAction OR hydration",
    "database":     "database OR supabase OR RLS OR migration OR schema OR SQL",
    # Claude / ULTRON platform
    "skill":        "skill OR SKILL OR persona OR routing OR ULTRON",
    "hook":         "hook OR SessionStart OR PostToolUse OR Stop OR UserPrompt",
    "memory":       "memory OR vault OR brain OR INDEX OR decay OR session",
    "agent":        "agent OR subagent OR dispatch OR parallel OR fork",
    # v12.4 tree system / skill network
    "sync":         "sync OR sincronizar OR propagate OR drift OR unsynced OR registry",
    "addon":        "addon OR add-on OR MCP OR plugin OR extension OR Gemini-addon",
    "route":        "route OR routing OR handoff OR delegate OR dispatch OR persona",
    "repo-evaluator":     'repo-evaluator OR "repo-evaluator" OR audit OR score OR review OR findings',
    "skills_sync":  "skills_sync OR Sincronizar OR registry sync OR propagate OR checksum",
    "manifest":     "manifest OR skill_manifest OR registry OR category OR authority",
    "constitution": "constitution OR authority OR allowed_actions OR forbidden_actions OR safety_gate",
    "tree":         "tree OR L0 OR L1 OR L2 OR L3 OR L4 OR memory_level OR token_budget",
}

# ── v12.4 Tree Reading Policy ───────────────────────────────────────────────────
# Maps orchestration flow → allowed memory levels. Used by clipboard prompts and
# handoff contracts to declare which branches of the tree may be loaded.
FLOW_MEMORY_LEVELS: dict[str, list[str]] = {
    "skills_sync":          ["L1", "L2", "L3-current-skill-only"],
    "auditor_review":       ["L1", "L2", "L3-target-only"],
    "health_check":         ["L0", "L1"],
    "github_skill_search":  ["L0", "external"],
    "gemini_addon_search":  ["L0", "external", "L1-registry-summary"],
    "agent_sync":           ["L1", "L2", "L3-target-agent-only"],
    "session_start":        ["L0", "L1"],
    "code_implementation":  ["L0", "L1", "L3-target-files-only"],
    "code_review":          ["L1", "L2", "L3-target-only"],
    "architecture_review":  ["L0", "L1", "L2", "L3", "L4"],
    "memory_consolidation": ["L1", "L2"],
    "skill_creation":       ["L1", "L2", "L3-target-only"],
    "quick_factual":        ["L0"],
    "debug_unknown_bug":    ["L0", "L1", "L2", "L3-target-files-only"],
}


def tree_read_plan(flow: str) -> dict:
    """Return the tree-reading plan for a given orchestration flow.

    Result tells a skill which memory levels are allowed, the max token budget,
    and whether escalation to external context is permitted.
    """
    levels = FLOW_MEMORY_LEVELS.get(flow, ["L0", "L1"])
    has_external = "external" in levels or "L4" in levels
    has_l3 = any(l.startswith("L3") for l in levels)
    has_l2 = "L2" in levels

    token_caps = {False: 2000, True: 5000}  # rough budget with/without L3
    max_tokens = 20000 if has_external else (token_caps[has_l3] if has_l3 else (token_caps[has_l2]))

    return {
        "flow": flow,
        "memory_levels": levels,
        "max_tokens": max_tokens,
        "allow_external": has_external,
        "allow_l3": has_l3,
        "allow_l4": has_external,
    }


def load_synonyms() -> dict[str, str]:
    """Load FTS5 synonym expansions. Built-ins are the base; SYNONYMS_PATH
    entries override or extend them (merge, not replace)."""
    if SYNONYMS_PATH.exists():
        try:
            data = json.loads(SYNONYMS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {**_BUILTIN_SYNONYMS, **data}
        except (OSError, json.JSONDecodeError):
            pass
    return dict(_BUILTIN_SYNONYMS)


def load() -> dict:
    """Return the effective config (defaults overlaid with user file).
    Never raises — corrupt/missing file returns DEFAULTS unchanged."""
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            user = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(user, dict):
                cfg.update({k: v for k, v in user.items() if k in DEFAULTS})
        except (OSError, json.JSONDecodeError):
            pass
    return cfg


def save(cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(
        json.dumps(cfg, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def get_value(key: str):
    cfg = load()
    if key not in DEFAULTS:
        sys.stderr.write(
            f"[error] unknown config key: {key}\n"
            f"valid: {', '.join(sorted(DEFAULTS.keys()))}\n",
        )
        sys.exit(1)
    return cfg.get(key, DEFAULTS[key])


def _coerce(default, raw: str):
    """Coerce raw string to the default's type. Raises ValueError with a
    user-readable message instead of crashing the consumer at runtime."""
    if isinstance(default, bool):
        return raw.lower() in ("1", "true", "yes", "on")
    if isinstance(default, int):
        try:
            return int(raw)
        except ValueError:
            raise ValueError(f"value '{raw}' is not a valid int "
                              f"(default {default!r}, type int)")
    if isinstance(default, float):
        try:
            return float(raw)
        except ValueError:
            raise ValueError(f"value '{raw}' is not a valid float "
                              f"(default {default!r}, type float)")
    return raw


def cmd_show(_args) -> int:
    cfg = load()
    file_status = "user-overridden" if CONFIG_PATH.exists() else "(no file, defaults only)"
    print(f"⌬  ULTRON BRAIN config — {CONFIG_PATH}  [{file_status}]")
    print("=" * 70)
    for k, default in DEFAULTS.items():
        cur = cfg[k]
        marker = "  " if cur == default else "✱ "
        print(f"  {marker}{k:<32} = {cur}    (default: {default})")
    return 0


def cmd_get(args) -> int:
    print(get_value(args.key))
    return 0


def cmd_set(args) -> int:
    if args.key not in DEFAULTS:
        sys.stderr.write(
            f"[error] unknown config key: {args.key}\n"
            f"valid: {', '.join(sorted(DEFAULTS.keys()))}\n",
        )
        return 1
    try:
        coerced = _coerce(DEFAULTS[args.key], args.value)
    except ValueError as e:
        sys.stderr.write(f"[error] {e}\n")
        return 1
    # Sanity: reject negatives where they make no sense
    if isinstance(coerced, (int, float)) and coerced < 0:
        sys.stderr.write(
            f"[error] {args.key} must be non-negative (got {coerced})\n",
        )
        return 1
    cfg = load()
    cfg[args.key] = coerced
    save(cfg)
    print(f"[config] {args.key} = {cfg[args.key]} → {CONFIG_PATH}")
    return 0


def cmd_reset(_args) -> int:
    if CONFIG_PATH.exists():
        CONFIG_PATH.unlink()
    print(f"[config] reset (file removed) → defaults active")
    return 0


def cmd_path(_args) -> int:
    print(CONFIG_PATH)
    return 0


def cmd_synonyms(_args) -> int:
    syns = load_synonyms()
    user_keys: set[str] = set()
    if SYNONYMS_PATH.exists():
        try:
            data = json.loads(SYNONYMS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                user_keys = set(data.keys())
        except (OSError, json.JSONDecodeError):
            pass
    file_status = f"user file: {SYNONYMS_PATH}" if SYNONYMS_PATH.exists() else "(built-ins only, no user file)"
    print(f"⌬  ULTRON synonym expansions  [{file_status}]")
    print("=" * 70)
    for term, expansion in sorted(syns.items()):
        marker = "✱ " if term in user_keys else "  "
        print(f"  {marker}{term:<16} → {expansion}")
    print(f"\n  Total: {len(syns)} entries  "
          f"({len(syns) - len(user_keys)} built-in, {len(user_keys)} user)")
    return 0


def cmd_tree_plan(args) -> int:
    flow = getattr(args, "flow", None)
    if flow:
        plan = tree_read_plan(flow)
        print(f"⌬  Tree-read plan for: {flow}")
        print("=" * 50)
        for k, v in plan.items():
            print(f"  {k:<20} {v}")
    else:
        print("⌬  Available flows and memory levels:")
        print("=" * 70)
        for f, levels in sorted(FLOW_MEMORY_LEVELS.items()):
            print(f"  {f:<30} {' + '.join(levels)}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        prog="brain_config",
        description="ULTRON v12 BRAIN — central config get/set",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("show",
                    help="Pretty-print effective config").set_defaults(func=cmd_show)

    sp = sub.add_parser("get", help="Print one value")
    sp.add_argument("key")
    sp.set_defaults(func=cmd_get)

    sp = sub.add_parser("set", help="Update one value")
    sp.add_argument("key")
    sp.add_argument("value")
    sp.set_defaults(func=cmd_set)

    sub.add_parser("reset",
                    help="Remove config file (defaults take over)").set_defaults(
        func=cmd_reset)

    sub.add_parser("path",
                    help="Print config file path").set_defaults(func=cmd_path)

    sub.add_parser("synonyms",
                    help="List active FTS5 synonym expansions").set_defaults(
        func=cmd_synonyms)

    sp = sub.add_parser("tree-plan", help="Show tree-reading plan for a flow")
    sp.add_argument("flow", nargs="?", help="Flow name (omit to list all flows)")
    sp.set_defaults(func=lambda a: cmd_tree_plan(a))

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
