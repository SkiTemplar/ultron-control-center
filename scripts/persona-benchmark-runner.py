#!/usr/bin/env python3
"""
ULTRON PERSONA BENCHMARK RUNNER · v1.0
Parsea references/persona-benchmarks.md y reporta cobertura + estadísticas.

Stage 1 (este script): cobertura estática + validación de estructura.
Stage 2 (futuro): integración LLM-as-judge para ejecutar cada caso contra Claude API.

Uso:
    python scripts/persona-benchmark-runner.py
    python scripts/persona-benchmark-runner.py --persona terry-davis
    python scripts/persona-benchmark-runner.py --validate-only
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ULTRON_DIR = Path(__file__).parent.parent
BENCHMARK_FILE = ULTRON_DIR / "references" / "persona-benchmarks.md"

KNOWN_PERSONAS = {
    "terry-davis", "gamedev-engineer", "mike-tyson", "jordan-belfort", "einstein",
    "novalbos", "personal-assistant", "windows-admin", "profesor-fisica", "tio-gilito", "warren",
    "repo-evaluator", "manolo-lama", "tolkien",
    # backwards-compat aliases for deprecated stubs
    "don-claudio", "pana", "alfred",
}

KNOWN_MODES = {"LOW", "MEDIUM", "HIGH", "ULTRA"}


# ── Parser ────────────────────────────────────────────────────────────────────

def parse_cases(text: str) -> list[dict]:
    """
    Parse case blocks like:
      ### P-XX — [persona] · [tipo]
      **Input:** `...`
      **Modo esperado:** LOW/MEDIUM/HIGH/ULTRA
      **Persona esperada:** [persona]
      ...
    """
    cases = []
    case_pattern = re.compile(
        r"^###\s+(P-\d+)\s+—\s+([\w-]+)(?:\s+·\s+([^\n]+))?",
        re.MULTILINE,
    )

    matches = list(case_pattern.finditer(text))
    for i, m in enumerate(matches):
        case_id = m.group(1)
        persona_in_header = m.group(2)
        tipo = (m.group(3) or "").strip()

        block_start = m.end()
        block_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[block_start:block_end]

        input_match = re.search(r"\*\*Input:\*\*\s*`([^`]+)`", block)
        mode_match = re.search(r"\*\*Modo esperado:\*\*\s*([A-Z/\s]+?)(?:\s|$)", block)
        persona_match = re.search(r"\*\*Persona esperada:\*\*\s*\*?\*?([\w-]+)", block)
        signals_match = re.search(r"\*\*Expected signals[^*]*\*\*([^*]+?)(?:\*\*Anti-patterns|\*\*Notes|###|$)",
                                   block, re.DOTALL)
        antipat_match = re.search(r"\*\*Anti-patterns:\*\*([^*]+?)(?:\*\*Notes|###|$)", block, re.DOTALL)

        signals = []
        if signals_match:
            signals = [
                s.strip("- \n")
                for s in signals_match.group(1).split("\n")
                if s.strip().startswith("-")
            ]

        antipatterns = []
        if antipat_match:
            antipatterns = [
                s.strip("- \n")
                for s in antipat_match.group(1).split("\n")
                if s.strip().startswith("-") or "❌" in s
            ]

        cases.append({
            "id": case_id,
            "persona_header": persona_in_header,
            "tipo": tipo,
            "input": input_match.group(1) if input_match else None,
            "mode": mode_match.group(1).strip() if mode_match else None,
            "persona_expected": persona_match.group(1) if persona_match else None,
            "signal_count": len(signals),
            "antipattern_count": len(antipatterns),
        })

    return cases


# ── Validators ────────────────────────────────────────────────────────────────

def validate_case(case: dict) -> list[str]:
    issues = []
    cid = case["id"]

    if case["persona_header"] not in KNOWN_PERSONAS:
        issues.append(f"{cid}: persona en header '{case['persona_header']}' no reconocida")

    if case["input"] is None:
        issues.append(f"{cid}: falta campo Input")

    if case["mode"]:
        modes_in_string = [m for m in KNOWN_MODES if m in case["mode"]]
        if not modes_in_string:
            issues.append(f"{cid}: Modo esperado '{case['mode']}' no contiene modo válido")
    else:
        issues.append(f"{cid}: falta campo Modo esperado")

    if case["persona_expected"] is None:
        issues.append(f"{cid}: falta campo Persona esperada")

    if case["signal_count"] < 2:
        issues.append(f"{cid}: solo {case['signal_count']} expected signals (recomendado ≥3)")

    return issues


# ── Reports ───────────────────────────────────────────────────────────────────

def print_coverage(cases: list[dict]) -> None:
    persona_counts: defaultdict[str, int] = defaultdict(int)
    for c in cases:
        if c["persona_header"]:
            persona_counts[c["persona_header"]] += 1

    print("\nCOBERTURA POR PERSONA")
    print("─" * 50)
    for persona in sorted(KNOWN_PERSONAS):
        count = persona_counts.get(persona, 0)
        marker = "✅" if count >= 1 else "❌"
        bar = "█" * count
        print(f"  {marker} {persona:<20} {count} casos {bar}")

    missing = KNOWN_PERSONAS - set(persona_counts.keys())
    if missing:
        print(f"\n⚠️  Personas sin cubrir: {sorted(missing)}")
    else:
        print(f"\n✅ Todas las {len(KNOWN_PERSONAS)} personas cubiertas")


def print_mode_distribution(cases: list[dict]) -> None:
    mode_counts: defaultdict[str, int] = defaultdict(int)
    for c in cases:
        if c["mode"]:
            for mode in KNOWN_MODES:
                if mode in c["mode"]:
                    mode_counts[mode] += 1
                    break

    print("\nDISTRIBUCIÓN POR MODO")
    print("─" * 50)
    total = len(cases)
    for mode in ["LOW", "MEDIUM", "HIGH", "ULTRA"]:
        count = mode_counts.get(mode, 0)
        pct = (count / total * 100) if total else 0
        print(f"  {mode:<8} {count:>3} casos ({pct:.0f}%)")


def print_summary(cases: list[dict], all_issues: list[str]) -> None:
    print("\n" + "=" * 50)
    print("RESUMEN")
    print("=" * 50)
    print(f"  Total casos:     {len(cases)}")
    print(f"  Issues:          {len(all_issues)}")

    if all_issues:
        print("\nISSUES:")
        for issue in all_issues:
            print(f"  ⚠️  {issue}")
    else:
        print("\n  ✅ Validación limpia: todos los casos cumplen estructura mínima")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="ULTRON Persona Benchmark Runner")
    parser.add_argument("--persona", help="Filter to specific persona")
    parser.add_argument("--validate-only", action="store_true",
                        help="Solo validar estructura, no imprimir cobertura")
    args = parser.parse_args()

    if not BENCHMARK_FILE.exists():
        print(f"❌ No encuentro {BENCHMARK_FILE}", file=sys.stderr)
        return 1

    text = BENCHMARK_FILE.read_text(encoding="utf-8")
    cases = parse_cases(text)

    if args.persona:
        cases = [c for c in cases if c["persona_header"] == args.persona]
        if not cases:
            print(f"⚠️  No encontré casos para persona '{args.persona}'")
            return 1

    print(f"\n{'='*50}")
    print(f"PERSONA BENCHMARK RUNNER · {len(cases)} casos parsed")
    print(f"{'='*50}")

    all_issues = []
    for case in cases:
        all_issues.extend(validate_case(case))

    if not args.validate_only:
        print_coverage(cases)
        print_mode_distribution(cases)

    print_summary(cases, all_issues)

    return 1 if all_issues else 0


if __name__ == "__main__":
    sys.exit(main())
