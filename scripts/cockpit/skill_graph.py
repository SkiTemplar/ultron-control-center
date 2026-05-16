#!/usr/bin/env python3
"""
ULTRON v13.2 — Skill Graph generator.

Parses the SKILL GRAPH section from ~/.ultron/MEMORY.md and exports
a machine-readable JSON for quick persona→memory lookups.

Schema: [{persona, domain, connects_to: [], memory_layer}]

CLI:
    skill_graph.py generate   # parse MEMORY.md → skill_graph.json
    skill_graph.py show       # pretty-print current graph
    skill_graph.py query <persona>  # show connections for a persona
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ultron_paths import ULTRON_HOME, COCKPIT_DIR

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

MEMORY_MD       = ULTRON_HOME / "MEMORY.md"
SKILL_GRAPH_JSON = COCKPIT_DIR / "skill_graph.json"

# Row in the MEMORY.md text table (4 tab/space-separated columns)
# Persona  Domain  Connects_with  Memory_layer
_ROW_RE = re.compile(
    r"^(?P<persona>\S+)\s{2,}"
    r"(?P<domain>[^\t]+?)\s{2,}"
    r"(?P<connects>[^\t]+?)\s{2,}"
    r"(?P<memory>\S+)\s*$"
)


def _parse_memory_md() -> list[dict]:
    if not MEMORY_MD.exists():
        return []
    text = MEMORY_MD.read_text(encoding="utf-8")
    # Find the SKILL GRAPH block
    in_block = False
    nodes: list[dict] = []
    seen: set[str] = set()

    for line in text.splitlines():
        if "SKILL GRAPH" in line or "SKILL-GRAPH" in line:
            in_block = True
            continue
        if in_block:
            if line.startswith("##"):  # new section → stop
                break
            if line.startswith("─") or "Persona" in line or not line.strip():
                continue
            m = _ROW_RE.match(line.strip())
            if not m:
                continue
            persona = m.group("persona").strip()
            if persona in seen:  # skip (ver arriba) duplicates
                continue
            if "(ver arriba)" in line or "↑" in line:
                continue
            seen.add(persona)
            connects_raw = m.group("connects").strip()
            connects = [c.strip() for c in connects_raw.split(",") if c.strip() and c.strip() != "(ninguna)"]
            memory = m.group("memory").strip()
            if memory == "(ninguna)":
                memory = ""
            nodes.append({
                "persona": persona,
                "domain": m.group("domain").strip(),
                "connects_to": connects,
                "memory_layer": memory,
            })
    return nodes


def _load_json() -> list[dict]:
    if not SKILL_GRAPH_JSON.exists():
        return []
    try:
        return json.loads(SKILL_GRAPH_JSON.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def cmd_generate(_args) -> int:
    nodes = _parse_memory_md()
    if not nodes:
        nodes = _hardcoded_baseline()
    else:
        # Merge knowledge_files from hardcoded baseline into parsed nodes
        # (MEMORY.md table doesn't have a knowledge_files column)
        baseline_map = {n["persona"]: n for n in _hardcoded_baseline()}
        for node in nodes:
            if node["persona"] in baseline_map:
                base = baseline_map[node["persona"]]
                if "knowledge_files" not in node:
                    node["knowledge_files"] = base.get("knowledge_files", [])
                # Also correct the memory_layer to the real vault path
                if not node.get("memory_layer") or node["memory_layer"] in {"(ninguna)", ""}:
                    node["memory_layer"] = base.get("memory_layer", "")
                elif "/" not in node.get("memory_layer", ""):
                    node["memory_layer"] = base.get("memory_layer", node["memory_layer"])
    SKILL_GRAPH_JSON.parent.mkdir(parents=True, exist_ok=True)
    SKILL_GRAPH_JSON.write_text(
        json.dumps(nodes, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8"
    )
    print(f"[skill_graph] generated {len(nodes)} nodes → {SKILL_GRAPH_JSON}")
    return 0


def cmd_show(_args) -> int:
    nodes = _load_json()
    if not nodes:
        print("[skill_graph] no data — run: skill_graph.py generate")
        return 1
    print(f"{'PERSONA':<16} {'DOMAIN':<28} {'CONNECTS_TO':<28} {'MEMORY'}")
    print("─" * 90)
    for n in nodes:
        connects = ", ".join(n.get("connects_to", [])) or "(ninguna)"
        memory = n.get("memory_layer") or "(ninguna)"
        print(f"{n['persona']:<16} {n['domain'][:27]:<28} {connects[:27]:<28} {memory}")
    return 0


def cmd_query(args) -> int:
    persona = args.persona.lower()
    nodes = _load_json()
    matches = [n for n in nodes if n["persona"].lower() == persona]
    if not matches:
        # Try partial match
        matches = [n for n in nodes if persona in n["persona"].lower()]
    if not matches:
        print(f"[skill_graph] persona '{args.persona}' not found")
        return 1
    for n in matches:
        print(json.dumps(n, indent=2, ensure_ascii=False))
    return 0


def _hardcoded_baseline() -> list[dict]:
    # knowledge_files: specific .md files to Read when this persona activates.
    # Paths relative to ~/.ultron/knowledge/ (junction → vault/10_KNOWLEDGE/).
    return [
        {"persona": "gamedev-engineer", "aliases": ["don-claudio"], "domain": "UE5·Unity·netcode",         "connects_to": ["cpp-pro", "ue5-dev"],         "memory_layer": "knowledge/cpp-ue5/",       "knowledge_files": ["cpp-ue5/gas.md", "cpp-ue5/replication.md", "cpp-ue5/enhanced-input.md", "cpp-ue5/multiplayer.md"]},
        {"persona": "novalbos",         "domain": "C++·Gráfica·IA·low-lvl",    "connects_to": ["research-explainer", "cpp-pro"], "memory_layer": "knowledge/cpp-modern/",    "knowledge_files": ["cpp-modern/cpp-23-features.md", "opengl/pipeline.md", "opengl/shaders.md"]},
        {"persona": "senior-engineer",  "aliases": ["terry-davis"], "domain": "refactor·git·deuda",         "connects_to": ["focused-fix"],                "memory_layer": "",                          "knowledge_files": []},
        {"persona": "research-explainer","aliases": ["einstein"], "domain": "investiga·física·math",      "connects_to": ["novalbos"],                   "memory_layer": "",                          "knowledge_files": []},
        {"persona": "investment-advisor","aliases": ["warren"],   "domain": "bolsa·finanzas",             "connects_to": ["tio-gilito"],                 "memory_layer": "",                          "knowledge_files": []},
        {"persona": "tio-gilito",       "domain": "finanzas personales",        "connects_to": ["investment-advisor"],         "memory_layer": "knowledge/finance/",        "knowledge_files": ["finance/tio-gilito-context.md"]},
        {"persona": "windows-admin",    "aliases": ["alfred"],     "domain": "Windows·CLI·scripts",        "connects_to": ["openjarvis"],                 "memory_layer": "knowledge/claude-platform/","knowledge_files": ["claude-platform/subagents-and-hooks.md", "claude-platform/codex-cli.md"]},
        {"persona": "openjarvis",       "domain": "DevOps·cloud·Docker",        "connects_to": ["windows-admin"],              "memory_layer": "",                          "knowledge_files": []},
        {"persona": "obliteratus",      "domain": "rewrite·purga·deuda",        "connects_to": ["senior-engineer"],            "memory_layer": "",                          "knowledge_files": []},
        {"persona": "manolo-lama",      "domain": "ventas·persuasión",          "connects_to": [],                             "memory_layer": "",                          "knowledge_files": []},
        {"persona": "tolkien",          "domain": "narrativa·escritura",        "connects_to": [],                             "memory_layer": "",                          "knowledge_files": []},
        {"persona": "personal-assistant","aliases": ["pana"],      "domain": "productividad·archivos",     "connects_to": ["windows-admin"],              "memory_layer": "",                          "knowledge_files": []},
        {"persona": "shannon",          "domain": "información·teoría",         "connects_to": ["novalbos"],                   "memory_layer": "",                          "knowledge_files": []},
        {"persona": "business-strategist","aliases": ["jordan-belfort"], "domain": "pitch·estrategia",           "connects_to": ["investment-advisor"],         "memory_layer": "",                          "knowledge_files": []},
        {"persona": "ui-designer",      "aliases": ["mike-tyson"],  "domain": "UI·UX·design",              "connects_to": ["senior-engineer"],            "memory_layer": "",                          "knowledge_files": []},
    ]


def main() -> int:
    p = argparse.ArgumentParser(description="ULTRON v13.2 Skill Graph")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("generate", help="Parse MEMORY.md → skill_graph.json").set_defaults(func=cmd_generate)
    sub.add_parser("show", help="Print current graph").set_defaults(func=cmd_show)
    sq = sub.add_parser("query", help="Show connections for a persona")
    sq.add_argument("persona")
    sq.set_defaults(func=cmd_query)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
