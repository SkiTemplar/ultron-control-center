#!/usr/bin/env python3
"""
ULTRON v15.2 — Agent Telemetry

Cuenta invocaciones de subagentes (tool == "Task") en
`~/.ultron/sessions/<date>/routing.jsonl`, filtrando por agentes válidos
(los que existen como `<name>.md` en `~/.claude/agents/`).

Paralelo a `skill_vault.py stats` pero para subagentes — el agente
`general-purpose` (built-in) se incluye aparte porque no tiene `.md`.

Comandos:
    status              JSON con {by_agent, total_agent_calls, last_30_days}
    top [-k 10]         Tabla legible de los k agentes más usados

Diseño:
- UV-compatible (sin dependencias externas; solo stdlib).
- UTF-8 explícito al leer/escribir.
- Defensivo: OSError / JSONDecodeError nunca rompen el reporte.
- Sólo lee — no modifica nada.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HOME = Path.home()
SESSIONS_DIR = HOME / ".ultron" / "sessions"
AGENTS_DIR = HOME / ".claude" / "agents"
# `general-purpose` es el subagente built-in de Claude Code (no tiene .md
# en ~/.claude/agents/); lo aceptamos como agente válido para no descartar
# la mayoría del histórico actual.
BUILTIN_AGENTS = frozenset({"general-purpose"})


def _known_agents() -> frozenset[str]:
    """Conjunto de agentes válidos = built-ins ∪ archivos .md en ~/.claude/agents/."""
    discovered: set[str] = set(BUILTIN_AGENTS)
    try:
        if AGENTS_DIR.is_dir():
            for p in AGENTS_DIR.iterdir():
                if p.is_file() and p.suffix == ".md" and not p.name.startswith("."):
                    discovered.add(p.stem)
    except OSError:
        pass
    return frozenset(discovered)


def _iter_entries():
    """Itera entries de todos los routing.jsonl bajo ~/.ultron/sessions/.

    Yields tuples (entry_dict, day_str). Defensivo: salta días/líneas rotas.
    """
    if not SESSIONS_DIR.exists():
        return
    try:
        days = sorted(SESSIONS_DIR.iterdir())
    except OSError:
        return
    for day in days:
        if not day.is_dir():
            continue
        rj = day / "routing.jsonl"
        if not rj.exists():
            continue
        try:
            text = rj.read_text(encoding="utf-8")
        except OSError:
            continue
        for ln in text.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            try:
                entry = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict):
                continue
            yield entry, day.name


def _collect_agent_stats() -> dict:
    """Recolecta stats agregadas de invocaciones de agentes (tool == "Task").

    Devuelve:
        {
            "by_agent": {<agent>: n, ...},
            "total_agent_calls": int,
            "last_30_days": int,
            "unknown_targets": {<target>: n, ...},   # tool=Task pero target no
                                                      # es un agente conocido
        }
    """
    known = _known_agents()
    cutoff_30d = datetime.now() - timedelta(days=30)

    by_agent: dict[str, int] = {}
    unknown: dict[str, int] = {}
    total = 0
    last_30 = 0

    for entry, _day in _iter_entries():
        if entry.get("tool") != "Task":
            continue
        target = entry.get("target") or ""
        if not target:
            continue

        if target in known:
            by_agent[target] = by_agent.get(target, 0) + 1
            total += 1
            ts_raw = entry.get("ts") or ""
            try:
                ts = datetime.fromisoformat(ts_raw)
            except (TypeError, ValueError):
                ts = None
            if ts is not None and ts >= cutoff_30d:
                last_30 += 1
        else:
            unknown[target] = unknown.get(target, 0) + 1

    return {
        "by_agent": by_agent,
        "total_agent_calls": total,
        "last_30_days": last_30,
        "unknown_targets": unknown,
    }


# ── commands ──────────────────────────────────────────────────────────────────

def cmd_status(args: argparse.Namespace) -> int:
    stats = _collect_agent_stats()
    out = {
        "by_agent": dict(sorted(stats["by_agent"].items(), key=lambda kv: kv[1], reverse=True)),
        "total_agent_calls": stats["total_agent_calls"],
        "last_30_days": stats["last_30_days"],
    }
    if args.with_unknown:
        out["unknown_targets"] = dict(sorted(stats["unknown_targets"].items(),
                                             key=lambda kv: kv[1], reverse=True))
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_top(args: argparse.Namespace) -> int:
    stats = _collect_agent_stats()
    items = sorted(stats["by_agent"].items(), key=lambda kv: kv[1], reverse=True)
    k = max(1, int(args.k))
    print(f"Agent invocations (tool=Task)  ·  total={stats['total_agent_calls']}  "
          f"·  last_30d={stats['last_30_days']}  ·  agents_used={len(items)}")
    if not items:
        print("  (sin invocaciones registradas — ¿hook activo? matcher debe incluir 'Task')")
        return 0
    print(f"  Top {min(k, len(items))} agentes:")
    for name, n in items[:k]:
        print(f"    {n:>4}×  {name}")
    if stats["unknown_targets"]:
        n_unknown = sum(stats["unknown_targets"].values())
        print(f"\n  ({n_unknown} invocaciones con target no registrado en ~/.claude/agents/)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="agent_telemetry",
        description="Stats de invocaciones de subagentes (tool=Task) desde routing.jsonl",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp_status = sub.add_parser("status", help="JSON con by_agent / total / last_30_days")
    sp_status.add_argument("--with-unknown", action="store_true",
                           help="incluye targets que no matchean ningún agente en ~/.claude/agents/")
    sp_status.set_defaults(func=cmd_status)

    sp_top = sub.add_parser("top", help="tabla legible de los k agentes más usados")
    sp_top.add_argument("-k", type=int, default=10)
    sp_top.set_defaults(func=cmd_top)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
