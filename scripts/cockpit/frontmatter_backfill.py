#!/usr/bin/env python3
"""
ULTRON v13.0 — SKILL.md frontmatter backfill (Sprint 2 F2.2).

Reads ~/.ultron/skill_manifest.json + ~/.ultron/agent_manifest.json + the
claude_exclusive list and writes the missing v13.0 contract fields to each
SKILL.md frontmatter.

Idempotent — already-correct fields are left untouched. Body is preserved
verbatim (comments inside frontmatter ARE lost — see CLI `--preserve-yaml`
to bail out on files with unrecognized YAML structure).

Mappings:

    kind:
      - manifest.type == 'persona'                       → persona
      - name in agent_manifest.agents                    → agent
      - manifest.category == 'persona'                   → persona
      - name in claude_exclusive (registry+manifest set) → meta (high-touch
                                                                  ULTRON-internal)
      - default                                          → skill

    tier:
      - manifest.memory_layer (L1|L2|L3)
      - default                                          → L2

    category:
      - manifest.category (free string)
      - default                                          → 'misc'

    last_verified:
      - if missing → today (YYYY-MM-DD) when --set-verified is passed
      - never overwritten unless --force-verified

CLI:
    frontmatter_backfill.py dry-run [--limit N]
    frontmatter_backfill.py apply  [--limit N] [--set-verified]
    frontmatter_backfill.py one <slug>
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ultron_paths import (
    CLAUDE_SKILLS_DIR, SKILL_MANIFEST_JSON, SKILLS_REGISTRY_JSON, AGENT_MANIFEST_JSON,
)
from skill_manifest_validate import (
    parse_frontmatter, FRONTMATTER_RE, validate_skill,
    VALID_KINDS, VALID_TIERS,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def load_manifest_data() -> tuple[dict, dict, set[str]]:
    """Returns (skill_manifest_dict, agent_manifest_dict, claude_exclusive_set)."""
    sm = {}
    if SKILL_MANIFEST_JSON.exists():
        sm = json.loads(SKILL_MANIFEST_JSON.read_text(encoding="utf-8"))
    am = {}
    if AGENT_MANIFEST_JSON.exists():
        am = json.loads(AGENT_MANIFEST_JSON.read_text(encoding="utf-8"))
    ce = set()
    if SKILLS_REGISTRY_JSON.exists():
        try:
            reg = json.loads(SKILLS_REGISTRY_JSON.read_text(encoding="utf-8"))
            ce = set(reg.get("claude_exclusive", []))
        except (json.JSONDecodeError, OSError):
            pass
    return sm, am, ce


def derive_fields(name: str, sm: dict, am: dict, ce: set[str]) -> dict[str, str]:
    """Compute the v13.0 fields for a skill from manifest data."""
    skills_d = sm.get("skills", {}) if isinstance(sm.get("skills"), dict) else {}
    entry = skills_d.get(name, {})
    agent_entry = am.get("agents", {}).get(name) if am else None

    # kind — priority order: persona > agent > meta > plugin > skill
    if entry.get("type") == "persona" or entry.get("category") == "persona":
        kind = "persona"
    elif agent_entry is not None or entry.get("type") == "agent":
        kind = "agent"
    elif (entry.get("category") == "meta"
          or entry.get("authority") == "orchestrator"
          or name in ce):
        kind = "meta"
    elif entry.get("type") == "plugin":
        kind = "plugin"
    else:
        kind = "skill"

    # tier
    tier = entry.get("memory_layer") or "L2"
    if tier not in VALID_TIERS:
        tier = "L2"

    # category — prefer manifest, fallback to kind-bucketed
    cat = entry.get("category")
    if not cat:
        cat = kind  # better than 'misc' for new skills
    return {"kind": kind, "tier": tier, "category": cat}


def derive_ztmsi_fields(skill_dir: Path, text: str) -> dict:
    """S2-A: Compute ZTMSI KTP fields for frontmatter backfill.

    Returns a dict with keys: tags (list), token_est (int), layer (str).
    These are computed idempotently — caller only adds missing keys.

    Layer must match the vocabulary used by brain_index._extract_domain so
    metadata stays consistent across the index and the source frontmatter.
    For SKILL.md files this is "L1-skills" (NOT bare "L1").

    Tags: best-effort from skill name and path components. Empty list if no
    signal available.
    """
    # layer: SKILL.md files are L1-skills in brain_index — must match vocab
    layer = "L1-skills"

    # token_est: GPT-style approximation of the full file content
    token_est = len(text) // 4

    # tags: derive from name parts (split on hyphens) + any YAML tags already present
    name = skill_dir.name
    name_tags = [t for t in name.split("-") if len(t) >= 3]  # skip very short tokens

    return {
        "tags": name_tags,
        "token_est": token_est,
        "layer": layer,
    }


def _serialize_yaml_value(v) -> str:
    """Serialize a field value to inline YAML.

    Lists → YAML inline list style: [a, b, c]
    Scalars → str(v)
    """
    if isinstance(v, list):
        if not v:
            return "[]"
        return "[" + ", ".join(str(x) for x in v) + "]"
    return str(v)


def rewrite_frontmatter(text: str, fields_to_add: dict) -> str:
    """Append fields to existing frontmatter, preserving body and existing keys.

    If the frontmatter is missing entirely, prepend a minimal block. Existing
    keys are NEVER overwritten — backfill is purely additive.

    Supports list values (serialized as YAML inline list).
    """
    m = FRONTMATTER_RE.match(text)
    if not m:
        # No frontmatter — prepend a fresh block (with body intact)
        new_block = "---\n" + "\n".join(
            f"{k}: {_serialize_yaml_value(v)}" for k, v in fields_to_add.items()
        ) + "\n---\n"
        return new_block + text

    existing_block = m.group(1)
    existing_keys = set()
    # parse keys (cheap — first ':' on each line at column 0)
    for line in existing_block.splitlines():
        if line and not line.startswith(" ") and not line.startswith("\t") and ":" in line:
            existing_keys.add(line.split(":", 1)[0].strip())

    additions = []
    for k, v in fields_to_add.items():
        if k not in existing_keys:
            additions.append(f"{k}: {_serialize_yaml_value(v)}")

    if not additions:
        return text  # nothing to add

    # Insert additions at end of frontmatter block (before closing ---)
    new_block = existing_block.rstrip() + "\n" + "\n".join(additions)
    return text[:m.start()] + f"---\n{new_block}\n---" + text[m.end():]


def backfill_one(skill_dir: Path, sm: dict, am: dict, ce: set[str],
                  *, apply: bool, set_verified: bool) -> tuple[str, list[str]]:
    """Returns (status, log_lines). status in {'ok', 'noop', 'invalid', 'error'}."""
    name = skill_dir.name
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return "missing", [f"  - SKILL.md not found"]

    try:
        text = skill_md.read_text(encoding="utf-8")
    except OSError as e:
        return "error", [f"  - read: {e}"]

    derived = derive_fields(name, sm, am, ce)
    if set_verified:
        derived["last_verified"] = date.today().isoformat()

    # S2-A: add ZTMSI KTP fields (tags, token_est, layer) — idempotent, additive only
    ztmsi = derive_ztmsi_fields(skill_dir, text)
    derived.update(ztmsi)

    new_text = rewrite_frontmatter(text, derived)
    if new_text == text:
        return "noop", []

    log = []
    fm, _ = parse_frontmatter(text)
    for k, v in derived.items():
        if k not in fm:
            log.append(f"  + {k}: {_serialize_yaml_value(v)}")

    if apply:
        try:
            skill_md.write_text(new_text, encoding="utf-8")
        except OSError as e:
            return "error", [f"  - write: {e}"]
        return "ok", log
    return "ok-dry", log


def discover_skills() -> list[Path]:
    if not CLAUDE_SKILLS_DIR.exists():
        return []
    return sorted(d for d in CLAUDE_SKILLS_DIR.iterdir()
                  if d.is_dir() and not d.name.startswith("."))


# ─── CLI ───────────────────────────────────────────────────────────────────────

def _run(apply: bool, limit: int | None, set_verified: bool):
    sm, am, ce = load_manifest_data()
    skills = discover_skills()
    if limit:
        skills = skills[:limit]
    counters = {"ok": 0, "ok-dry": 0, "noop": 0, "missing": 0, "error": 0}
    for sk in skills:
        status, log = backfill_one(sk, sm, am, ce, apply=apply, set_verified=set_verified)
        counters[status] = counters.get(status, 0) + 1
        if log:
            print(f"{sk.name}: {status}")
            for line in log:
                print(line)
    print()
    verb = "WROTE" if apply else "WOULD WRITE"
    n_changes = counters['ok'] + counters['ok-dry']
    print(f"[backfill] {verb} {n_changes} | unchanged={counters['noop']} | missing={counters['missing']} | error={counters['error']}")


def cmd_dry_run(args):
    _run(apply=False, limit=args.limit, set_verified=False)
    return 0


def cmd_apply(args):
    _run(apply=True, limit=args.limit, set_verified=args.set_verified)
    return 0


def cmd_one(args):
    sm, am, ce = load_manifest_data()
    sk = CLAUDE_SKILLS_DIR / args.slug
    if not sk.is_dir():
        print(f"[backfill] not found: {sk}", file=sys.stderr)
        return 2
    derived = derive_fields(sk.name, sm, am, ce)
    print(f"derived for {sk.name}: {derived}")
    status, log = backfill_one(sk, sm, am, ce, apply=args.apply,
                                 set_verified=args.set_verified)
    print(f"status: {status}")
    for line in log:
        print(line)
    return 0 if status not in {"error"} else 1


def main():
    p = argparse.ArgumentParser(prog="frontmatter_backfill",
                                description="ULTRON v13.0 SKILL.md frontmatter backfill")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp_dr = sub.add_parser("dry-run", help="Preview changes without writing")
    sp_dr.add_argument("--limit", type=int)
    sp_dr.set_defaults(func=cmd_dry_run)

    sp_a = sub.add_parser("apply", help="Write changes to SKILL.md files")
    sp_a.add_argument("--limit", type=int)
    sp_a.add_argument("--set-verified", action="store_true",
                      help="Also stamp last_verified to today on missing")
    sp_a.set_defaults(func=cmd_apply)

    sp_o = sub.add_parser("one", help="Process one skill by slug")
    sp_o.add_argument("slug")
    sp_o.add_argument("--apply", action="store_true")
    sp_o.add_argument("--set-verified", action="store_true")
    sp_o.set_defaults(func=cmd_one)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
