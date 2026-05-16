#!/usr/bin/env python3
"""ULTRON v15 pre-roadmap F4 — auto-generate MEMORY.md from live state.

Reads:
  - ~/.ultron/cockpit/projects.json   (active projects)
  - ~/.ultron/cockpit/skill_graph.json (persona graph)
  - ~/.ultron/brain_index/index.db    (note count)
  - ~/.ultron/manifest.cache.json     (skill count)

Writes:
  - ~/.ultron/MEMORY.md               (≤400 tok target)

CLI:
  memory_md_generator.py generate     # rebuild MEMORY.md
  memory_md_generator.py preview      # print to stdout, do not write
  memory_md_generator.py stats        # show token estimate of current MEMORY.md
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from ultron_paths import COCKPIT_DIR, ULTRON_HOME  # noqa: E402

MEMORY_MD = ULTRON_HOME / "MEMORY.md"
PROJECTS_JSON = COCKPIT_DIR / "projects.json"
SKILL_GRAPH = COCKPIT_DIR / "skill_graph.json"
BRAIN_DB = ULTRON_HOME / "brain_index" / "index.db"
MANIFEST_CACHE = ULTRON_HOME / "manifest.cache.json"

MAX_PROJECTS = 5
MAX_PERSONAS = 14


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _brain_count() -> int | None:
    if not BRAIN_DB.exists():
        return None
    try:
        conn = sqlite3.connect(str(BRAIN_DB))
        try:
            return conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        finally:
            conn.close()
    except sqlite3.Error:
        return None


def _skill_count() -> int | None:
    data = _load_json(MANIFEST_CACHE)
    if isinstance(data, dict):
        skills = data.get("skills") or data.get("entries")
        if isinstance(skills, list):
            return len(skills)
    return None


def _short_path(path: str) -> str:
    """Trim home prefix and noisy intermediate dirs for a compact display."""
    if not path:
        return ""
    home = str(Path.home())
    if path.startswith(home):
        path = "~" + path[len(home):]
    parts = Path(path.replace("\\", "/")).parts
    if len(parts) <= 4:
        return "/".join(parts)
    return "/".join(parts[:1] + ("…",) + parts[-3:])


def _section_header() -> str:
    # Date only (not HH:MM) so git diffs are stable until vault content changes.
    today = datetime.now().strftime("%Y-%m-%d")
    return (
        f"# ULTRON MEMORY · auto-gen {today}\n"
        f"> `context.md` (≤400 tok) · `ultron status` · `brain_index.py query \"<x>\"` · vault L2 = SoT."
    )


def _section_sistema() -> str:
    brain = _brain_count()
    skills = _skill_count()
    bits = []
    if brain is not None:
        bits.append(f"brain_index: {brain} notas")
    if skills is not None:
        bits.append(f"skills: {skills}")
    bits.append("plans en `~/.ultron/plans/PLANS.json`")
    bits.append("changelog en `~/.claude/skills/ultron/references/changelog.md`")
    return "## SISTEMA\n\n" + " · ".join(bits) + "."


def _section_proyectos() -> str:
    data = _load_json(PROJECTS_JSON)
    if not isinstance(data, dict):
        return ""
    projects = data.get("projects") or []
    def sort_key(p):
        return (p.get("last_active") or "", 0 if p.get("status") == "manual" else -1)
    projects = sorted(projects, key=sort_key, reverse=True)
    rows = []
    for p in projects[:MAX_PROJECTS]:
        name = (p.get("name") or "?")[:22]
        lang = (p.get("language") or "")[:12]
        last = (p.get("last_active") or "")[:10]
        rows.append(f"| {name} | {lang} | {last} |")
    if not rows:
        return ""
    return (
        "## PROYECTOS\n\n"
        "| Nombre | Stack | Last |\n"
        "|---|---|---|\n"
        + "\n".join(rows)
        + "\n\nTotal en cockpit/projects.json. Detalle: `ultron status`."
    )


def _section_skill_graph() -> str:
    graph = _load_json(SKILL_GRAPH)
    if not isinstance(graph, list):
        return ""
    names = [n.get("persona") or "?" for n in graph[:MAX_PERSONAS]]
    if not names:
        return ""
    return (
        f"## SKILL GRAPH ({len(names)} personas)\n\n"
        + " · ".join(names) + ".\n\n"
        "Detalle por persona en `~/.claude/skills/ultron/references/routing-tables.md` (Layer 1) "
        "+ `cockpit/skill_graph.json` (knowledge_files)."
    )


def _section_quick_links() -> str:
    return (
        "## QUICK LINKS\n\n"
        "context.md · plans/MEGA-PLAN-v15.md + PLANS.json · "
        "references/{routing-tables,knowledge-domains,changelog}.md · "
        "`brain_index.py query` · `ultron doctor [--fix|--health-check|--security]`."
    )


def _section_USER() -> str:
    return (
        "## USER\n\n"
        "Grado Ing. Programación + PROGRAM_A Gráfica · UNIVERSITY · Europe/Madrid · "
        "Stack C++ (UE5) · C# (Unity) · TS · Python. "
        "Email <your-email>."
    )


def _section_footer() -> str:
    return "*Source-of-truth: vault L2 + brain_index FTS5. Esta es solo orientación.*"


def build_memory_md() -> str:
    parts = [
        _section_header(),
        _section_sistema(),
        _section_proyectos(),
        _section_skill_graph(),
        _section_quick_links(),
        _section_USER(),
        _section_footer(),
    ]
    return "\n\n---\n\n".join(p for p in parts if p) + "\n"


def cmd_generate(_args) -> int:
    text = build_memory_md()
    tmp = MEMORY_MD.with_suffix(MEMORY_MD.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(MEMORY_MD)
    tok_estimate = len(text) // 4
    print(f"[memory_md] MEMORY.md written: {len(text)} chars (~{tok_estimate} tok approx)")
    return 0


def cmd_preview(_args) -> int:
    print(build_memory_md())
    return 0


def cmd_stats(_args) -> int:
    if not MEMORY_MD.exists():
        print("[memory_md] MEMORY.md not found — run: memory_md_generator.py generate")
        return 1
    text = MEMORY_MD.read_text(encoding="utf-8")
    tok_estimate = len(text) // 4
    print(f"MEMORY.md: {len(text)} chars | ~{tok_estimate} tok approx | {len(text.splitlines())} lines")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="ULTRON MEMORY.md auto-generator (F4)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("generate").set_defaults(func=cmd_generate)
    sub.add_parser("preview").set_defaults(func=cmd_preview)
    sub.add_parser("stats").set_defaults(func=cmd_stats)
    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
