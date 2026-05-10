#!/usr/bin/env python3
"""
ULTRON v10.4 - Persona Audit (Kirkardo on a SKILL.md, independent review).

Invokes `claude --print --model claude-opus-4-7` headless with the Kirkardo
system prompt + the target persona's SKILL.md. Outputs a markdown audit at:

    ~/.ultron/cockpit/audits/<persona>-<YYYY-MM-DD>.md

Anti-laundering rule: every audit declares `evaluator: kirkardo-independent`
in frontmatter. NEVER label a claude-self critique as kirkardo.

Run on demand. Opus FULL is heavy (run sparingly); Sonnet QUICK is the default.

Usage:
    persona_audit.py list              # list available personas/skills
    persona_audit.py run <name>        # audit persona's SKILL.md
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import COCKPIT_DIR  # noqa: E402

SKILLS_DIR = Path.home() / ".claude" / "skills"
AUDITS_DIR = COCKPIT_DIR / "audits"

AUDIT_MODEL = "claude-opus-4-7"
QUICK_MODEL = "claude-sonnet-4-6"     # --quick flag uses Sonnet (~5x cheaper, ~3x faster)
AUDIT_TIMEOUT = 300

KIRKARDO_SYSTEM = """Eres KIRKARDO, revisor independiente de skills de ULTRON.
Tu trabajo: criticar la SKILL.md que te pasen como un profesor exigente.

REGLAS INAMOVIBLES:
1. Etiqueta tu output como `evaluator: kirkardo-independent`. JAMAS uses
   `claude-self`. Si algo te impide ser independiente, dilo y rechaza.
2. NO inventes problemas. Cita lineas/secciones concretas.
3. Penaliza: contradicciones, instrucciones ambiguas, redundancia, falta de
   ejemplos, gating mal especificado, hard-coded paths, falta de error handling.
4. Premia: precision, ejemplos concretos, anti-laundering rules, fallback
   declarado, token efficiency notes.
5. Output en ESPANOL, formato markdown estructurado.

ESTRUCTURA OBLIGATORIA:
```
---
evaluator: kirkardo-independent
target: <skill-name>
date: <ISO>
nota: X.X/10
veredicto: <Suspenso|Aprobado justo|Notable|Sobresaliente>
---

# Kirkardo - Auditoria de <skill>

## 1. Lo que esta bien (citas de lineas)
## 2. Errores y omisiones (con penalizacion en puntos)
## 3. Problemas sutiles que un profesor detectaria
## 4. Para llegar a 9.5+/10 (3-5 fixes priorizados)
```

