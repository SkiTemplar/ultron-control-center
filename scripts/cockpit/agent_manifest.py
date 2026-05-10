#!/usr/bin/env python3
"""
ULTRON v12.4 — Agent Manifest (Task 9)

Scans ~/.claude/agents/ and builds agent_manifest.json tracking all
Claude Code custom agents with their frontmatter metadata.

Stored at ~/.ultron/agent_manifest.json

Commands:
    agent_manifest.py rebuild    Scan agents dir and rebuild manifest
    agent_manifest.py status     Show all tracked agents
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

AGENTS_DIR     = Path.home() / ".claude" / "agents"
MANIFEST_PATH  = Path.home() / ".ultron" / "agent_manifest.json"

# Known categories per agent name prefix
_CATEGORIES: dict[str, str] = {
    "ultron-metadata":  "diagnostic",
    "ultron-security":  "diagnostic",
    "ultron-arch":      "diagnostic",
    "ultron-perf":      "diagnostic",
    "ultron-context":   "diagnostic",
}

_PHASE_MAP: dict[str, str] = {
    "ultron-metadata":  "Phase 0a",
    "ultron-security":  "Phase 0b",
    "ultron-arch":      "Phase 0b",
    "ultron-perf":      "Phase 0b",
    "ultron-context":   "Phase 0b",
}

_ORDER_MAP: dict[str, int] = {
    "ultron-metadata":  0,
    "ultron-security":  1,
    "ultron-arch":      1,
    "ultron-perf":      1,
    "ultron-context":   1,
}


def _parse_frontmatter(md_path: Path) -> dict:
    """Extract YAML frontmatter fields from a markdown agent file."""
    try:
        text = md_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    end = text.find("---", 3)
    if end == -1:
        return {}
    block = text[3:end].strip()
    result: dict = {}
    for line in block.splitlines():
        m = re.match(r'^(\w[\w-]*):\s*(.+)$', line.strip())
        if m:
            key, val = m.group(1), m.group(2).strip()
            result[key] = val
    return result


def _load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        try:
            return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"version": "1.0", "updated": "", "agents": {}}


def _save_manifest(data: dict) -> None:
    data["updated"] = datetime.now().isoformat()
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def cmd_rebuild(_args) -> int:
    data = _load_manifest()
    existing = data.get("agents", {})
    now = datetime.now().isoformat()

    if not AGENTS_DIR.exists():
        print(f"[agent_manifest] Agents dir not found: {AGENTS_DIR}")
        return 1

    found = 0
    new = 0
    for md_file in sorted(AGENTS_DIR.glob("*.md")):
        name = md_file.stem
        fm = _parse_frontmatter(md_file)
        try:
            mtime = datetime.fromtimestamp(md_file.stat().st_mtime).isoformat()
        except OSError:
            mtime = now

        entry = {
            "name":        name,
            "description": fm.get("description", ""),
            "tools":       fm.get("tools", ""),
            "model":       fm.get("model", ""),
            "category":    _CATEGORIES.get(name, "custom"),
            "phase":       _PHASE_MAP.get(name, ""),
            "run_order":   _ORDER_MAP.get(name, 99),
            "file":        str(md_file),
            "last_seen":   mtime,
            "status":      "active",
        }
        if name not in existing:
            existing[name] = entry
            new += 1
        else:
            existing[name].update(entry)
        found += 1

    # Mark missing agents as ghost
    for name in list(existing.keys()):
        if not (AGENTS_DIR / f"{name}.md").exists():
            existing[name]["status"] = "ghost"

    data["agents"] = dict(sorted(existing.items()))
    _save_manifest(data)
    print(f"[agent_manifest] Rebuilt: {found} agents  (new: {new})")
    print(f"                 Saved: {MANIFEST_PATH}")
    return 0


def cmd_status(_args) -> int:
    data = _load_manifest()
    agents = data.get("agents", {})
    if not agents:
        print("[agent_manifest] No agents tracked. Run: agent_manifest.py rebuild")
        return 1

    print(f"\nAgent Manifest  [{data.get('updated','never')[:16]}]  {len(agents)} agents")
    print("=" * 70)
    active = {n: a for n, a in agents.items() if a.get("status") == "active"}
    ghosts = {n: a for n, a in agents.items() if a.get("status") == "ghost"}

    # Group by category
    by_cat: dict[str, list] = {}
    for name, agent in sorted(active.items()):
        cat = agent.get("category", "custom")
        by_cat.setdefault(cat, []).append((name, agent))

    for cat, items in sorted(by_cat.items()):
        print(f"\n  [{cat.upper()}]  ({len(items)})")
        for name, agent in sorted(items, key=lambda x: x[1].get("run_order", 99)):
            phase = agent.get("phase", "")
            model = agent.get("model", "?").split("-")[0] if agent.get("model") else "?"
            phase_str = f"  {phase}" if phase else ""
            print(f"    {name:<30} model={model}{phase_str}")
            desc = agent.get("description", "")
            if desc:
                print(f"      {desc[:80]}{'…' if len(desc) > 80 else ''}")

    if ghosts:
        print(f"\n  [GHOST]  ({len(ghosts)})")
        for name in ghosts:
            print(f"    {name}")

    print()
    return 0


def main() -> int:
    import argparse
    p = argparse.ArgumentParser(description="ULTRON v12.4 Agent Manifest")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("rebuild", help="Scan agents dir and rebuild manifest")
    sub.add_parser("status",  help="Show all tracked agents")
    args = p.parse_args()
    if args.cmd == "rebuild": return cmd_rebuild(args)
    if args.cmd == "status":  return cmd_status(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
