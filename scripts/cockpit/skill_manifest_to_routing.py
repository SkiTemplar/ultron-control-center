#!/usr/bin/env python3
"""
ULTRON v12.4.0 — Skill Manifest → Routing Gap Detector.

Compares skill_manifest.json (source of truth for installed skills)
against SKILL.md Layer 2 hardcoded routing table to find drift.

Outputs:
  - Skills in manifest with route_edges that are NOT in SKILL.md Layer 2
  - Skills in SKILL.md Layer 2 that are NOT in manifest (stale/renamed refs)
  - Skills in manifest that SHOULD have route_edges but don't (flagged by category)

Commands:
    skill_manifest_to_routing.py report        Full gap report
    skill_manifest_to_routing.py report --json  JSON output for scripting
    skill_manifest_to_routing.py check         Exit 0 if no gaps, 1 if gaps found
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SKILL_ROOT = Path.home() / ".claude" / "skills" / "ultron"
SKILL_MD = SKILL_ROOT / "SKILL.md"
MANIFEST_PATH = Path.home() / ".ultron" / "skill_manifest.json"


# ── Parsers ────────────────────────────────────────────────────────────────────

def _parse_layer2_from_skill_md() -> set[str]:
    """Extract plugin names from the Layer 2 table in SKILL.md.

    Returns a set of normalised skill slugs (strips plugin-namespace prefix,
    parenthetical notes, and backticks).
    """
    if not SKILL_MD.exists():
        print(f"[warn] SKILL.md not found: {SKILL_MD}", file=sys.stderr)
        return set()

    content = SKILL_MD.read_text(encoding="utf-8")

    # Find the Layer 2 section
    m = re.search(r"### Layer 2.*?\n(.*?)(?=\n###|\Z)", content, re.DOTALL)
    if not m:
        return set()

    table_text = m.group(1)
    plugins: set[str] = set()

    for line in table_text.splitlines():
        # Table row: | Señal | Plugin |
        cells = [c.strip() for c in line.split("|") if c.strip()]
        if len(cells) < 2:
            continue
        raw = cells[-1]  # last cell = plugin column
        # Strip backticks, parenthetical mode notes, leading/trailing spaces
        raw = re.sub(r"`", "", raw)
        raw = re.sub(r"\s*\(.*?\)", "", raw)  # remove (systematic-debugging) etc.
        # May be "frontend-design + ui-ux-pro-max" → split on +
        for part in raw.split("+"):
            slug = part.strip()
            # Normalise namespace: pr-review-toolkit:code-reviewer → code-reviewer
            if ":" in slug:
                slug = slug.split(":", 1)[1]
            if slug and not slug.startswith("-") and slug not in {"Plugin", "---"}:
                plugins.add(slug)

    # skill_finder is a cockpit script, not in manifest — exclude
    plugins.discard("skill_finder")
    return plugins


def _load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        print(f"[warn] skill_manifest.json not found: {MANIFEST_PATH}", file=sys.stderr)
        return {}
    try:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"[error] Could not read manifest: {e}", file=sys.stderr)
        return {}


# ── Analysis ───────────────────────────────────────────────────────────────────

# Skills that explicitly declare Layer 2 routing in route_edges
def _manifest_with_route_edges(skills: dict) -> dict[str, list[str]]:
    return {
        name: entry["route_edges"]
        for name, entry in skills.items()
        if entry.get("route_edges")
    }


# Skills that are "routing-relevant" by category but have no route_edges
_ROUTING_CATEGORIES = {
    "security", "code-quality", "testing", "frontend", "backend",
    "devops", "database", "api", "performance", "architecture",
}

def _manifest_should_have_routes(skills: dict) -> list[str]:
    return [
        name for name, entry in skills.items()
        if not entry.get("route_edges")
        and entry.get("category", "misc") in _ROUTING_CATEGORIES
        and entry.get("status") == "active"
    ]


def _run_analysis() -> dict:
    layer2_slugs = _parse_layer2_from_skill_md()
    manifest = _load_manifest()
    skills = manifest.get("skills", {})
    manifest_slugs = set(skills.keys())

    with_routes = _manifest_with_route_edges(skills)
    with_routes_slugs = set(with_routes.keys())

    # Layer 2 entries missing from manifest (stale/renamed)
    stale = sorted(layer2_slugs - manifest_slugs)

    # manifest skills with route_edges NOT represented in Layer 2
    unregistered = sorted(with_routes_slugs - layer2_slugs)

    # Skills in Layer 2 that ARE in manifest (healthy)
    healthy = sorted(layer2_slugs & manifest_slugs)

    # Skills that should have route_edges but don't (yellow flag, not critical)
    should_have = sorted(_manifest_should_have_routes(skills))

    return {
        "layer2_count": len(layer2_slugs),
        "manifest_count": len(manifest_slugs),
        "healthy": healthy,
        "stale_layer2_entries": stale,
        "unregistered_route_edges": unregistered,
        "flagged_missing_route_edges": should_have,
        "with_routes": with_routes,
    }


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_report(args) -> int:
    data = _run_analysis()

    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0

    print()
    print("Skill Manifest → Routing Gap Report")
    print("=" * 50)
    print(f"  SKILL.md Layer 2 entries:   {data['layer2_count']}")
    print(f"  skill_manifest.json skills:  {data['manifest_count']}")
    print(f"  Healthy (Layer 2 + manifest): {len(data['healthy'])}")
    print()

    stale = data["stale_layer2_entries"]
    if stale:
        print(f"STALE Layer 2 entries ({len(stale)}) — in SKILL.md but NOT in manifest:")
        for s in stale:
            print(f"  ✗ {s}")
        print()
    else:
        print("STALE Layer 2 entries: none")
        print()

    unregistered = data["unregistered_route_edges"]
    if unregistered:
        print(f"UNREGISTERED route_edges ({len(unregistered)}) — in manifest.route_edges but NOT in SKILL.md Layer 2:")
        for s in unregistered:
            routes = data["with_routes"].get(s, [])
            print(f"  + {s}  →  {routes}")
        print()
    else:
        print("UNREGISTERED route_edges: none")
        print()

    flagged = data["flagged_missing_route_edges"]
    if flagged:
        print(f"FLAGGED — routing-relevant skills with no route_edges ({len(flagged)}):")
        for s in flagged[:20]:  # cap at 20 to keep output readable
            print(f"  ? {s}")
        if len(flagged) > 20:
            print(f"  ... and {len(flagged) - 20} more")
        print()

    total_gaps = len(stale) + len(unregistered)
    if total_gaps == 0:
        print("Result: NO GAPS — Layer 2 and manifest are in sync.")
        return 0
    else:
        print(f"Result: {total_gaps} gap(s) found — update SKILL.md Layer 2 or skill_manifest route_edges.")
        return 1


def cmd_check(_args) -> int:
    data = _run_analysis()
    gaps = len(data["stale_layer2_entries"]) + len(data["unregistered_route_edges"])
    if gaps == 0:
        print("OK — no routing gaps detected.")
        return 0
    stale_n = len(data["stale_layer2_entries"])
    unreg_n = len(data["unregistered_route_edges"])
    print(f"GAPS DETECTED: {stale_n} stale Layer 2 entries, {unreg_n} unregistered route_edges.")
    return 1


# ── CLI ────────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(
        description="ULTRON — Skill Manifest ↔ SKILL.md Layer 2 gap detector"
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    p_report = sub.add_parser("report", help="Full gap report")
    p_report.add_argument("--json", action="store_true", help="JSON output")

    sub.add_parser("check", help="Exit 0 if no gaps, 1 if gaps found (for CI)")

    args = p.parse_args()

    if args.cmd == "report":
        return cmd_report(args)
    elif args.cmd == "check":
        return cmd_check(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
