#!/usr/bin/env python3
"""
ULTRON Research Premium — Gemini auto-write deep dive.

Mirror de news_html_generator.py para investigación semanal. Antes usaba
clipboard + paste manual (que rompía caracteres no-ASCII y forzaba copy-
paste manual). AHORA: Gemini headless con --approval-mode auto-edit usa
write_file tool para guardar el markdown directamente.

Flow:
1. Build prompt deep-dive (~AI/dev/security weekly digest)
2. Append [WRITE_FILE] instruction with exact output path
3. gemini --approval-mode auto-edit -p "<prompt>" -m gemini-2.5-pro
4. Wait for ~/.ultron/cockpit/news/research-{date}.md to appear
5. Validate (>500 chars, has H1+ ≥2 H2)
6. Print summary + path. News view picks it up on next render.

Usage:
    python research_premium.py [--topic "X"] [--model gemini-2.5-pro]
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

NEWS_DIR = Path.home() / ".ultron" / "cockpit" / "news"
DEFAULT_MODEL = "gemini-2.5-pro"
GEMINI_TIMEOUT_SEC = 240


def build_prompt(topic: str | None = None) -> str:
    today = datetime.now().strftime("%A %d %B %Y")
    if topic:
        focus = (
            f"Foco específico: **{topic}**. Investiga ÚNICAMENTE este tema en "
            f"profundidad, descartando ruido general.\n\n"
        )
    else:
        focus = ""
    return f"""Eres un research analyst senior para ULTRON, sistema AI personal de USER
SURNAME (dev indie, Madrid). Hoy es {today}. Genera un research deep-dive
sobre lo más relevante de la última semana en AI / dev tooling / security.

{focus}Estructura del output (markdown limpio, español):

# Research Weekly — {today}

## TL;DR (3-5 bullets)
Lo más impactante del periodo, sin floreos.

## Modelos y APIs
- Lanzamientos, deprecations, cambios de pricing
- Comparativas si hay benchmarks recientes
- Implicaciones para Claude Code / agentic workflows

## Developer tooling
- Claude Code · Cursor · Cline · Codex CLI · Gemini CLI
- IDEs (Rider, CLion, JetBrains AI)
- MCP ecosystem updates

## Security / supply chain
- CVEs notables en dependencies AI/dev
- Prompt injection / supply chain attacks
- Best practices emergentes

## AI research / papers
- Top 3-5 papers de la semana con relevancia práctica
- Citation breve + por qué importa

## Impacto en ULTRON
1-3 bullets sobre qué workflows o skills de ULTRON debería ajustar USER.

## Acciones recomendadas
3-5 bullets concretos: explorar X, actualizar Y, ignorar Z.

---

REGLAS:
- Solo información verificable de las últimas 7 días.
- Cita fuentes cuando puedas (links inline).
- Sé sustantivo: nada de "podría ser interesante" — o sí o no.
- Markdown limpio: H1/H2/H3, bullets, links inline.
- Mínimo 12-15 items totales con sustancia, máximo 25.
- Si no hay news real de un bucket, omítelo (no rellenes).
"""


def validate(md: str) -> tuple[bool, str]:
    if len(md) < 500:
        return False, f"texto demasiado corto ({len(md)} chars, esperado >500)"
    if not re.search(r"^#\s+\S", md, flags=re.MULTILINE):
        return False, "no encuentro un H1 (# Title)"
    if md.count("##") < 2:
        return False, "menos de 2 secciones (##) — esperaba estructura completa"
    return True, "ok"


def call_gemini_auto_write(prompt: str, out_path: Path,
                             model: str) -> tuple[bool, str]:
    """gemini headless plan mode → capture stdout → persist markdown.

    Why stdout (not write_file tool): Gemini's filesystem sandbox blocks
    writes to ~/.ultron/ (only allowed inside skill workspace or its tmp
    dir). Capturing stdout + writing ourselves avoids the sandbox.
    """
    gemini_bin = shutil.which("gemini")
    if not gemini_bin:
        return False, "gemini CLI no encontrado en PATH"

    out_path.parent.mkdir(parents=True, exist_ok=True)

    stdout_instruction = (
        "\n\n[OUTPUT INSTRUCTION — CRITICAL]\n"
        "Imprime SOLO el markdown completo, empezando con `# Research Weekly...`.\n"
        "NADA de fences (no ```markdown). NADA de prose previa o posterior.\n"
        "Solo el research markdown directo.\n"
    )
    full_prompt = prompt + stdout_instruction

    try:
        r = subprocess.run(
            [gemini_bin, "--approval-mode", "plan", "-m", model, "-p", full_prompt],
            capture_output=True, text=True, encoding="utf-8",
            timeout=GEMINI_TIMEOUT_SEC, creationflags=_WIN_HIDDEN,
        )
    except subprocess.TimeoutExpired:
        return False, f"timeout ({GEMINI_TIMEOUT_SEC}s)"
    except Exception as e:
        return False, f"exec error: {e}"

    if r.returncode != 0:
        err_short = (r.stderr or "")[-400:]
        if "429" in err_short or "RESOURCE_EXHAUSTED" in err_short:
            return False, (f"Gemini 429 capacity exhausted ({model}). "
                            "Reintenta en ~1 min.")
        return False, f"gemini exit {r.returncode}: {err_short[:200]}"

    md = (r.stdout or "").strip()
    if md.startswith("```"):
        md = re.sub(r"^```\w*\s*\n", "", md, count=1).strip()
        if md.endswith("```"):
            md = md[:-3].strip()

    if len(md) < 500 or "# " not in md:
        return False, f"stdout sin md válido ({len(md)} chars)"

    try:
        out_path.write_text(md, encoding="utf-8")
    except OSError as e:
        return False, f"write failed: {e}"
    return True, "stdout-capture"


def main() -> int:
    p = argparse.ArgumentParser(prog="research_premium",
                                 description="ULTRON research auto-write via Gemini")
    p.add_argument("--topic", help="Foco específico (opcional)")
    p.add_argument("--model", default=DEFAULT_MODEL)
    args = p.parse_args()

    print("=" * 80)
    print("⌬  ULTRON Research Premium — auto-write via Gemini")
    print("=" * 80)

    NEWS_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    out_path = NEWS_DIR / f"research-{today}.md"

    prompt = build_prompt(args.topic)
    print(f"[gemini] Generando con {args.model} (timeout {GEMINI_TIMEOUT_SEC}s)…")
    print(f"[gemini] Output → {out_path}")
    if args.topic:
        print(f"[gemini] Topic: {args.topic}")

    ok, reason = call_gemini_auto_write(prompt, out_path, args.model)
    if not ok:
        print(f"[error] {reason}")
        return 1

    md = out_path.read_text(encoding="utf-8")
    valid, vreason = validate(md)
    if not valid:
        print(f"[warn] markdown inválido: {vreason} (file kept anyway)")
        return 1

    sections = md.count("##")
    chars = len(md)
    print(f"[ok] research generado — {chars} chars · {sections} secciones  "
           f"({reason})")
    print(f"[ok] saved → {out_path}")
    print("\nVuelve al TUI: News view detectará el archivo automáticamente.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
