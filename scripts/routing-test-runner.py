#!/usr/bin/env python3
"""
ULTRON ROUTING TEST RUNNER · v2.0 (2026-06-05)

Valida el dispatcher JS vivo (routing-dispatcher.js) invocándolo como subproceso
con stdin JSON y comparando el additionalContext resultante contra la taxonomía
REAL de IDs que produce el hook en producción:

  Layer 1 — Personas:  terry-davis, don-claudio, mike-tyson, jordan-belfort,
                        einstein, pana, profesor-fisica, tio-gilito, warren,
                        repo-evaluator, alfred, manolo-lama, tolkien, novalbos
  Layer 2 — Plugins:   IDs completos como "superpowers:systematic-debugging",
                        "commit-commands:commit", etc.
  Layer 3 — Agents:    rust-engineer, python-pro, debugger, security-auditor, ...

Uso:
    uv run python scripts/routing-test-runner.py
    uv run python scripts/routing-test-runner.py --verbose

No depende de routing-tests.md (taxonomía del viejo intent-dispatcher.py).
Todos los casos de prueba están inline y validan comportamientos reales
observados en routing-dispatcher.jsonl de producción.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv

# Ruta al hook JS vivo — byte-idéntico en ambas ubicaciones wired en settings.json
DISPATCHER_JS = Path.home() / ".claude" / "scripts" / "routing-dispatcher.js"

# ── Casos de prueba contra la taxonomía real del JS ─────────────────────────
# Formato: (test_id, prompt, expected_id_fragment, expected_kind)
# expected_id_fragment: subcadena que debe aparecer en la etiqueta del top candidato
# expected_kind: "persona" | "agent" | "plugin" | "silent"
#   "silent" = el hook no debe emitir additionalContext (baja confianza)
TEST_CASES: list[tuple[str, str, str, str]] = [
    # ── Layer 1: Personas (triggers explícitos) ──────────────────────────────
    ("T-P01", "activa a terry y debuggeamos este crash", "terry-davis", "persona"),
    ("T-P02", "don claudio ayúdame con blueprint de UE5", "don-claudio", "persona"),
    ("T-P03", "mike tyson revisa el design system de la app", "mike-tyson", "persona"),
    ("T-P04", "jordan belfort analiza el modelo de negocio y pricing", "jordan-belfort", "persona"),
    ("T-P05", "einstein explícame qué es un transformer en NLP", "einstein", "persona"),
    ("T-P06", "tío gilito cuánto tengo en kutxabank", "tio-gilito", "persona"),
    ("T-P07", "tolkien siguiente capítulo del libro", "tolkien", "persona"),
    ("T-P08", "novalbos explícame vulkan desde cero", "novalbos", "persona"),
    ("T-P09", "alfred mata el proceso que bloquea el puerto", "alfred", "persona"),
    ("T-P10", "kirkardo ponme nota en este repo", "repo-evaluator", "persona"),
    # ── Layer 1: Personas (dominio fuerte sin trigger explícito) ────────────
    ("T-P11", "cómo implemento rollback netcode en UE5 con GAS", "don-claudio", "persona"),
    ("T-P12", "necesito un wireframe para la landing con jerarquía visual", "mike-tyson", "persona"),
    ("T-P13", "analiza el estado macro económico y los etf de renta fija", "warren", "persona"),
    ("T-P14", "sólido rígido y tensor de inercia para el examen física", "profesor-fisica", "persona"),
    # ── Layer 3: Agentes técnicos (strong domain tokens) ────────────────────
    ("T-A01", "tengo un panic en tokio async rust con el borrow checker", "rust-engineer", "agent"),
    ("T-A02", "optimiza esta query postgresql con explain analyze y vacuum", "postgres-pro", "agent"),
    ("T-A03", "threat model owasp sql injection en el módulo de auth", "security-auditor", "agent"),
    ("T-A04", "stack trace del segfault en el test de integración", "debugger", "agent"),
    ("T-A05", "hay un bottleneck de n+1 query en el hot path", "performance-engineer", "agent"),
    ("T-A06", "diseña un rag pipeline con vector db y fine-tuning", "ai-engineer", "agent"),
    ("T-A07", "openapi spec para el nuevo endpoint con graphql schema", "api-designer", "agent"),
    ("T-A08", "extract method para reducir complexity y code smell", "refactoring-specialist", "agent"),
    ("T-A09", "ayúdame con mcp server y model context protocol tools", "mcp-developer", "agent"),
    ("T-A10", "python-pro revisa el código con pydantic y asyncio", "python-pro", "agent"),
    # ── Layer 2: Plugins ─────────────────────────────────────────────────────
    ("T-PL01", "haz un systematic debugging del bug intermitente", "systematic-debugging", "plugin"),
    ("T-PL02", "vamos a hacer tdd red green refactor en el módulo", "test-driven-development", "plugin"),
    ("T-PL03", "hookify crea un hook PreToolUse para settings.json", "hookify", "plugin"),
    ("T-PL04", "git commit con conventional commits message", "commit", "plugin"),
    ("T-PL05", "second opinion codex review de este PR", "second-opinion", "plugin"),
    ("T-PL06", "playwright e2e test web app local con browser snapshot", "webapp-testing", "plugin"),
    ("T-PL07", "security scan con owasp sast y cve check", "security-scan", "plugin"),
    ("T-PL08", "zero-downtime migration alter table prisma migrate", "database-migrations", "plugin"),
    # ── Layer 2: NEW plugin/skill rules (cobertura expandida 2026-06-05) ──────
    ("T-PL09", "necesito un distributed lock con redis para rate limiting", "redis-patterns", "plugin"),
    ("T-PL10", "refactor a hexagonal architecture con ports and adapters", "hexagonal-architecture", "plugin"),
    ("T-PL11", "genera un word document .docx con tabla de contenidos", "docx", "plugin"),
    ("T-PL12", "dibuja un mermaid diagram de la arquitectura", "markdown-mermaid-writing", "plugin"),
    ("T-PL13", "winget install y windows registry para windows admin", "windows-admin", "plugin"),
    ("T-PL14", "estrategia b2b saas go-to-market para el producto", "business-strategist", "plugin"),
    ("T-PL15", "production readiness checklist y rollback strategy deployment patterns", "deployment-patterns", "plugin"),
    ("T-PL16", "configura googletest y ctest para cpp testing", "cpp-testing", "plugin"),
    ("T-PL17", "escribe un architecture decision record adr de esta decisión", "architecture-decision-records", "plugin"),
    ("T-PL18", "implementa circuit breaker y typed errors error handling patterns", "error-handling", "plugin"),
    # ── Layer 3: NEW agentes (cobertura expandida 2026-06-05) ────────────────
    ("T-A11", "git-workflow-manager define una branching strategy gitflow", "git-workflow-manager", "agent"),
    ("T-A12", "knowledge-synthesizer extract patterns across agents", "knowledge-synthesizer", "agent"),
    ("T-A13", "dx-optimizer para mejorar build times y feedback loop", "dx-optimizer", "agent"),
    # ── Silencio: prompts ambiguos de baja confianza (<0.50) ────────────────
    ("T-S01", "hola", "", "silent"),
    ("T-S02", "ok", "", "silent"),
    ("T-S03", "¿puedes ayudarme?", "", "silent"),
    # ── Word-boundary regression (QW1 del auditor) ───────────────────────────
    # Estos verifican que hasToken NO hace falso positivo
    ("T-WB01", "tengo reaccion alérgica al trigo", "", "silent"),   # "react" ⊄ "reaccion"
    ("T-WB02", "commitment issues en el equipo", "", "silent"),      # "commit" ⊄ "commitment"
    ("T-WB03", "no encuentro el attachment en el email", "", "silent"),  # sin señal real
]


def _run_dispatcher(prompt: str) -> dict:
    """Invoca routing-dispatcher.js con stdin JSON y devuelve el output parseado."""
    payload = json.dumps({"prompt": prompt, "session_id": "test-harness"})
    try:
        result = subprocess.run(
            ["node", str(DISPATCHER_JS)],
            input=payload,
            capture_output=True,
            text=True,
            timeout=8,
        )
        if result.stdout.strip():
            return json.loads(result.stdout.strip())
        return {}
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError) as exc:
        return {"_error": str(exc)}


def _extract_top_label(output: dict) -> str:
    """Extrae la etiqueta del top candidato del additionalContext del hook."""
    ctx = (
        output.get("hookSpecificOutput", {})
        .get("additionalContext", "")
    )
    return ctx or ""


def _classify_output(ctx: str) -> tuple[str, str]:
    """Devuelve (id_fragment, kind) desde el additionalContext.

    El hook emite líneas como:
        "Suggested: persona:terry-davis — signals matched: ..."
        "  1) agent:rust-engineer (score ..."
        "  1) skill:superpowers:systematic-debugging (score ..."
    """
    if not ctx.strip():
        return ("", "silent")

    # Buscar "Suggested: <kind>:<id>" (high confidence)
    for line in ctx.splitlines():
        line = line.strip()
        if line.startswith("Suggested:"):
            parts = line.split()
            if len(parts) >= 2:
                label = parts[1]  # e.g. "persona:terry-davis"
                kind, _, ident = label.partition(":")
                return (ident, kind)
        # Medium confidence: "  1) <kind>:<id> (score ..."
        if line.startswith("1)"):
            label = line.split()[1]
            kind, _, ident = label.partition(":")
            return (ident, kind)

    return ("", "unknown")


def main() -> None:
    if not DISPATCHER_JS.exists():
        print(f"ERROR: No encontrado {DISPATCHER_JS}")
        sys.exit(1)

    print(f"\n{'='*72}")
    print(f"ULTRON ROUTING TEST RUNNER v2.0 — taxonomía real JS dispatcher")
    print(f"Hook: {DISPATCHER_JS}")
    print(f"Casos: {len(TEST_CASES)}")
    print(f"{'='*72}\n")

    passed = failed = 0
    failures: list[dict] = []

    for test_id, prompt, expected_fragment, expected_kind in TEST_CASES:
        output = _run_dispatcher(prompt)

        if "_error" in output:
            failed += 1
            failures.append({
                "id": test_id, "prompt": prompt,
                "error": output["_error"],
            })
            print(f"  ERROR  {test_id:6} | {prompt[:55]:<55} | {output['_error']}")
            continue

        ctx = _extract_top_label(output)
        actual_fragment, actual_kind = _classify_output(ctx)

        if expected_kind == "silent":
            ok = (actual_kind == "silent")
        elif expected_kind == "plugin":
            # El JS emite kind="skill" para plugins (formatCandidateLabel usa "skill:" para kind=="plugin").
            # Verificamos que el fragmento esperado esté contenido en el id real completo.
            # Ej: esperado "systematic-debugging" ⊂ actual "superpowers:systematic-debugging" OK.
            ok = expected_fragment in actual_fragment and actual_kind == "skill"
        else:
            ok = (expected_fragment == actual_fragment and actual_kind == expected_kind)

        if ok:
            passed += 1
            if VERBOSE:
                label = f"{actual_kind}:{actual_fragment}" if actual_kind != "silent" else "(silent)"
                print(f"  PASS   {test_id:6} | {prompt[:55]:<55} => {label}")
        else:
            failed += 1
            actual_label = f"{actual_kind}:{actual_fragment}" if actual_kind != "silent" else "(silent)"
            # Plugins se emiten como "skill:<id>" por el JS; mostrar como "skill:*<fragment>*" para claridad.
            _exp_kind_display = "skill" if expected_kind == "plugin" else expected_kind
            expected_label = f"{_exp_kind_display}:*{expected_fragment}*" if expected_kind != "silent" else "(silent)"
            failures.append({
                "id": test_id, "prompt": prompt,
                "expected": expected_label, "actual": actual_label,
                "ctx_preview": ctx[:120].replace("\n", " | "),
            })
            print(f"  FAIL   {test_id:6} | {prompt[:55]:<55}")
            print(f"           expected: {expected_label:<35} actual: {actual_label}")

    print(f"\n{'='*72}")
    print(f"RESULTADO: {passed} PASS · {failed} FAIL · {len(TEST_CASES)} total")
    print(f"Taxonomia: personas(14) + agents(20) + plugins(25) — IDs del JS vivo")

    if failures:
        print(f"\nREGRESIONES DETECTADAS:")
        for f in failures:
            if "error" in f:
                print(f"  {f['id']}: ERROR — {f['error']}")
            else:
                print(f"  {f['id']}: esperaba [{f['expected']}]  got [{f['actual']}]")
                print(f"       prompt: \"{f['prompt']}\"")
                if f.get("ctx_preview"):
                    print(f"       ctx: {f['ctx_preview']}")
        sys.exit(1)
    else:
        print("\nTodos los tests pasan contra la taxonomia real del dispatcher JS.")
        sys.exit(0)


if __name__ == "__main__":
    main()
