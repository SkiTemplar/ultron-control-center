"""Macro-test set for the intent dispatcher.

Built from eval-4 (round 1) — the 20-prompt harness designed to convert
the marketing claim "95% routing precision" into a measured number. Each
row asserts that a real-world prompt routes (or correctly NO-routes) to
the documented persona / skill / mode / agent.

Pass bar: 19/20 (95%). When this suite fails, the regression is usually
either a new rule that over-fires (regex too broad) or a removed persona
without a corresponding rule removal.

Eight rows are obvious cases (1-8) that any rule fix should never regress.
Six rows are ambiguous (9-14) where dispatcher behaviour is allowed to
vary slightly between revisions but must not regress to no-route. Six rows
are edge/adversarial (15-20) that protect personas added in v15.5.15.

References:
    .tmp/evals/eval-4-memory-routing.md
    config/intent-rules.yaml
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make the cockpit shim importable (mirrors test_routing.py setup).
COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

from intent_dispatcher import dispatch_intent  # noqa: E402

# Each case: (id, prompt, expected_skill_or_None_for_no_route, min_confidence,
#             mode_hint, category).
# expected_skill = None means "we expect no-route" (rule should NOT fire).
# min_confidence = lower bound on the reported confidence (0.0 = any).
# mode_hint is informational — mode-trigger.py runs separately.
# category labels the row so we can break-out the pass-rate per band.
CASES: list[tuple[str, str, str | None, float, str, str]] = [
    # ── Obvious (8 rows — must pass) ────────────────────────────────────────
    ("M01", "corrígeme este bug en el módulo de auth, llevo 2 horas",
     "superpowers:systematic-debugging", 0.90, "MEDIUM", "obvious"),
    ("M02", "diseña la arquitectura de un sistema de pagos multi-tenant",
     "agent-skills:plan", 0.90, "ULTRA", "obvious"),
    ("M03", "revisa este PR de TypeScript",
     "pr-review-toolkit:code-reviewer", 0.90, "MEDIUM", "obvious"),
    ("M04", "cómo implemento cooldown en una ability de GAS sin romper replicación",
     "gamedev-engineer", 0.80, "MEDIUM", "obvious"),
    ("M05", "crea el schema de la tabla users con índices compuestos",
     "database-schema-designer", 0.85, "MEDIUM", "obvious"),
    ("M06", "qué pricing pongo a mi plugin SaaS de productividad",
     "business-strategist", 0.85, "MEDIUM", "obvious"),
    ("M07", "audita la seguridad del backend de auth",
     "security-review", 0.80, "HIGH", "obvious"),
    ("M08", "explícame cómo funciona la attention multi-head de un transformer",
     "research-explainer", 0.80, "LEARN", "obvious"),
    # ── Ambiguous (6 rows — may drift, must not regress to None) ────────────
    ("M09", "revisa mi trabajo",  # legitimately too vague — accept no-route
     None, 0.0, "MEDIUM", "ambiguous"),
    ("M10", "actualiza esto",
     "ultron", 0.80, "MEDIUM", "ambiguous"),  # ultron-rebuild rule
    ("M11", "mira si este código está bien",
     "superpowers:requesting-code-review", 0.80, "MEDIUM", "ambiguous"),
    ("M12", "el sistema está roto y no sé por dónde empezar",
     "superpowers:systematic-debugging", 0.90, "HIGH", "ambiguous"),
    ("M13", "qué hice ayer",
     "ultron", 0.80, "HIGH", "ambiguous"),
    ("M14", "dame nota a este T9 del backend",
     "repo-evaluator", 0.85, "MEDIUM", "ambiguous"),
    # ── Edge / personal personas added in v15.5.15 (6 rows) ─────────────────
    ("M15", "kernel CUDA con coalescing",
     "senior-engineer", 0.85, "MEDIUM", "edge"),
    ("M16", "Gilito, cuánto he gastado este mes",
     "tio-gilito", 0.90, "MEDIUM", "edge-persona"),
    ("M17", "Warren, ¿cómo va mi cartera?",
     "warren", 0.85, "MEDIUM", "edge-persona"),
    ("M18", "Tolkien, escribe el siguiente capítulo del libro",
     "tolkien", 0.85, "MEDIUM", "edge-persona"),
    ("M19", "Pana, dame el briefing del día",
     "pana", 0.85, "MEDIUM", "edge-persona"),
    ("M20", "Alfred, monitoriza el sistema y mata los procesos zombies",
     "alfred", 0.80, "MEDIUM", "edge-persona"),
]


@pytest.mark.routing
@pytest.mark.parametrize(
    "case_id,prompt,expected_skill,min_conf,_mode,_category",
    CASES,
    ids=[c[0] for c in CASES],
)
def test_macro_case(
    case_id: str,
    prompt: str,
    expected_skill: str | None,
    min_conf: float,
    _mode: str,
    _category: str,
) -> None:
    """Each macro row asserts dispatcher output matches the expected route."""
    result = dispatch_intent(prompt)
    routes = result.get("routes") or []

    if expected_skill is None:
        # No-route assertion: dispatcher should NOT pick a skill (or pick with
        # confidence below the routing threshold). Allow either empty routes
        # OR a route below 0.85 (the default ZTMSI cut).
        if not routes:
            return
        top = routes[0]
        assert top.get("confidence", 0.0) < 0.85, (
            f"{case_id}: expected no-route for {prompt!r}, "
            f"got {top.get('skill')!r} @ {top.get('confidence')}"
        )
        return

    assert routes, (
        f"{case_id}: dispatcher returned no route for {prompt!r}, "
        f"expected {expected_skill!r}"
    )
    top = routes[0]
    assert top.get("skill") == expected_skill, (
        f"{case_id}: expected skill {expected_skill!r}, "
        f"got {top.get('skill')!r} for prompt {prompt!r}"
    )
    assert top.get("confidence", 0.0) >= min_conf, (
        f"{case_id}: confidence {top.get('confidence')} below min {min_conf}"
    )


def test_macro_aggregate_pass_rate() -> None:
    """Compute aggregate pass rate as a separate signal.

    The parametrised cases above fail-fast per row. This summary test is
    informational — it counts how many cases the dispatcher gets right and
    asserts the aggregate is at least 95%. Useful when a single regression
    needs to be triaged against the bigger picture.
    """
    passed = 0
    fails: list[str] = []
    for case_id, prompt, expected_skill, min_conf, _mode, _category in CASES:
        try:
            result = dispatch_intent(prompt)
        except Exception as exc:
            fails.append(f"{case_id}: dispatcher exception {exc!r}")
            continue
        routes = result.get("routes") or []
        if expected_skill is None:
            if not routes or routes[0].get("confidence", 0.0) < 0.85:
                passed += 1
            else:
                fails.append(
                    f"{case_id}: expected no-route, got {routes[0].get('skill')!r}"
                )
            continue
        if not routes:
            fails.append(f"{case_id}: no route, expected {expected_skill!r}")
            continue
        top = routes[0]
        if top.get("skill") == expected_skill and top.get("confidence", 0.0) >= min_conf:
            passed += 1
        else:
            fails.append(
                f"{case_id}: got {top.get('skill')!r} @ {top.get('confidence')}, "
                f"expected {expected_skill!r} @ ≥{min_conf}"
            )
    rate = passed / len(CASES)
    assert rate >= 0.95, (
        f"Macro routing pass rate {rate:.1%} ({passed}/{len(CASES)}) below 95% bar.\n"
        + "\n".join(f"  - {f}" for f in fails)
    )
