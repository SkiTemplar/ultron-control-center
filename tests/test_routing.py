"""
Routing regression tests — v2 (sanitized for public release).

Tests verify the intent dispatcher routes queries to the correct skill/persona
for the PUBLIC skill set shipped in this repo. Forks that add private personas
should extend this file with their own cases.

Categories:
  layer1     — Clear single-signal cases
  tiebreak   — Tiebreak cases, most regression-prone
  plugins    — Plugin routing
  combos     — Persona + plugin combos
  confidence — Confidence + ambiguous signals

Run:
  uv run pytest tests/test_routing.py -v
  uv run pytest tests/test_routing.py -v -m layer1
  uv run pytest tests/test_routing.py -v -m tiebreak
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts" / "cockpit"))
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts" / "hooks"))


# ── Helpers ────────────────────────────────────────────────────────────────────

def dispatch(query: str) -> dict:
    from intent_dispatcher import dispatch_intent
    return dispatch_intent(query)


def top_skill(result: dict) -> str | None:
    routes = result.get("routes", [])
    return routes[0]["skill"] if routes else None


def confidence(result: dict) -> float:
    routes = result.get("routes", [])
    return routes[0]["confidence"] if routes else 0.0


def all_skills(result: dict) -> list[str]:
    return [r["skill"] for r in result.get("routes", [])]


# ── Layer 1 — Clear signals ────────────────────────────────────────────────────

@pytest.mark.routing
@pytest.mark.layer1
class TestLayer1ClearSignals:
    def test_T01_ts_bug(self):
        """T-01: .ts bug → senior-engineer."""
        r = dispatch("tengo un bug en mi archivo .ts")
        assert top_skill(r) == "senior-engineer", f"got {top_skill(r)}"

    def test_T02_gas_ue5(self):
        """T-02: Game Ability System UE5 → gamedev-engineer."""
        r = dispatch("cómo funciona el Game Ability System en UE5")
        assert top_skill(r) == "gamedev-engineer", f"got {top_skill(r)}"

    def test_T03_design_layout(self):
        """T-03: layout design → ui-designer."""
        r = dispatch("diseña el layout de la pantalla de inventario")
        assert top_skill(r) == "ui-designer", f"got {top_skill(r)}"

    def test_T04_monetize_pricing(self):
        """T-04: monetize/pricing → business-strategist."""
        r = dispatch("quiero monetizar mi app, qué modelo de pricing uso")
        assert top_skill(r) == "business-strategist", f"got {top_skill(r)}"

    def test_T05_transformer_concept(self):
        """T-05: transformer concept explanation → research-explainer."""
        r = dispatch("explícame qué es un transformer y cómo funciona la atención")
        assert top_skill(r) == "research-explainer", f"got {top_skill(r)}"

    def test_T08_academic_submission(self):
        """T-08: academic submission correction → repo-evaluator."""
        r = dispatch("corrige mi entrega del proyecto de backend de la uni")
        assert top_skill(r) == "repo-evaluator", f"got {top_skill(r)}"


# ── Tiebreaks ──────────────────────────────────────────────────────────────────

@pytest.mark.routing
@pytest.mark.tiebreak
class TestTiebreaks:
    def test_T10_ue5_over_bug(self):
        """T-10: UE5 Blueprint bug → gamedev-engineer (UE5 beats generic bug)."""
        r = dispatch("tengo un bug en mi Blueprint de UE5")
        assert top_skill(r) == "gamedev-engineer", f"got {top_skill(r)}"

    def test_T11_cpp_ue5_crash(self):
        """T-11: .cpp + UE5 → gamedev-engineer."""
        r = dispatch("este .cpp de UE5 tiene un crash en la replicación")
        assert top_skill(r) == "gamedev-engineer", f"got {top_skill(r)}"

    def test_T12_cs_unity_senior_engineer(self):
        """T-12: .cs Unity → senior-engineer (not gamedev-engineer)."""
        r = dispatch("este .cs de Unity no compila en Android")
        assert top_skill(r) == "senior-engineer", f"got {top_skill(r)}"

    def test_T13_cuda_senior_engineer(self):
        """T-13: CUDA memory coalescing → senior-engineer (not research-explainer)."""
        r = dispatch("investiga cómo funciona CUDA y los memory coalescing patterns")
        assert top_skill(r) == "senior-engineer", f"got {top_skill(r)}"

    def test_T14_ue5_shader_gamedev_engineer(self):
        """T-14: UE5 PBR material shader → gamedev-engineer."""
        r = dispatch("necesito un shader de material PBR para UE5")
        assert top_skill(r) == "gamedev-engineer", f"got {top_skill(r)}"


# ── Plugin routing ─────────────────────────────────────────────────────────────

@pytest.mark.routing
@pytest.mark.plugins
class TestPluginRouting:
    def test_T17_code_review(self):
        """T-17: code review PR → pr-review-toolkit:code-reviewer."""
        r = dispatch("haz un code review de este PR")
        assert top_skill(r) == "pr-review-toolkit:code-reviewer", f"got {top_skill(r)}"

    def test_T18_tdd(self):
        """T-18: TDD feature → superpowers:test-driven-development."""
        r = dispatch("quiero hacer TDD para esta feature nueva")
        assert top_skill(r) == "superpowers:test-driven-development", f"got {top_skill(r)}"

    def test_T19_systematic_debug(self):
        """T-19: persistent unexplained bug → superpowers:systematic-debugging."""
        r = dispatch("llevo 3 sesiones con este bug y no encuentro la causa")
        assert top_skill(r) in ("superpowers:systematic-debugging", "senior-engineer"), f"got {top_skill(r)}"

    def test_T20_mcp_builder(self):
        """T-20: create MCP server → mcp-builder."""
        r = dispatch("quiero crear un MCP server para conectar con Notion")
        assert top_skill(r) == "mcp-builder", f"got {top_skill(r)}"

    def test_T21_db_schema(self):
        """T-21: DB schema design → database-schema-designer."""
        r = dispatch("diseña el schema de la base de datos para el proyecto")
        assert top_skill(r) == "database-schema-designer", f"got {top_skill(r)}"


# ── Combos ─────────────────────────────────────────────────────────────────────

@pytest.mark.routing
@pytest.mark.combos
class TestPersonaPluginCombos:
    def test_T22_ui_design_plus_code(self):
        """T-22: UI design + implement → ui-designer in routes."""
        r = dispatch("diseña e implementa la pantalla de login con animaciones")
        skills = all_skills(r)
        assert "ui-designer" in skills, f"ui-designer not in routes: {skills}"


# ── Confidence / ambiguity ─────────────────────────────────────────────────────

@pytest.mark.routing
@pytest.mark.confidence
class TestConfidenceReporting:
    def test_T31_ambiguous_financial_code(self):
        """T-31: ambiguous 'financial code' → senior-engineer or code-review skill."""
        r = dispatch("revisa el código financiero")
        assert top_skill(r) in ("senior-engineer", "superpowers:requesting-code-review"), \
            f"got {top_skill(r)}"

    def test_T32_sequential_ue5_research_implement(self):
        """T-32: research + implement UE5 → routes contain gamedev-engineer or senior-engineer."""
        r = dispatch("investiga los patrones de replicación de UE5 y luego impleméntalos")
        skills = all_skills(r)
        assert any(s in skills for s in ("gamedev-engineer", "senior-engineer", "research-explainer")), \
            f"unexpected routes: {skills}"


# ── Alias resolution (forks may register their own aliases) ────────────────────

@pytest.mark.routing
class TestSkillAliasResolution:
    """Verify resolve_skill_alias works as a passthrough by default.

    Forks adding private personas can populate SKILL_ALIASES in
    skill_lazy_loader.py and add their own test cases here.
    """

    def test_alias_map_passthrough_unknown(self):
        """Unknown skill names pass through unchanged."""
        from skill_lazy_loader import resolve_skill_alias
        assert resolve_skill_alias("senior-engineer") == "senior-engineer"
        assert resolve_skill_alias("nonexistent-skill") == "nonexistent-skill"


# ── Domain specificity ─────────────────────────────────────────────────────────

@pytest.mark.routing
@pytest.mark.layer1
class TestDomainSpecificity:
    def test_T34_monetize_ue5_plugin(self):
        """T-34: monetize UE5 plugin → business-strategist (domain beats 'investiga')."""
        r = dispatch("investiga cómo monetizar un plugin de UE5")
        assert top_skill(r) == "business-strategist", f"got {top_skill(r)}"

    def test_T35_pure_research_quantum(self):
        """T-35: pure research quantum mechanics → research-explainer."""
        r = dispatch("investiga cómo funciona la mecánica cuántica")
        assert top_skill(r) == "research-explainer", f"got {top_skill(r)}"


# Extension policy:
#   New tiebreak    -> add case in TestTiebreaks
#   New persona     -> add case in TestLayer1ClearSignals
#   Bug detected    -> add the exact failing input
#   New combo       -> add case in TestPersonaPluginCombos
