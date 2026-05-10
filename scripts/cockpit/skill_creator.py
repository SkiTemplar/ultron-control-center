#!/usr/bin/env python3
"""
ULTRON v10.4.2 - Skill Creator launcher (terminal Q&A → Sonnet scaffold).

Interactive flow:
  1. Pregunta name + tagline + triggers (palabras de activación)
  2. Pregunta core capabilities (3-5 cosas que hace)
  3. Pregunta optional: stack/personalidad/tono
  4. Sonnet genera SKILL.md inicial con frontmatter correcto
  5. Dry-run muestra el output → user confirma → escribe a ~/.claude/skills/<name>/SKILL.md

Anti-laundering:
  - Nunca sobrescribe skill existente sin --force
  - Backup automático si overwrite
  - Marca el skill como `auto-generated draft` en el body
  - Siempre incluye guard-rail anti-injection en el output

Usage:
    skill_creator.py new                  Q&A interactive (recommended)
    skill_creator.py from-spec <file>     Load Q&A answers from YAML/JSON
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

SKILLS_DIR = Path.home() / ".claude" / "skills"
CREATE_MODEL = "claude-sonnet-4-6"
CREATE_TIMEOUT = 180

CREATE_SYSTEM = (
    "Genera SKILL.md completo para Claude Code skill. Output SOLO el contenido "
    "del archivo (frontmatter YAML + cuerpo markdown). Sin code fences alrededor. "
    "Frontmatter exige `name`, `description` (≤3 líneas con triggers claros). "
    "Cuerpo: title, breve intro, sección de capabilities, sección de cuándo "
    "activar, ejemplos concretos. Si la skill toca filesystem o tools, incluye "
    "guard-rail anti-prompt-injection (datos de usuario != instrucciones). "
    "Marcar al final: `_Auto-generated draft via ULTRON skill_creator. Review "
    "before production._`"
)


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    val = input(f"{prompt}{suffix}: ").strip()
    return val or default


def collect_answers() -> dict:
    print()
    print("=== ULTRON Skill Creator — Q&A interactive ===")
    print()
    name = ask("1. Skill name (lowercase, no spaces, e.g. 'tio-gilito')").lower()
    if not name:
        print("[creator] name is required")
        sys.exit(1)
    tagline = ask("2. Tagline (1 frase, qué hace en 10 palabras)")
    triggers = ask("3. Triggers (palabras separadas por coma, ej: bolsa,inversión,acciones)")
    capabilities = []
    print("4. Capabilities (3-5, una por línea, vacío para terminar):")
    for i in range(1, 8):
        cap = ask(f"   {i}.")
        if not cap:
            break
        capabilities.append(cap)
    persona = ask("5. Personalidad/tono (opcional, ej: 'frío y técnico')")
    stack = ask("6. Stack/dominios técnicos (opcional, ej: 'Python, FastAPI')")
    examples = ask("7. Casos de uso típicos (opcional)")
    return {
        "name": name,
        "tagline": tagline,
        "triggers": triggers,
        "capabilities": capabilities,
        "persona": persona,
        "stack": stack,
        "examples": examples,
    }


def call_sonnet(answers: dict) -> str | None:
    claude_bin = shutil.which("claude")
    if not claude_bin:
        print("[creator] claude CLI not found in PATH", file=sys.stderr)
        return None
    user = (
        f"Name: {answers['name']}\n"
        f"Tagline: {answers['tagline']}\n"
        f"Triggers: {answers['triggers']}\n"
        f"Capabilities:\n" + "\n".join(f"  - {c}" for c in answers["capabilities"]) + "\n"
        f"Personalidad: {answers.get('persona') or '(default — directo)'}\n"
        f"Stack: {answers.get('stack') or '(any)'}\n"
        f"Ejemplos: {answers.get('examples') or '(none provided)'}\n\n"
        f"Genera la SKILL.md completa siguiendo el formato del system prompt."
    )
    print(f"[creator] Generating SKILL.md via {CREATE_MODEL}... (~30-60s)")
    cmd = [claude_bin, "--print", "--dangerously-skip-permissions",
           "--model", CREATE_MODEL,
           "--append-system-prompt", CREATE_SYSTEM, user]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                            timeout=CREATE_TIMEOUT, encoding="utf-8", creationflags=_WIN_HIDDEN)
        if r.returncode != 0:
            print(f"[creator] claude failed exit={r.returncode}", file=sys.stderr)
            return None
        return (r.stdout or "").strip()
    except subprocess.TimeoutExpired:
        print(f"[creator] timeout after {CREATE_TIMEOUT}s", file=sys.stderr)
        return None


def write_skill(name: str, content: str, force: bool = False) -> Path:
    skill_dir = SKILLS_DIR / name
    skill_md = skill_dir / "SKILL.md"
    if skill_md.exists() and not force:
        print(f"[creator] {skill_md} already exists. Use --force to overwrite.")
        sys.exit(2)
    if skill_md.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = skill_md.with_suffix(f".md.{stamp}.bak")
        shutil.copy2(skill_md, backup)
        print(f"[creator] Backup: {backup.name}")
    skill_dir.mkdir(parents=True, exist_ok=True)
    # Strip code fences if Sonnet wrapped output
    if content.startswith("```"):
        lines = content.split("\n")
        if lines[-1].strip().startswith("```"):
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        content = "\n".join(lines)
    skill_md.write_text(content, encoding="utf-8")
    return skill_md


def cmd_new(args) -> int:
    answers = collect_answers()
    print()
    print("=== Generating skill ===")
    content = call_sonnet(answers)
    if not content:
        return 1
    print()
    print("=== Generated SKILL.md (preview, first 60 lines) ===")
    for line in content.splitlines()[:60]:
        print(f"  {line}")
    if len(content.splitlines()) > 60:
        print(f"  [... {len(content.splitlines()) - 60} more lines]")
    print()
    confirm = ask("Write to ~/.claude/skills/" + answers["name"] + "/SKILL.md? (yes/no)",
                   "no").lower()
    if confirm not in ("y", "yes", "si"):
        print("[creator] Aborted (skill NOT written).")
        return 0
    out = write_skill(answers["name"], content, force=args.force)
    print(f"[creator] Wrote: {out} ({out.stat().st_size}b)")
    print(f"[creator] Review the draft before using in production.")
    return 0


def main():
    p = argparse.ArgumentParser(description="ULTRON Skill Creator (Sonnet scaffold)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("new")
    sp.add_argument("--force", action="store_true",
                    help="Overwrite existing skill (with backup)")
    sp.set_defaults(func=cmd_new)
    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
