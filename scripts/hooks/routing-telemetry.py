#!/usr/bin/env python3
"""
ULTRON HOOK · routing-telemetry · v1.0 (v8.1.2)
Append una línea JSONL por invocación de Skill o Agent a `~/.ultron/sessions/YYYY-MM-DD/routing.jsonl`.
Habilita medición empírica de uso por persona/plugin/subagente — base para benchmarks 9.7+ con datos reales.

Diseño deliberadamente liviano:
- Solo registra Skill (persona/plugin) y Agent (subagent_type) — el routing real
- NO registra cada Read/Edit/Bash — eso satura el log y no aporta señal de routing
- Append-only JSONL — fácil de parsear con jq/Python sin parser markdown

Uso en ~/.claude/settings.json:
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Skill|Agent",
      "hooks": [{
        "type": "command",
        "command": "python %USERPROFILE%/.ultron/scripts/hooks/routing-telemetry.py"
      }]
    }]
  }
}

Schema de cada entry (una línea JSON):
{
  "ts": "2026-04-27T12:34:56",
  "session_id": "abc12345",
  "tool": "Skill" | "Agent",
  "target": "<skill-name>" | "<subagent_type>",
  "kind": "persona" | "plugin" | "subagent" | "skill",
  "cwd": "%USERPROFILE%/..."
}
"""
import json
import sys
from datetime import datetime
from pathlib import Path


# v13.0 (Sprint 2 FIX-3.1): persona list now derived from skill_manifest.json
# via personas_ssot SSOT. Legacy hardcoded set replaced with dynamic import.
# Falls back to a minimal hardcoded set if the cockpit module is unavailable
# (defensive — hooks must never crash even with broken cockpit).
try:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "cockpit"))
    from personas_ssot import PERSONAS  # frozenset[str], includes legacy aliases
except ImportError:
    PERSONAS = frozenset({
        "terry-davis", "gamedev-engineer", "mike-tyson", "jordan-belfort", "einstein",
        "novalbos", "personal-assistant", "windows-admin", "profesor-fisica", "tio-gilito", "warren",
        "repo-evaluator", "Kirkardo", "kirkardo", "manolo-lama", "tolkien",
        # backwards-compat aliases for deprecated stubs
        "don-claudio", "pana", "alfred",
    })


def classify_skill(name: str) -> str:
    if name in PERSONAS:
        return "persona"
    if ":" in name:
        return "plugin"
    return "skill"


def main():
    try:
        data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    if tool_name not in ("Skill", "Agent"):
        sys.exit(0)

    tool_input = data.get("tool_input") or {}
    if tool_name == "Skill":
        target = tool_input.get("skill", "")
        kind = classify_skill(target) if target else "skill"
    else:
        target = tool_input.get("subagent_type", "general-purpose")
        kind = "subagent"

    if not target:
        sys.exit(0)

    today = datetime.now().strftime("%Y-%m-%d")
    sessions_dir = Path.home() / ".ultron" / "sessions" / today
    sessions_dir.mkdir(parents=True, exist_ok=True)
    log_file = sessions_dir / "routing.jsonl"

    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "session_id": (data.get("session_id") or "?"),
        "tool": tool_name,
        "target": target,
        "kind": kind,
        "cwd": data.get("cwd", "?"),
    }

    with log_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
