#!/usr/bin/env python3
"""
ULTRON HOOK · routing-telemetry · v1.1 (v15.2)
Append una línea JSONL por invocación de Skill, Agent o Task a `~/.ultron/sessions/YYYY-MM-DD/routing.jsonl`.
Habilita medición empírica de uso por persona/plugin/subagente — base para benchmarks 9.7+ con datos reales.

Diseño deliberadamente liviano:
- Registra Skill (persona/plugin), Agent (legacy subagent_type) y Task (current subagent_type) — el routing real
- NO registra cada Read/Edit/Bash — eso satura el log y no aporta señal de routing
- Append-only JSONL — fácil de parsear con jq/Python sin parser markdown

v1.1: "Task" es el nombre canónico actual del tool de Claude Code para invocar
subagentes; "Agent" se mantiene como alias legacy. Ambos producen entries con
`kind == "subagent"` pero con `tool` distinto, lo que permite cuantificar
agent invocations en `agent_telemetry.py`.

Uso en ~/.claude/settings.json:
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Skill|Agent|Task",
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
  "tool": "Skill" | "Agent" | "Task",
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
        "senior-engineer", "gamedev-engineer", "ui-designer", "business-strategist",
        "research-explainer", "windows-admin", "repo-evaluator",
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
    # v1.1: "Task" es el tool canónico actual para subagentes; "Agent" se acepta
    # como alias legacy (mismo shape de tool_input.subagent_type).
    if tool_name not in ("Skill", "Agent", "Task"):
        sys.exit(0)

    tool_input = data.get("tool_input") or {}
    if tool_name == "Skill":
        target = tool_input.get("skill", "")
        kind = classify_skill(target) if target else "skill"
    else:
        # Task / Agent → subagent invocation
        target = tool_input.get("subagent_type", "general-purpose")
        kind = "subagent"

    if not target:
        sys.exit(0)

    try:
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
    except OSError:
        # Defensive: hooks must never crash the parent process.
        sys.exit(0)


if __name__ == "__main__":
    main()
