#!/usr/bin/env python3
# === maintainer-only (not user-facing) ===
# Routing rules regression harness. Run manually after intent-rules.yaml
# edits. No hook or control-center caller. See docs/MAINTAINERS.md.
"""
ULTRON ROUTING TEST RUNNER · v1.0
Verifica FAST PATH Layer 1 + tiebreaks contra routing-tests.md.

Uso:
    python scripts/routing-test-runner.py
    python scripts/routing-test-runner.py --verbose

Qué automatiza: T-01..T-16, T-34, T-35 (Layer 1 + tiebreaks)
Qué omite:       T-17..T-33, T-36..T-38 (Layer 2, combos, overlays, modos — requieren juicio humano)
"""
import re
import sys
import io
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

SKILL_DIR = Path(__file__).parent.parent
TESTS_FILE = SKILL_DIR / "references" / "routing-tests.md"

VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv

# ── FAST PATH Layer 1 ──────────────────────────────────────────────────────────
# Orden: de mayor a menor prioridad en tiebreaks.
# Las filas más altas ganan cuando hay señal en múltiples personas.
FAST_PATH = [
    ("gamedev-engineer", [
        "ue5", "unreal", "blueprint", "enhanced input", "netcode",
        "game dev", "PROGRAM_A", "game ability system", "game ability",
        "shader de juego", "shader de material", "material pbr",
    ]),
    ("business-strategist", [
        "monetizar", "pricing", "pitch", "clientes", "ventas", "gtm",
        "modelo de negocio", "b2b", "saas",
    ]),
    ("repo-evaluator", [
        "corrige", "evalúa", "repo-evaluator", "ponme nota", "nota", "entrega", "repo",
    ]),
    ("ui-designer", [
        "layout", "wireframe", "landing", "interfaz visual", "mockup",
    ]),
    ("windows-admin", [
        "powershell", "driver", "carpeta local", "sistema operativo",
        "proceso de windows", "registro de windows",
    ]),
    ("research-explainer", [
        "investiga", "explica", "explícame", "paper", "ciencia",
        "por qué", "teoría", "concepto", "cómo funciona", "mecánica cuántica",
        "transformer",
    ]),
    ("senior-engineer", [
        ".cpp", ".cs", ".ts", ".py", "bug", "commit", "deploy", "refactor",
        "compila", "crash", "typescript", "código", "implementa",
        # graphics / low-level (formerly routed to private graphics persona)
        "cuda", "opengl", "vulkan", "dx12", "metal", "simd", "backprop",
        "bajo nivel", "asm", "compilador", "gpu pipeline",
        "memory coalescing", "c++ profundo",
    ]),
]

# ── Tiebreaks (evaluar ANTES de la tabla de prioridad) ────────────────────────

def apply_tiebreaks(text: str) -> str | None:
    t = text.lower()

    # .cs + Unity → senior-engineer (tiebreak: .cs wins over gamedev-engineer)
    if ".cs" in t and "unity" in t:
        return "senior-engineer"

    # UE5/Unreal + .cpp / bug / crash / blueprint → gamedev-engineer
    is_ue5 = any(s in t for s in ["ue5", "unreal", "blueprint"])
    if is_ue5 and any(s in t for s in [".cpp", "bug", "crash", "blueprint"]):
        return "gamedev-engineer"

    # shader + UE5 / material → gamedev-engineer
    if "shader" in t and any(s in t for s in ["ue5", "material pbr", "material", "pbr"]):
        return "gamedev-engineer"

    # CUDA / GPU bajo nivel → senior-engineer (no research-explainer, aunque haya "investiga")
    is_gpu = any(s in t for s in ["cuda", "memory coalescing", "opengl", "vulkan", "simd"])
    if is_gpu:
        return "senior-engineer"

    # transformer en contexto conceptual → research-explainer
    if "transformer" in t and any(s in t for s in ["explica", "explícame", "qué es", "cómo funciona", "atención"]):
        return "research-explainer"

    # investiga + dominio específico → persona de ese dominio (no research-explainer)
    if "investiga" in t:
        if any(s in t for s in ["monetizar", "pricing"]):
            return "business-strategist"
        if any(s in t for s in ["ue5", "unreal", "blueprint"]):
            return "gamedev-engineer"

    return None  # sin tiebreak — usar tabla de prioridad


# ── Motor de routing ──────────────────────────────────────────────────────────

def route(text: str) -> str:
    t = text.lower()

    # Tiebreaks primero
    tb = apply_tiebreaks(text)
    if tb:
        return tb

    # Buscar matches en tabla de prioridad
    for persona, signals in FAST_PATH:
        if any(s in t for s in signals):
            return persona

    return "no-match"


