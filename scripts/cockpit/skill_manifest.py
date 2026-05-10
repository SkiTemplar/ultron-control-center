#!/usr/bin/env python3
"""
ULTRON v13.7.0 — Skills Manifest CLI (S4 "MANIFEST")

Single Source of Truth (SSOT) for skill routing metadata.
YAML manifest: ~/.ultron/skills.manifest.yaml
JSON cache:    ~/.ultron/manifest.cache.json  (consumed by intent-dispatcher.py)
Schema:        ~/.ultron/config/skills-manifest-schema.json

S4 commands (new):
    list [--deprecated] [--source X] [--format table|json]
    sync      auto-discover + rebuild YAML + regenerate cache
    validate  JSON Schema validation + drift report (no auto-fix)
    add <name> --source X [--triggers a,b] [--tags x,y]
    deprecate <name>

Legacy commands (v12.4 compat stubs):
    rebuild       -> delegates to sync
    status        -> delegates to list
    sync-prompt   -> shows clipboard instructions

PILAR I: no subprocess calls in this module (pure Python).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, date
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

# ── Paths ─────────────────────────────────────────────────────────────────────

HOME = Path.home()
ULTRON_HOME = HOME / ".ultron"
MANIFEST_YAML = ULTRON_HOME / "skills.manifest.yaml"
MANIFEST_CACHE = ULTRON_HOME / "manifest.cache.json"
SCHEMA_PATH = ULTRON_HOME / "config" / "skills-manifest-schema.json"
TELEMETRY_JSONL = ULTRON_HOME / "telemetry" / "sync-events.jsonl"
SKILLS_DIR = HOME / ".claude" / "skills"

# ── YAML helpers ──────────────────────────────────────────────────────────────

def _yaml_available() -> bool:
    try:
        import yaml  # noqa: F401
        return True
    except ImportError:
        return False


def _load_yaml(path: Path) -> list[dict]:
    """Load manifest YAML safely. Returns [] on missing or empty."""
    if not path.exists():
        return []
    import yaml
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        if data is None:
            return []
        if isinstance(data, list):
            return data
        return []
    except Exception as exc:
        print(f"[skill_manifest] ERROR loading {path}: {exc}", file=sys.stderr)
        return []


def _save_yaml(path: Path, entries: list[dict]) -> None:
    """Atomic write: write to .tmp then os.replace.

    Codex S4 H3 fix: previous version did `path.unlink() + tmp.rename()`
    which leaves a window where path doesn't exist (if process crashes
    between unlink and rename). On Windows, os.replace is atomic at the
    filesystem level — the target file is replaced in one operation, never
    appearing as missing to concurrent readers (e.g. intent-dispatcher).
    """
    import os
    import yaml
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".yaml.tmp")
    tmp.write_text(
        yaml.dump(entries, allow_unicode=True, sort_keys=False, default_flow_style=False),
        encoding="utf-8",
    )
    os.replace(tmp, path)


def _today() -> str:
    return date.today().isoformat()


# ── Frontmatter parser ────────────────────────────────────────────────────────

_FM_NONE = object()       # sentinel: no frontmatter present
_FM_MALFORMED = object()  # sentinel: frontmatter present but unparseable
# Codex S4 M4 fix: distinguish "no frontmatter" from "broken frontmatter".
# Auto-discover skips both, but the latter must be visible in telemetry so
# silently-skipped skills don't disappear from the manifest unnoticed.


def _parse_frontmatter(text: str) -> dict | None | object:
    """Extract YAML frontmatter from SKILL.md text.

    Returns:
      dict           — successfully parsed YAML mapping
      _FM_NONE       — no frontmatter present (file doesn't open with `---`)
      _FM_MALFORMED  — frontmatter delimiters found but YAML failed to parse
                        (yaml.safe_load raised, OR result was not a dict)
    """
    text = text.lstrip("﻿")  # strip UTF-8 BOM (common on Windows)
    if not text.startswith("---"):
        return _FM_NONE
    end = text.find("---", 3)
    if end == -1:
        return _FM_NONE
    import yaml
    try:
        fm = yaml.safe_load(text[3:end])
    except Exception:
        return _FM_MALFORMED
    if not isinstance(fm, dict):
        return _FM_MALFORMED
    return fm


# ── Auto-discover ─────────────────────────────────────────────────────────────

def _auto_discover_entries(
    existing_names: set[str],
    malformed_paths: list[str] | None = None,
) -> list[dict]:
    """
    Scan ~/.claude/skills/*/SKILL.md for KTP frontmatter.
    Returns list of new entries NOT already in existing_names.

    Codex S4 M4 fix: when `malformed_paths` is provided, paths whose
    frontmatter fails YAML parsing are appended to it so the caller can
    surface them via telemetry (otherwise broken skills disappear silently).
    """
    if not SKILLS_DIR.exists():
        return []

    new_entries: list[dict] = []
    today = _today()

    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir():
            continue
        if skill_dir.name.startswith(".") or skill_dir.name in ("__pycache__",):
            continue

        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            continue

        try:
            text = skill_md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        fm = _parse_frontmatter(text)
        if fm is _FM_MALFORMED:
            if malformed_paths is not None:
                malformed_paths.append(str(skill_md))
            continue
        if fm is _FM_NONE or not isinstance(fm, dict):
            continue

        # Use the directory name as the canonical ID
        skill_id = skill_dir.name

        if skill_id in existing_names:
            continue

        entry: dict[str, Any] = {
            "name": skill_id,
            "source": "auto-discover",
            "triggers": _synthesize_triggers(skill_id, fm),
            "tags": _extract_tags(fm),
            "cost_tier": _infer_cost_tier(fm),
            "dispatcher_priority": 3,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": _extract_description(fm, skill_id),
        }

        # Preserve KTP fields if present
        for ktp in ("kind", "category", "tier"):
            if fm.get(ktp):
                entry[ktp] = fm[ktp]

        new_entries.append(entry)

    return new_entries


def _synthesize_triggers(skill_id: str, fm: dict) -> list[str]:
    """Synthesize trigger keywords from skill ID and frontmatter."""
    import re
    triggers = []
    parts = re.split(r"[:\-_]", skill_id.lower())
    triggers.extend(p for p in parts if len(p) > 2 and p not in ("pro", "dev", "the", "and"))
    if fm.get("category") and fm["category"] not in triggers:
        triggers.append(fm["category"].lower())
    seen: set[str] = set()
    result = []
    for t in triggers:
        if t not in seen:
            seen.add(t)
            result.append(t)
    return result or [skill_id.lower()]


def _extract_tags(fm: dict) -> list[str]:
    tags = []
    for field in ("category", "kind", "tier"):
        if fm.get(field):
            tags.append(str(fm[field]).lower())
    return tags


def _infer_cost_tier(fm: dict) -> str:
    kind = fm.get("kind", "").lower()
    return {"persona": "medium", "meta": "high", "hookify": "low",
            "mcp": "medium", "skill": "medium"}.get(kind, "medium")


def _extract_description(fm: dict, skill_id: str) -> str:
    if fm.get("description"):
        desc = str(fm["description"]).strip()
        return desc[:117] + "..." if len(desc) > 120 else desc
    return f"{skill_id} skill"


# ── Well-known skills (canonical 22 from mock + intent-rules) ─────────────────

def _wellknown() -> list[dict]:
    """Return the canonical well-known skills. Called at runtime so _today() is fresh."""
    today = _today()
    return [
        {
            "name": "superpowers:systematic-debugging",
            "source": "plugin",
            "triggers": ["bug", "debug", "error", "crash", "stack trace", "exception",
                         "traceback", "fix", "corrige", "corrigeme"],
            "tags": ["debugging", "error-recovery"],
            "cost_tier": "medium",
            "dispatcher_priority": 1,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Root-cause debugging methodology via systematic 5-step process",
        },
        {
            "name": "superpowers:test-driven-development",
            "source": "plugin",
            "triggers": ["test", "tdd", "spec", "unit test", "fixture", "pytest", "tests", "testing"],
            "tags": ["testing", "tdd"],
            "cost_tier": "medium",
            "dispatcher_priority": 2,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "TDD workflow with Red-Green-Refactor cycle",
        },
        {
            "name": "superpowers:requesting-code-review",
            "source": "plugin",
            "triggers": ["review", "revisa", "código", "code review", "check my code",
                         "feedback on code"],
            "tags": ["code-review", "quality"],
            "cost_tier": "medium",
            "dispatcher_priority": 2,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Code review request workflow",
        },
        {
            "name": "superpowers:receiving-code-review",
            "source": "plugin",
            "triggers": ["received review", "comments on pr", "review feedback", "address review"],
            "tags": ["code-review", "quality"],
            "cost_tier": "medium",
            "dispatcher_priority": 3,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Receiving and acting on code review feedback",
        },
        {
            "name": "superpowers:write-plan",
            "source": "plugin",
            "triggers": ["plan", "planifica", "roadmap", "sprint plan", "writing a plan"],
            "tags": ["planning"],
            "cost_tier": "medium",
            "dispatcher_priority": 2,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Plan writing workflow",
        },
        {
            "name": "superpowers:execute-plan",
            "source": "plugin",
            "triggers": ["execute plan", "implement plan", "follow plan", "ejecuta el plan"],
            "tags": ["planning", "execution"],
            "cost_tier": "medium",
            "dispatcher_priority": 2,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Plan execution workflow",
        },
        {
            "name": "superpowers:brainstorming",
            "source": "plugin",
            "triggers": ["brainstorm", "ideas", "lluvia de ideas", "think of", "ideation"],
            "tags": ["brainstorming", "creativity"],
            "cost_tier": "low",
            "dispatcher_priority": 3,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Structured brainstorming",
        },
        {
            "name": "superpowers:dispatching-parallel-agents",
            "source": "plugin",
            "triggers": ["parallel agents", "spawn agents", "subagents", "multiple agents"],
            "tags": ["agents", "orchestration"],
            "cost_tier": "high",
            "dispatcher_priority": 2,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Parallel agent orchestration",
        },
        {
            "name": "agent-skills:plan",
            "source": "plugin",
            "triggers": ["plan", "arquitectura", "architecture", "diseña", "design",
                         "system design"],
            "tags": ["planning", "architecture"],
            "cost_tier": "high",
            "dispatcher_priority": 2,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Planning and architecture agent skill",
        },
        {
            "name": "agent-skills:build",
            "source": "plugin",
            "triggers": ["build", "implement", "implementa", "crear feature", "code it"],
            "tags": ["implementation"],
            "cost_tier": "high",
            "dispatcher_priority": 2,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Build/implement agent skill",
        },
        {
            "name": "agent-skills:review",
            "source": "plugin",
            "triggers": ["review", "revisa", "audit", "audita", "check"],
            "tags": ["review", "audit"],
            "cost_tier": "medium",
            "dispatcher_priority": 3,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Review agent skill",
        },
        {
            "name": "agent-skills:test",
            "source": "plugin",
            "triggers": ["test", "testing", "qa", "quality assurance", "write tests"],
            "tags": ["testing"],
            "cost_tier": "medium",
            "dispatcher_priority": 3,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Test agent skill",
        },
        {
            "name": "skill-creator:skill-creator",
            "source": "plugin",
            "triggers": ["skill", "crea skill", "nuevo skill", "create skill", "skill creator"],
            "tags": ["skill-creation"],
            "cost_tier": "medium",
            "dispatcher_priority": 2,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Create new Claude Code skills",
        },
        {
            "name": "ultron",
            "source": "built-in",
            "triggers": ["ultron", "memory", "memoria", "context", "contexto", "vault",
                         "brain index"],
            "tags": ["system", "memory"],
            "cost_tier": "low",
            "dispatcher_priority": 1,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "ULTRON system management",
        },
        {
            "name": "don-claudio",
            "source": "persona",
            "triggers": ["español", "castellano", "spanish mode", "habla español",
                         "en español"],
            "tags": ["persona", "spanish"],
            "cost_tier": "low",
            "dispatcher_priority": 3,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Spanish-language expert assistant",
        },
        {
            "name": "alfred",
            "source": "persona",
            "triggers": ["alfred", "assistant mode", "help me organize", "personal assistant"],
            "tags": ["persona", "assistant"],
            "cost_tier": "low",
            "dispatcher_priority": 2,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Personal assistant mode — Windows OS, files, processes",
        },
        {
            "name": "jordan-belfort",
            "source": "persona",
            "triggers": ["ventas", "sales", "pitch", "persuasion", "negociación",
                         "negotiation"],
            "tags": ["persona", "sales"],
            "cost_tier": "low",
            "dispatcher_priority": 3,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Sales and persuasion expert",
        },
        {
            "name": "novalbos",
            "source": "persona",
            "triggers": ["novalbos", "proyecto novalbos", "novalbos project"],
            "tags": ["persona", "project"],
            "cost_tier": "low",
            "dispatcher_priority": 3,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Novalbos project context",
        },
        {
            "name": "ue5-dev",
            "source": "plugin",
            "triggers": ["ue5", "unreal engine", "blueprint", "c++ ue5", "unreal", "gamedev",
                         "game development"],
            "tags": ["game", "unreal", "cpp"],
            "cost_tier": "medium",
            "dispatcher_priority": 2,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Unreal Engine 5 C++ and Blueprint development",
        },
        {
            "name": "python-pro",
            "source": "plugin",
            "triggers": ["python", "pep8", "asyncio", "python script", "pythonic"],
            "tags": ["python", "engineering"],
            "cost_tier": "medium",
            "dispatcher_priority": 3,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Type-safe, production-ready Python development",
        },
        {
            "name": "typescript-pro",
            "source": "plugin",
            "triggers": ["typescript", "ts", "type safety", "interface", "generics typescript"],
            "tags": ["typescript", "engineering"],
            "cost_tier": "medium",
            "dispatcher_priority": 3,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "TypeScript expert",
        },
        {
            "name": "second-opinion",
            "source": "plugin",
            "triggers": ["second opinion", "otra opinión", "peer review",
                         "validate approach", "contrastar"],
            "tags": ["review", "codex", "gemini"],
            "cost_tier": "high",
            "dispatcher_priority": 3,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": today,
            "description": "Get a second opinion via Codex or Gemini",
        },
    ]


# ── Telemetry ─────────────────────────────────────────────────────────────────

def _write_telemetry(event: str, data: dict) -> None:
    try:
        TELEMETRY_JSONL.parent.mkdir(parents=True, exist_ok=True)
        entry = json.dumps(
            {"ts": datetime.now().isoformat(timespec="seconds"),
             "source": "skill_manifest", "event": event, **data},
            ensure_ascii=False,
        )
        with TELEMETRY_JSONL.open("a", encoding="utf-8") as f:
            f.write(entry + "\n")
    except OSError:
        pass


# ── Cache regeneration ────────────────────────────────────────────────────────

def _regenerate_cache(entries: list[dict]) -> None:
    """
    Project manifest YAML -> manifest.cache.json.

    DISPATCHER CONTRACT (must never break):
      {version, generated_ts, skills: [{id, triggers, description, ...}]}

    "id" and "triggers" are LOAD-BEARING keys the dispatcher reads.
    Extra fields per skill are additive and safe.
    Deprecated skills are EXCLUDED from the cache (no routing for them).
    """
    cache_skills = []
    for entry in entries:
        if entry.get("deprecated", False):
            continue
        skill_name = entry.get("name", "")
        if not skill_name:
            continue
        cache_skills.append({
            "id": skill_name,                          # LOAD-BEARING
            "triggers": entry.get("triggers", []),     # LOAD-BEARING
            "description": entry.get("description", f"{skill_name} skill"),
            # Additive extras (never remove id/triggers):
            "deprecated": False,
            "source": entry.get("source", "auto-discover"),
            "cost_tier": entry.get("cost_tier", "medium"),
        })

    cache = {
        "version": "0.2-S4",
        "generated_ts": datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "skill_manifest sync",
        "skills": cache_skills,
    }

    # Codex S4 H3 fix: os.replace is atomic on Windows — no window where
    # MANIFEST_CACHE is missing for the LIVE intent-dispatcher hook.
    import os
    MANIFEST_CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = MANIFEST_CACHE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cache, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, MANIFEST_CACHE)


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_list(args) -> int:
    show_deprecated = getattr(args, "deprecated", False)
    source_filter = getattr(args, "source", None)
    fmt = getattr(args, "format", "table")

    entries = _load_yaml(MANIFEST_YAML)

    filtered = [
        e for e in entries
        if (show_deprecated or not e.get("deprecated", False))
        and (not source_filter or e.get("source") == source_filter)
    ]

    if not filtered:
        print("(no entries match the filter)", file=sys.stderr)
        return 0

    if fmt == "json":
        print(json.dumps(filtered, indent=2, ensure_ascii=False))
        return 0

    header = f"{'NAME':<45} {'SOURCE':<14} {'COST':<8} {'PRI':<4} {'DEPR':<5} {'TRIGGERS'}"
    print(header)
    print("-" * len(header))
    for e in filtered:
        name = e.get("name", "?")[:44]
        source = e.get("source", "?")[:13]
        cost = e.get("cost_tier", "?")[:7]
        pri = str(e.get("dispatcher_priority", "?"))[:3]
        depr = "yes" if e.get("deprecated") else "no"
        triggers_list = e.get("triggers", [])
        triggers = ", ".join(triggers_list[:3])
        if len(triggers_list) > 3:
            triggers += " ..."
        print(f"{name:<45} {source:<14} {cost:<8} {pri:<4} {depr:<5} {triggers}")

    print(f"\n{len(filtered)} skill(s) shown")
    return 0


def cmd_sync(args) -> int:
    """Auto-discover + rebuild YAML + regenerate cache."""
    entries = _load_yaml(MANIFEST_YAML)
    existing_names: set[str] = {e.get("name") for e in entries if e.get("name")}

    wk_list = _wellknown()
    wk_names = {wk["name"] for wk in wk_list}

    # 1. Ensure wellknown skills are present; update last_synced for existing
    added_wellknown = 0
    for wk in wk_list:
        if wk["name"] not in existing_names:
            entries.append(dict(wk))
            existing_names.add(wk["name"])
            added_wellknown += 1
        else:
            for e in entries:
                if e.get("name") == wk["name"]:
                    e["last_synced"] = _today()
                    break

    # 2. Auto-discover from SKILL.md frontmatter (Codex S4 M4: capture
    # paths with malformed frontmatter so they're visible in telemetry/stderr).
    malformed_paths: list[str] = []
    new_entries = _auto_discover_entries(existing_names, malformed_paths)
    entries.extend(new_entries)
    existing_names.update(e.get("name") for e in new_entries if e.get("name"))
    if malformed_paths:
        print(
            f"[manifest sync] WARNING: {len(malformed_paths)} SKILL.md file(s) "
            f"have malformed frontmatter — skipped silently before this fix:",
            file=sys.stderr,
        )
        for p in malformed_paths[:10]:
            print(f"  {p}", file=sys.stderr)
        if len(malformed_paths) > 10:
            print(f"  ...and {len(malformed_paths) - 10} more", file=sys.stderr)

    # 3. Auto-deprecate: auto-discover entries whose SKILL.md no longer exists
    disk_ids: set[str] = set()
    if SKILLS_DIR.exists():
        for d in SKILLS_DIR.iterdir():
            if d.is_dir() and not d.name.startswith(".") and (d / "SKILL.md").exists():
                disk_ids.add(d.name)

    auto_deprecated = 0
    for entry in entries:
        name = entry.get("name", "")
        if name in wk_names:
            continue
        if (entry.get("source") == "auto-discover"
                and name not in disk_ids
                and not entry.get("deprecated", False)):
            entry["deprecated"] = True
            auto_deprecated += 1

    # 4. Codex S4 H1 fix: validate against JSON Schema BEFORE writing the
    # live cache. A malformed manifest could degrade the dispatcher's
    # routing on every prompt; we'd rather refuse the sync than poison the
    # live path. jsonschema is installed via S2-B; if absent we fall back
    # to a basic structural check.
    schema_errors: list[str] = []
    try:
        import jsonschema  # type: ignore[import]
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        for err in jsonschema.Draft202012Validator(schema).iter_errors(entries):
            schema_errors.append(f"{err.json_path}: {err.message}")
    except ImportError:
        # Fallback: each entry must have name (str) and triggers (list[str])
        for i, e in enumerate(entries):
            if not isinstance(e.get("name"), str) or not e.get("name"):
                schema_errors.append(f"entries[{i}].name: not a non-empty string")
            triggers = e.get("triggers")
            if not isinstance(triggers, list) or not all(
                isinstance(t, str) and t for t in triggers
            ):
                schema_errors.append(f"entries[{i}].triggers: not a list of non-empty strings")

    if schema_errors:
        print("[manifest sync] ABORTED — schema validation failed:", file=sys.stderr)
        for err in schema_errors[:20]:
            print(f"  {err}", file=sys.stderr)
        if len(schema_errors) > 20:
            print(f"  ...and {len(schema_errors) - 20} more", file=sys.stderr)
        print("Cache NOT regenerated — fix manifest.yaml and retry.", file=sys.stderr)
        return 1

    # 5. Save YAML + regenerate cache (only after validation passes)
    _save_yaml(MANIFEST_YAML, entries)
    _regenerate_cache(entries)

    # 5-C. S5-C: record provenance for newly-added entries so the doctor's
    # security mode can detect later drift. Best-effort — never block sync.
    try:
        import sys as _sys
        _here = str(Path(__file__).resolve().parent)
        if _here not in _sys.path:
            _sys.path.insert(0, _here)
        import skill_provenance as _provenance  # type: ignore[import-not-found]
        for ne in new_entries:
            name = ne.get("name", "")
            if not name:
                continue
            src = ne.get("source", "auto-discover")
            kind = _provenance._infer_source_kind(src) if isinstance(src, str) else "unknown"
            try:
                _provenance.record_install(
                    name, source_kind=kind,
                    source_url=src if isinstance(src, str) else None,
                )
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass

    # 6. Telemetry (Codex S4 M4: include malformed_count for visibility)
    _write_telemetry("sync", {
        "total": len(entries),
        "added_wellknown": added_wellknown,
        "added_auto_discover": len(new_entries),
        "auto_deprecated": auto_deprecated,
        "malformed_skipped": len(malformed_paths),
    })

    print("[manifest sync] OK")
    print(f"  Total entries:      {len(entries)}")
    print(f"  Added (wellknown):  {added_wellknown}")
    print(f"  Added (discovery):  {len(new_entries)}")
    print(f"  Auto-deprecated:    {auto_deprecated}")
    print(f"  Cache:              {MANIFEST_CACHE}")
    print(f"  YAML:               {MANIFEST_YAML}")
    return 0


def cmd_validate(args) -> int:
    """JSON Schema validation + drift report. Exit 1 if drift/errors found."""
    entries = _load_yaml(MANIFEST_YAML)

    schema_errors: list[str] = []
    try:
        import jsonschema
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        for error in jsonschema.Draft202012Validator(schema).iter_errors(entries):
            schema_errors.append(f"  SCHEMA: {error.json_path} — {error.message}")
    except ImportError:
        print("[validate] WARNING: jsonschema not installed — skipping schema validation",
              file=sys.stderr)
    except Exception as exc:
        schema_errors.append(f"  SCHEMA ERROR: {exc}")

    manifest_names = {e.get("name") for e in entries if e.get("name")}
    wk_names = {wk["name"] for wk in _wellknown()}

    disk_ids: set[str] = set()
    if SKILLS_DIR.exists():
        for d in SKILLS_DIR.iterdir():
            if d.is_dir() and not d.name.startswith(".") and (d / "SKILL.md").exists():
                disk_ids.add(d.name)

    on_disk_not_in_manifest = disk_ids - manifest_names - wk_names
    in_manifest_not_on_disk = {
        e.get("name") for e in entries
        if (e.get("name") and not e.get("deprecated", False)
            and e.get("name") not in wk_names
            and e.get("source") == "auto-discover"
            and e.get("name") not in disk_ids)
    }

    has_issues = bool(schema_errors or on_disk_not_in_manifest or in_manifest_not_on_disk)

    if schema_errors:
        print(f"Schema violations ({len(schema_errors)}):")
        for err in schema_errors:
            print(err)
        print()

    if on_disk_not_in_manifest:
        print(f"Drift A — On disk NOT in manifest ({len(on_disk_not_in_manifest)}):")
        for name in sorted(on_disk_not_in_manifest):
            print(f"  + {name}")
        print()

    if in_manifest_not_on_disk:
        print(f"Drift B — In manifest NOT on disk ({len(in_manifest_not_on_disk)}):")
        for name in sorted(in_manifest_not_on_disk):
            print(f"  - {name}")
        print()

    if not has_issues:
        print(f"[validate] OK — {len(entries)} entries, no drift, no schema errors")

    return 1 if has_issues else 0


_SKILL_NAME_RE = __import__("re").compile(r"^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,127}$")
# Codex S4 M1 fix: skill_name validation. Without it, cmd_add accepts any
# string including newlines/control chars that would corrupt YAML, JSON
# cache, routing lines and telemetry. Triggers/tags get the same control-
# char strip below.


def _sanitize_token(value: str, max_len: int = 128) -> str | None:
    """Return a sanitized token (no control chars/newlines) or None if invalid."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    # Reject any C0/C1 control char (newline, tab, NUL, etc.)
    if any(ord(c) < 32 or ord(c) == 127 for c in cleaned):
        return None
    if len(cleaned) > max_len:
        return None
    return cleaned


def cmd_add(args) -> int:
    """Add a skill entry idempotently."""
    skill_name = args.skill_name

    # Codex S4 M1 fix: strict validation.
    if not isinstance(skill_name, str) or not _SKILL_NAME_RE.fullmatch(skill_name):
        print(
            f"[add] ERROR: invalid skill_name {skill_name!r}. "
            f"Must match ^[A-Za-z0-9][A-Za-z0-9_.:-]{{0,127}}$ "
            f"(alnum start, then alnum/underscore/dot/colon/dash, ≤128 chars).",
            file=sys.stderr,
        )
        return 2

    source = args.source
    triggers_raw = getattr(args, "triggers", None) or ""
    tags_raw = getattr(args, "tags", None) or ""

    triggers = [
        t for t in (_sanitize_token(s) for s in triggers_raw.split(",")) if t
    ] or [skill_name]
    tags = [
        t for t in (_sanitize_token(s) for s in tags_raw.split(",")) if t
    ]

    entries = _load_yaml(MANIFEST_YAML)
    existing_names = {e.get("name") for e in entries}

    if skill_name in existing_names:
        print(f"[add] NOTICE: '{skill_name}' already in manifest — no-op (idempotent)",
              file=sys.stderr)
        return 0

    entries.append({
        "name": skill_name,
        "source": source,
        "triggers": triggers,
        "tags": tags,
        "cost_tier": "medium",
        "dispatcher_priority": 3,
        "deprecated": False,
        "replaces": [],
        "last_used": None,
        "last_synced": _today(),
        "description": f"{skill_name} skill",
    })

    _save_yaml(MANIFEST_YAML, entries)
    _regenerate_cache(entries)
    _write_telemetry("add", {"skill": skill_name, "source": source})
    print(f"[add] Added '{skill_name}' (source={source})")
    return 0


def cmd_deprecate(args) -> int:
    """Mark a skill deprecated. Idempotent."""
    skill_name = args.skill_name

    entries = _load_yaml(MANIFEST_YAML)
    found = False
    for entry in entries:
        if entry.get("name") == skill_name:
            if entry.get("deprecated"):
                print(f"[deprecate] NOTICE: '{skill_name}' already deprecated — no-op",
                      file=sys.stderr)
            else:
                entry["deprecated"] = True
                print(f"[deprecate] '{skill_name}' marked deprecated")
            found = True
            break

    if not found:
        print(f"[deprecate] ERROR: '{skill_name}' not found in manifest", file=sys.stderr)
        return 1

    _save_yaml(MANIFEST_YAML, entries)
    _regenerate_cache(entries)
    _write_telemetry("deprecate", {"skill": skill_name})
    return 0


def set_security_status(skill_name: str, status: str,
                          reason: str | None = None) -> bool:
    """F05 fix: mark a manifest entry with a security status.

    Used when a registry sync surfaces a `quarantine` decision: we set
    ``deprecated=True`` AND ``security_status="quarantine_pending"`` so
    downstream consumers (router, cockpit) can distinguish a benign
    deprecation from a security-driven one.

    Returns True if the entry was updated (or already in the desired
    state), False if the skill_name is not in the manifest.
    """
    if not isinstance(skill_name, str) or not skill_name.strip():
        return False
    entries = _load_yaml(MANIFEST_YAML)
    found = False
    for entry in entries:
        if entry.get("name") != skill_name:
            continue
        entry["deprecated"] = True
        entry["security_status"] = status
        if reason:
            entry["security_status_reason"] = reason
        found = True
        break
    if not found:
        return False
    _save_yaml(MANIFEST_YAML, entries)
    _regenerate_cache(entries)
    return True


def deprecate(skill_name: str,
              reason: str | None = None) -> bool:
    """Programmatic deprecate (mirror of cmd_deprecate without argparse).

    F05 fix: callable from registry_sync when a security verdict says
    quarantine. Stores ``security_status_reason`` so the verdict's
    rule_id is auditable from the manifest alone.
    """
    if not isinstance(skill_name, str) or not skill_name.strip():
        return False
    entries = _load_yaml(MANIFEST_YAML)
    found = False
    for entry in entries:
        if entry.get("name") != skill_name:
            continue
        entry["deprecated"] = True
        if reason:
            entry["security_status_reason"] = reason
        found = True
        break
    if not found:
        return False
    _save_yaml(MANIFEST_YAML, entries)
    _regenerate_cache(entries)
    return True


# ── Legacy compat stubs (v12.4 commands still referenced in ultron.ps1) ───────

def cmd_status_legacy(args) -> int:
    """Legacy 'status' -> delegates to list."""
    # Create a minimal args-like object for cmd_list
    class _ListArgs:
        deprecated = False
        source = None
        format = "table"
    return cmd_list(_ListArgs())


def cmd_rebuild_legacy(args) -> int:
    """Legacy 'rebuild' -> delegates to sync."""
    class _SyncArgs:
        pass
    return cmd_sync(_SyncArgs())


def cmd_sync_prompt_legacy(args) -> int:
    """Legacy 'sync-prompt' -> print instructions."""
    print("[skill_manifest] sync-prompt: To identify untracked skills, run:")
    print("  ultron manifest sync")
    print("  ultron manifest validate")
    print("  ultron manifest list --format json | clip")
    return 0


# ── CLI entry ─────────────────────────────────────────────────────────────────

def main() -> int:
    if not _yaml_available():
        print("[skill_manifest] ERROR: PyYAML not installed. Run: uv pip install pyyaml",
              file=sys.stderr)
        return 1

    p = argparse.ArgumentParser(
        description="ULTRON Skills Manifest CLI (S4 SSOT)",
        epilog="YAML: ~/.ultron/skills.manifest.yaml | Cache: ~/.ultron/manifest.cache.json",
    )
    sub = p.add_subparsers(dest="cmd")

    # S4 commands
    list_p = sub.add_parser("list", help="List skills (filterable)")
    list_p.add_argument("--deprecated", action="store_true")
    list_p.add_argument("--source", metavar="SOURCE")
    list_p.add_argument("--format", choices=["table", "json"], default="table")

    sub.add_parser("sync", help="Auto-discover + rebuild YAML + regenerate cache")
    sub.add_parser("validate", help="JSON Schema + drift report (no auto-fix)")

    add_p = sub.add_parser("add", help="Add skill entry idempotently")
    add_p.add_argument("skill_name", metavar="SKILL_NAME")
    add_p.add_argument("--source", required=True,
                       choices=["built-in", "plugin", "mcp", "persona", "hookify", "auto-discover"])
    add_p.add_argument("--triggers", metavar="A,B,C")
    add_p.add_argument("--tags", metavar="X,Y")

    dep_p = sub.add_parser("deprecate", help="Mark a skill deprecated")
    dep_p.add_argument("skill_name", metavar="SKILL_NAME")

    # Legacy compat
    sub.add_parser("status", help="[legacy] alias for list")
    sub.add_parser("rebuild", help="[legacy] alias for sync")
    sub.add_parser("sync-prompt", help="[legacy] clipboard instructions")

    args = p.parse_args()

    dispatch = {
        "list": cmd_list,
        "sync": cmd_sync,
        "validate": cmd_validate,
        "add": cmd_add,
        "deprecate": cmd_deprecate,
        # Legacy stubs
        "status": cmd_status_legacy,
        "rebuild": cmd_rebuild_legacy,
        "sync-prompt": cmd_sync_prompt_legacy,
    }

    fn = dispatch.get(args.cmd)
    if not fn:
        p.print_help()
        return 1

    return fn(args)


if __name__ == "__main__":
    sys.exit(main())