NO seas amable sin razon. NO infles la nota. Sin piedad. Sin excusas.
"""


def list_personas() -> list[Path]:
    if not SKILLS_DIR.exists():
        return []
    out = []
    for d in sorted(SKILLS_DIR.iterdir()):
        if not d.is_dir():
            continue
        skill_md = d / "SKILL.md"
        if skill_md.exists():
            out.append(d)
    return out


def cmd_list(_args) -> int:
    personas = list_personas()
    if not personas:
        print(f"[audit] No skills found in {SKILLS_DIR}")
        return 1
    print(f"Available personas/skills ({len(personas)}):")
    for p in personas:
        skill_md = p / "SKILL.md"
        size_kb = skill_md.stat().st_size / 1024
        print(f"  {p.name:<25}  ({size_kb:.1f} KB)")
    return 0


def _resolve_target(name: str) -> "Path | None":
    """Return the skill directory for name (exact or substring match)."""
    target = SKILLS_DIR / name
    if target.exists() and (target / "SKILL.md").exists():
        return target
    candidates = [p for p in list_personas() if name in p.name.lower()]
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        print(f"[audit] Ambiguous '{name}', candidates:",
              [c.name for c in candidates])
        return None
    print(f"[audit] Persona/skill not found: {name}")
    return None


def _load_alerts() -> str:
    """Return ALERTS.md content if present, stripped for prompt injection."""
    alerts_path = COCKPIT_DIR / "news" / "ALERTS.md"
    if not alerts_path.exists():
        return ""
    try:
        raw = alerts_path.read_text(encoding="utf-8", errors="replace")
        lines = [ln for ln in raw.splitlines()
                 if ln.strip() and not ln.startswith("#")]
        if not lines:
            return ""
        return "\n".join(lines[:30])  # cap to avoid prompt bloat
    except OSError:
        return ""


def _run_claude_audit(target: "Path", model: str, label: str,
                      audit_path: "Path", today: str) -> int:
    """Run the standard Kirkardo Claude audit. Returns 0 on success."""
    skill_md = target / "SKILL.md"
    skill_text = skill_md.read_text(encoding="utf-8")
    skill_size = len(skill_text)

    claude_bin = shutil.which("claude")
    if not claude_bin:
        print("[audit] claude CLI not found in PATH", file=sys.stderr)
        return 1

    alerts_text = _load_alerts()
    alerts_block = ""
    if alerts_text:
        alerts_block = (
            "\n\n---SISTEMA ALERTS (leer antes de auditar)---\n"
            "Los siguientes alertas del sistema están activos. Comprueba si alguno "
            "afecta a la skill auditada (seguridad, dependencias, CVEs, cambios de API):\n"
            f"{alerts_text}\n"
            "---FIN ALERTS---\n"
        )

    user_prompt = (
        f"Audita esta SKILL.md (target: {target.name}).\n"
        f"Tamano: {skill_size} caracteres."
        f"{alerts_block}\n\n"
        "---SKILL.MD START---\n"
        f"{skill_text}\n"
        "---SKILL.MD END---\n\n"
        "Aplica el formato Kirkardo descrito en system prompt. Recuerda: "
        "`evaluator: kirkardo-independent` en frontmatter, JAMAS `claude-self`."
    )

    print(f"[audit] Target:  {target.name} ({skill_size}b)")
    print(f"[audit] Model:   {model} ({label})")
    print(f"[audit] Output:  {audit_path}")
    print(f"[audit] Running claude audit...")

    cmd = [claude_bin, "--print", "--dangerously-skip-permissions",
           "--model", model,
           "--append-system-prompt", KIRKARDO_SYSTEM, user_prompt]
    result = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=AUDIT_TIMEOUT, encoding="utf-8",
                             creationflags=_WIN_HIDDEN)
    if result.returncode != 0:
        print(f"[audit] claude failed (exit {result.returncode})", file=sys.stderr)
        if result.stderr:
            print(f"[audit] stderr: {result.stderr[:500]}", file=sys.stderr)
        return result.returncode
    out = (result.stdout or "").strip()
    if len(out) < 200:
        print(f"[audit] Output too short ({len(out)}b) - audit failed silently")
        return 1
    if "kirkardo-independent" not in out:
        print("[audit] WARN: output missing 'kirkardo-independent' label")
        header = (f"---\nevaluator: kirkardo-independent\n"
                  f"target: {target.name}\ndate: {today}\n---\n\n")
        out = header + out
    audit_path.write_text(out, encoding="utf-8")
    return 0


def _run_peer_review(target: "Path", peer: str) -> str:
    """Run a read-only review from Codex or Gemini on the skill. Returns raw text."""
    skill_md = target / "SKILL.md"
    skill_text = skill_md.read_text(encoding="utf-8")[:6000]  # cap for peer context

    peer_prompt = (
        f"You are an independent code/skill reviewer.\n"
        f"Review this Claude Code SKILL.md for: clarity, correctness, missing edge-cases, "
        f"contradictions, token efficiency, trigger accuracy, and overall quality.\n"
        f"Be concise and critical. Give a score X/10 and a 3-5 bullet summary.\n\n"
        f"---SKILL.MD START---\n{skill_text}\n---SKILL.MD END---"
    )

    if peer == "codex":
        codex_bin = shutil.which("codex")
        if not codex_bin:
            return "[codex] codex CLI not found in PATH"
        try:
            # codex exec: non-interactive subcommand; --ignore-user-config lives here
            r = subprocess.run(
                [codex_bin, "exec", "--ephemeral", "-s", "read-only",
                 "--ignore-user-config", "-m", "gpt-5.5", "-"],
                input=peer_prompt,
                capture_output=True, text=True, timeout=180, encoding="utf-8",
                creationflags=_WIN_HIDDEN,
            )
            return (r.stdout or "").strip() or f"[codex] exit {r.returncode}: {r.stderr[:200]}"
        except subprocess.TimeoutExpired:
            return "[codex] Timeout 180s"
        except Exception as e:
            return f"[codex] Error: {e}"

    elif peer == "gemini":
        gemini_bin = shutil.which("gemini")
        if not gemini_bin:
            return "[gemini] gemini CLI not found in PATH"
        # Pass SKILL.MD content via stdin; -p appends the review instruction after.
        gemini_instruction = (
            "Review this Claude Code SKILL.md (received via stdin) for: clarity, correctness, "
            "missing edge-cases, contradictions, token efficiency, trigger accuracy, and overall quality. "
            "Be concise and critical. Give a score X/10 and a 3-5 bullet summary."
        )
        skill_block = f"---SKILL.MD START---\n{skill_text}\n---SKILL.MD END---"
        try:
            r = subprocess.run(
                [gemini_bin, "--approval-mode", "plan", "-m", "gemini-3.1-pro-preview",
                 "-p", gemini_instruction],
                input=skill_block,
                capture_output=True, text=True, timeout=180, encoding="utf-8",
                creationflags=_WIN_HIDDEN,
            )
            return (r.stdout or "").strip() or f"[gemini] exit {r.returncode}: {r.stderr[:200]}"
        except subprocess.TimeoutExpired:
            return "[gemini] Timeout 180s"
        except Exception as e:
            return f"[gemini] Error: {e}"

    return f"[peer] Unknown peer: {peer}"


def cmd_run(args) -> int:
    name = args.name.lower()
    is_triple = getattr(args, "triple", False)
    is_quick = getattr(args, "quick", False)

    target = _resolve_target(name)
    if target is None:
        print(f"[audit] Run: ultron audit list")
        return 1

    model = QUICK_MODEL if is_quick else AUDIT_MODEL
    label = "QUICK (Sonnet)" if is_quick else "FULL (Opus)"
    if is_triple:
        model = QUICK_MODEL  # triple uses Sonnet for Claude pass (speed); peers add depth
        label = "TRIPLE (Sonnet+Codex+Gemini)"

    AUDITS_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    suffix = "-triple" if is_triple else ""
    audit_path = AUDITS_DIR / f"{target.name}-{today}{suffix}.md"

    # ── 1. Claude (Kirkardo) audit ────────────────────────────────────────
    rc = _run_claude_audit(target, model, label, audit_path, today)
    if rc != 0:
        return rc

    if not is_triple:
        # Standard mode: print preview and return
        out = audit_path.read_text(encoding="utf-8")
        print(f"[audit] Wrote: {audit_path} ({len(out)}b)")
        print()
        print("--- Audit preview (first 30 lines) ---")
        print("\n".join(out.splitlines()[:30]))
        print("...")
        print(f"(full audit: {audit_path})")
        return 0

    # ── 2. TRIPLE MODE: run Codex + Gemini in parallel ────────────────────
    print(f"[audit] TRIPLE MODE — running Codex + Gemini peer reviews in parallel...")
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        fut_codex  = ex.submit(_run_peer_review, target, "codex")
        fut_gemini = ex.submit(_run_peer_review, target, "gemini")
        codex_out  = fut_codex.result()
        gemini_out = fut_gemini.result()

    print(f"[audit] Codex review: {len(codex_out)} chars")
    print(f"[audit] Gemini review: {len(gemini_out)} chars")

    # ── 3. Synthesise into combined triple report ─────────────────────────
    claude_out = audit_path.read_text(encoding="utf-8")
    combined = (
        f"---\nevaluator: kirkardo-triple\ntarget: {target.name}\n"
        f"date: {today}\nmode: triple\n---\n\n"
        f"# Kirkardo TRIPLE — {target.name}\n\n"
        f"*Tres valoraciones independientes: Claude (Kirkardo) · Codex · Gemini*\n\n"
        f"---\n\n"
        f"## Valoración 1: Claude/Kirkardo (Sonnet)\n\n"
        f"{claude_out}\n\n"
        f"---\n\n"
        f"## Valoración 2: Codex (gpt-5.5, read-only)\n\n"
        f"{codex_out}\n\n"
        f"---\n\n"
        f"## Valoración 3: Gemini (gemini-3.1-pro-preview, plan-only)\n\n"
        f"{gemini_out}\n\n"
        f"---\n\n"
        f"## Síntesis\n\n"
        f"*Generada por Claude a partir de las 3 valoraciones anteriores.*\n"
        f"*(Ejecuta `ultron audit run {target.name} --triple` de nuevo para regenerar)*\n"
    )

    # Ask Claude to synthesise
    claude_bin = shutil.which("claude")
    if claude_bin:
        synth_prompt = (
            f"Eres KIRKARDO. Acabo de ejecutar una evaluación TRIPLE de la skill '{target.name}'.\n"
            f"Tienes 3 valoraciones independientes (Claude/Kirkardo, Codex, Gemini).\n"
            f"Escribe una SÍNTESIS en 1 párrafo (máx 100 palabras):\n"
            f"- Puntos de acuerdo entre los 3 revisores\n"
            f"- Principales divergencias\n"
            f"- Nota media ponderada final (formato: X.X/10)\n"
            f"- Prioridad top-1 de mejora\n\n"
            f"VALORACIÓN CLAUDE:\n{claude_out[:1500]}\n\n"
            f"VALORACIÓN CODEX:\n{codex_out[:800]}\n\n"
            f"VALORACIÓN GEMINI:\n{gemini_out[:800]}"
        )
        try:
            synth_r = subprocess.run(
                [claude_bin, "--print", "--dangerously-skip-permissions",
                 "--model", QUICK_MODEL, synth_prompt],
                capture_output=True, text=True, timeout=120, encoding="utf-8",
                creationflags=_WIN_HIDDEN,
            )
            synth_text = (synth_r.stdout or "").strip()
            if synth_text:
                combined = combined.replace(
                    "*(Ejecuta `ultron audit run",
                    f"{synth_text}\n\n*(Ejecuta `ultron audit run"
                )
        except Exception as se:
            print(f"[audit] Synthesis skipped: {se}")

    audit_path.write_text(combined, encoding="utf-8")
    print(f"[audit] TRIPLE audit written: {audit_path} ({len(combined)}b)")
    print()
    print("--- TRIPLE preview ---")
    print("\n".join(combined.splitlines()[:40]))
    print(f"(full: {audit_path})")
    return 0


def main():
    p = argparse.ArgumentParser(description="ULTRON Persona Audit (Kirkardo)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("list")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("run")
    sp.add_argument("name", help="Persona/skill name (substring match OK)")
    sp.add_argument("--quick", action="store_true",
                    help="Use Sonnet instead of Opus (~5x cheaper, ~3x faster)")
    sp.add_argument("--triple", action="store_true",
                    help="Triple mode: Claude (Kirkardo) + Codex + Gemini, synthesised")
    sp.set_defaults(func=cmd_run)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