# ── Parser de routing-tests.md ───────────────────────────────────────────────

def normalize_expected(raw: str) -> str:
    """Extrae la persona principal de un Expected que puede ser complejo."""
    # Quitar markdown
    s = re.sub(r"\*\*|`", "", raw)
    # Tomar primer fragmento antes de "·"
    s = s.split("·")[0].strip()
    # Tomar antes del primer "(" (quita "(valida/diseña), terry implementa")
    s = s.split("(")[0].strip()
    # Quitar " primero" y similares
    s = re.sub(r"\s+primero\b", "", s).strip()
    # Quitar ", terry implementa" y similares
    s = re.sub(r",.*", "", s).strip()
    return s


def parse_tests(path: Path) -> list[dict]:
    """Parse routing-tests.md into structured test cases.

    Returns parseable cases (with valid Input + Expected). Cases that
    intentionally lack these fields (meta-tests like T-33 'frontmatter count')
    are reported separately so the count is transparent — no silent skips.
    """
    text = path.read_text(encoding="utf-8")
    tests = []
    skipped_meta = []

    # Cada bloque: ### T-XX ... **Input:** `"..."` ... **Expected:** ...
    pattern = re.compile(
        r"### (T-\d+)[^\n]*\n(.*?)(?=\n### T-|\Z)",
        re.DOTALL,
    )
    for m in pattern.finditer(text):
        tid = m.group(1)
        block = m.group(2)

        inp_m = re.search(r"\*\*Input:\*\*\s*`\"(.+?)\"`", block)
        exp_m = re.search(r"\*\*Expected:\*\*\s*(.+?)(?=\n\*\*|\Z)", block)

        if not inp_m or not exp_m:
            # Meta-test or malformed — record so the count is transparent
            reason = "no Input field" if not inp_m else "no Expected field"
            skipped_meta.append({"id": tid, "reason": reason})
            continue

        inp = inp_m.group(1).strip()
        expected = normalize_expected(exp_m.group(1).strip().split("\n")[0])
        tests.append({"id": tid, "input": inp, "expected": expected})

    if skipped_meta and VERBOSE:
        print(f"\n📋 Casos meta (no parseables como routing test): {len(skipped_meta)}")
        for sk in skipped_meta:
            print(f"   {sk['id']} — skipped ({sk['reason']})")

    return tests


# ── Tests automáticamente verificables ───────────────────────────────────────

AUTOMATABLE = {
    "T-01", "T-02", "T-03", "T-04", "T-05",
    "T-06", "T-07", "T-08", "T-09",
    "T-10", "T-11", "T-12", "T-13", "T-14", "T-15", "T-16",
    "T-34", "T-35",
}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if not TESTS_FILE.exists():
        print(f"ERROR: No encuentro {TESTS_FILE}")
        sys.exit(1)

    tests = parse_tests(TESTS_FILE)
    if not tests:
        print("ERROR: No se pudieron parsear test cases de routing-tests.md")
        sys.exit(1)

    passed = failed = skipped = 0
    failures = []

    print(f"\n{'='*70}")
    print(f"ULTRON ROUTING TEST RUNNER · {len(tests)} casos encontrados en archivo")
    print(f"{'='*70}\n")

    for t in tests:
        if t["id"] not in AUTOMATABLE:
            skipped += 1
            if VERBOSE:
                print(f"⏭  SKIP  {t['id']:5} | {t['input'][:55]}")
            continue

        actual = route(t["input"])
        expected = t["expected"]
        ok = actual == expected

        if ok:
            passed += 1
            if VERBOSE:
                print(f"✅ PASS  {t['id']:5} | {t['input'][:55]:<55} → {actual}")
        else:
            failed += 1
            failures.append(t | {"actual": actual})
            print(f"❌ FAIL  {t['id']:5} | {t['input'][:55]:<55} | expected: {expected:<22} | got: {actual}")

    if not VERBOSE and failed == 0:
        print(f"✅ Todos los tests automáticos pasan ({passed} PASS).")
    elif VERBOSE:
        print()

    print(f"\n{'='*70}")
    print(f"RESULTADO: {passed} PASS · {failed} FAIL · {skipped} SKIP")
    print(f"(SKIP = manual: Layer 2, combos, overlays, selección de modo)")

    if failures:
        print(f"\n⚠️  REGRESIONES DETECTADAS — REVISAR FAST PATH ANTES DE CERRAR SESIÓN:")
        for f in failures:
            print(f"   {f['id']}: esperaba [{f['expected']}], got [{f['actual']}]")
            print(f"        input: \"{f['input']}\"")
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
