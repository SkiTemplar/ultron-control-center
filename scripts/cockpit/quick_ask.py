#!/usr/bin/env python3
"""
ULTRON v12.2 - Quick Ask (mini-memoria + Haiku) with Q&A history persistence.

Para queries ultra-rápidas que NO necesitan cargar la skill completa de ULTRON.
Invoca `claude --print --model claude-haiku-4-5` con un contexto enriquecido:
  - cwd actual + project_id si matchea
  - últimas N líneas de ~/.ultron/INDEX.md
  - ~/.ultron/.tmp/current-session.json (mode, stale_notes)
  - ~/.ultron/.tmp/decay-prime.json (top-3 notas más stale)
  - upcoming deadlines (próximos 7d) si existen
  - últimas 3 Q&A previas (history persistente, opcional)

Haiku light tier — designed for short factual replies, minimal usage impact.

History se guarda en `~/.ultron/cockpit/quick-ask-history.jsonl` (rota a 200
entries vía retention.py). Cada entry: {ts, cwd, project_id, q, a_summary}.

Uso:
    ultron ask "¿qué es Mythos?"
    ultron ask --no-memory "¿cómo se hace fork de un repo?"
    ultron ask --no-history "..."     # no guardar la pregunta
    ultron ask history                  # ver últimas 10 Q&A
    ultron ask history --clear          # borrar historial
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

ULTRON_HOME = Path.home() / ".ultron"
COCKPIT_DIR = ULTRON_HOME / "cockpit"
TMP_DIR = ULTRON_HOME / ".tmp"
INDEX_FILE = ULTRON_HOME / "INDEX.md"
SESSION_CACHE = TMP_DIR / "current-session.json"
DECAY_PRIME = TMP_DIR / "decay-prime.json"
PROJECTS_FILE = COCKPIT_DIR / "projects.json"
DEADLINES_FILE = COCKPIT_DIR / "deadlines.json"
HISTORY_FILE = COCKPIT_DIR / "quick-ask-history.jsonl"

MODEL = "claude-haiku-4-5"
INDEX_HEAD_LINES = 30
RECENT_QA_PAIRS = 3
HISTORY_CAP = 200


def _detect_project_id(cwd: Path) -> str | None:
    """If cwd is inside a registered project, return its id."""
    if not PROJECTS_FILE.exists():
        return None
    try:
        data = json.loads(PROJECTS_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    cwd_resolved = cwd.resolve()
    best_id, best_len = None, -1
    for p in data.get("projects", []):
        try:
            ppath = Path(p["path"]).resolve()
            cwd_resolved.relative_to(ppath)
            if len(str(ppath)) > best_len:
                best_id = p.get("id")
                best_len = len(str(ppath))
        except (ValueError, OSError):
            continue
    return best_id


def _upcoming_deadlines(days: int = 7) -> list[str]:
    if not DEADLINES_FILE.exists():
        return []
    try:
        data = json.loads(DEADLINES_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return []
    today = datetime.now().date()
    horizon = today + timedelta(days=days)
    out = []
    for m in data.get("matches", []):
        d = m.get("date")
        if not d:
            continue
        try:
            dt = datetime.fromisoformat(d).date()
        except ValueError:
            continue
        if today <= dt <= horizon:
            out.append(f"  {d}: {m.get('project_id','?')} — "
                       f"{m.get('event_title','?')[:60]}")
    return out[:5]


def _recent_qa(limit: int = RECENT_QA_PAIRS) -> list[str]:
    if not HISTORY_FILE.exists():
        return []
    out = []
    try:
        lines = HISTORY_FILE.read_text(encoding="utf-8").splitlines()
        for line in lines[-limit:]:
            if not line.strip():
                continue
            try:
                d = json.loads(line)
                q = d.get("q", "")[:120]
                a = d.get("a_summary", "")[:160]
                if q and a:
                    out.append(f"  Q: {q}\n  A: {a}")
            except json.JSONDecodeError:
                continue
    except OSError:
        return []
    return out


def build_mini_context(use_memory: bool, use_history: bool) -> tuple[str, str | None]:
    """Compose enriched context. Returns (context_md, detected_project_id)."""
    cwd = Path.cwd()
    parts = [f"cwd: {cwd}"]
    project_id = _detect_project_id(cwd)
    if project_id:
        parts.append(f"detected project: {project_id}")
    if not use_memory:
        return "\n".join(parts), project_id

    if INDEX_FILE.exists():
        try:
            lines = INDEX_FILE.read_text(encoding="utf-8") \
                              .splitlines()[:INDEX_HEAD_LINES]
            if lines:
                parts.append("INDEX.md (head):")
                parts.append("\n".join(lines))
        except OSError:
            pass

    if SESSION_CACHE.exists():
        try:
            sess = json.loads(SESSION_CACHE.read_text(encoding="utf-8"))
            mode = sess.get("mode", "")
            stale = sess.get("stale_notes", [])
            ts = (sess.get("ts") or "")[:19]
            info = f"last mode: {mode}" if mode else ""
            if ts:
                info = f"{ts} · {info}" if info else ts
            if info:
                parts.append(f"Session: {info}")
            if stale:
                parts.append("Stale notes (needs attention): " + ", ".join(str(n) for n in stale[:3]))
        except Exception:
            pass

    if DECAY_PRIME.exists():
        try:
            decay = json.loads(DECAY_PRIME.read_text(encoding="utf-8"))
            top = decay[:3] if isinstance(decay, list) else []
            if top:
                parts.append("Top stale knowledge: " + ", ".join(str(n) for n in top))
        except Exception:
            pass

    upcoming = _upcoming_deadlines()
    if upcoming:
        parts.append("Upcoming deadlines (next 7d):")
        parts.extend(upcoming)

    if use_history:
        qa = _recent_qa()
        if qa:
            parts.append("Recent Q&A (last 3):")
            parts.extend(qa)

    return "\n\n".join(parts), project_id


def _save_history(query: str, answer: str, project_id: str | None) -> None:
    COCKPIT_DIR.mkdir(parents=True, exist_ok=True)
    summary = answer.strip().splitlines()[0][:300] if answer.strip() else ""
    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "cwd": str(Path.cwd()),
        "project_id": project_id,
        "q": query[:500],
        "a_summary": summary,
    }
    with HISTORY_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    # Cap retention inline (no need for retention.py to know about this)
    try:
        all_lines = HISTORY_FILE.read_text(encoding="utf-8").splitlines()
        if len(all_lines) > HISTORY_CAP:
            HISTORY_FILE.write_text(
                "\n".join(all_lines[-HISTORY_CAP:]) + "\n", encoding="utf-8")
    except OSError:
        pass


def ask(query: str, use_memory: bool, use_history: bool, verbose: bool) -> int:
    claude_bin = shutil.which("claude")
    if not claude_bin:
        print("[ask] claude CLI not found in PATH", file=sys.stderr)
        return 1

    context, project_id = build_mini_context(use_memory, use_history)
    system_prompt = (
        "Eres ULTRON quick-ask. Responde en 1-3 líneas máximo, sin rodeos. "
        "Usa tu conocimiento general (AI/LLM/dev/ciencia/etc) directamente — "
        "el contexto de cwd/INDEX/stale-notes/deadlines/history es solo POR SI "
        "ACASO la pregunta se refiere al setup local del usuario. NO preguntes "
        "'dónde lo viste' para términos comunes (modelos LLM, tecnologías, "
        "conceptos). Solo escala con 'Esto merece HIGH' si requiere análisis "
        "multi-paso o tocar archivos."
    )
    user_prompt = f"Contexto del usuario:\n{context}\n\nPregunta: {query}"

    if verbose:
        print(f"[ask] Model: {MODEL}", file=sys.stderr)
        print(f"[ask] Context bytes: {len(context)}", file=sys.stderr)
        print(f"[ask] Project: {project_id or '(none)'}", file=sys.stderr)

    cmd = [
        claude_bin,
        "--print",
        "--dangerously-skip-permissions",
        "--model", MODEL,
        "--append-system-prompt", system_prompt,
        user_prompt,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True,
                                 timeout=60, encoding="utf-8",
                                 creationflags=_WIN_HIDDEN)
        answer = (result.stdout or "").strip()
        if answer:
            print(answer)
        if result.returncode != 0:
            if result.stderr:
                print(f"[ask] stderr: {result.stderr[:300]}", file=sys.stderr)
            return result.returncode
        if use_history and answer:
            try:
                _save_history(query, answer, project_id)
            except Exception as e:
                print(f"[ask] WARN: history save failed: {e}", file=sys.stderr)
        return 0
    except subprocess.TimeoutExpired:
        print("[ask] Timed out (60s) — Haiku usually responds in <5s. Retry?",
              file=sys.stderr)
        return 124
    except Exception as e:
        print(f"[ask] Failed: {e}", file=sys.stderr)
        return 1


def cmd_history(args) -> int:
    if getattr(args, "clear", False):
        if HISTORY_FILE.exists():
            HISTORY_FILE.unlink()
            print("[ask] history cleared")
        else:
            print("[ask] no history yet")
        return 0
    if not HISTORY_FILE.exists():
        print("[ask] no history yet")
        return 0
    n = int(getattr(args, "n", 10))
    lines = HISTORY_FILE.read_text(encoding="utf-8").splitlines()[-n:]
    if not lines:
        print("[ask] empty")
        return 0
    print(f"[ask] last {len(lines)} Q&A:")
    for line in lines:
        try:
            d = json.loads(line)
            ts = d.get("ts", "?")[:19]
            pid = d.get("project_id") or "(none)"
            q = d.get("q", "")[:90]
            a = d.get("a_summary", "")[:120]
            print(f"  {ts} [{pid}]")
            print(f"    Q: {q}")
            print(f"    A: {a}")
        except json.JSONDecodeError:
            continue
    return 0


def main():
    p = argparse.ArgumentParser(
        description="ULTRON quick-ask via Haiku + mini-memoria")
    sub = p.add_subparsers(dest="cmd")

    sp = sub.add_parser("history", help="Show recent Q&A from local history")
    sp.add_argument("-n", type=int, default=10)
    sp.add_argument("--clear", action="store_true",
                    help="Wipe the history file")
    sp.set_defaults(func=cmd_history)

    p.add_argument("query", nargs="*",
                   help="Pregunta (puede ser varias palabras sin comillas)")
    p.add_argument("--no-memory", action="store_true",
                   help="Omit INDEX.md + activity (cwd-only context)")
    p.add_argument("--no-history", action="store_true",
                   help="Skip recent-Q&A in context AND skip saving this turn")
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args()

    if args.cmd == "history":
        return args.func(args)

    if not args.query:
        p.print_help()
        return 1
    query = " ".join(args.query)
    return ask(query,
               use_memory=not args.no_memory,
               use_history=not args.no_history,
               verbose=args.verbose)


if __name__ == "__main__":
    sys.exit(main())
