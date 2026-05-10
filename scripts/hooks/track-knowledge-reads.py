#!/usr/bin/env python3
"""
ULTRON HOOK · track-knowledge-reads · W2.2
PostToolUse hook: tracks Read calls on knowledge/skill files.

When ULTRON reads a knowledge file (e.g. gas.md, replication.md), this hook
appends the resolved path to `loaded_knowledge` in the session cache. On the
next turn, ULTRON checks loaded_knowledge before re-reading — avoiding
redundant reads of already-in-context material.

Watched roots:
  ~/.ultron/knowledge/**

Writes to: ~/.ultron/.tmp/current-session.json  →  {"loaded_knowledge": [...]}
"""
import json
import sys
from pathlib import Path

KNOWLEDGE_ROOTS = [
    Path.home() / ".ultron" / "knowledge",
    # skills/ excluido: SKILL.md de personas los gestiona el skill system,
    # no necesitan tracked en loaded_knowledge
]
SESSION_CACHE = Path.home() / ".ultron" / ".tmp" / "current-session.json"


def main():
    try:
        data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    if data.get("tool_name") != "Read":
        sys.exit(0)

    file_path_str = (data.get("tool_input") or {}).get("file_path", "")
    if not file_path_str:
        sys.exit(0)

    try:
        fp = Path(file_path_str).resolve()
    except Exception:
        sys.exit(0)

    if not any(fp.is_relative_to(root) for root in KNOWLEDGE_ROOTS):
        sys.exit(0)

    cache: dict = {}
    if SESSION_CACHE.exists():
        try:
            cache = json.loads(SESSION_CACHE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass

    loaded: list[str] = cache.get("loaded_knowledge", [])
    rel = str(fp)
    if rel not in loaded:
        loaded.append(rel)
        cache["loaded_knowledge"] = loaded
        SESSION_CACHE.parent.mkdir(parents=True, exist_ok=True)
        SESSION_CACHE.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8"
        )


if __name__ == "__main__":
    main()
