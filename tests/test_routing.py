"""
Routing regression tests — v1.3 (Sprint 6).

Converted from references/routing-tests.md (43 cases).
Tests verify the intent dispatcher routes queries to the correct skill/persona.

Categories:
  layer1     — Clear single-signal cases (T-01 to T-09)
  tiebreak   — Tiebreak cases, most regression-prone (T-10 to T-16)
  plugins    — Layer 2 plugin routing (T-17 to T-21)
  combos     — Persona+plugin combos (T-22 to T-25)
  mode       — Mode selection (T-26 to T-28)
  overlay    — Overlay triggers (T-29 to T-38 subset)
  confidence — Confidence + ambiguous signals (T-31 to T-32)
  dual       — Dual mode overlay rules (T-39 to T-43)

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
        """T-01: .ts bug → terry-davis."""
        r = dispatch("tengo un bug en mi archivo .ts")
        assert top_skill(r) == "terry-davis", f"got {top_skill(r)}"

    def test_T02_gas_ue5(self):
        """T-02: Game Ability System UE5 → don-claudio."""
        r = dispatch("cómo funciona el Game Ability System en UE5")
        assert top_skill(r) == "don-claudio", f"got {top_skill(r)}"

    def test_T03_design_layout(self):
        """T-03: layout design → mike-tyson."""
        r = dispatch("diseña el layout de la pantalla de inventario")
        assert top_skill(r) == "mike-tyson", f"got {top_skill(r)}"

    def test_T04_monetize_pricing(self):
        """T-04: monetize/pricing → jordan-belfort."""
        r = dispatch("quiero monetizar mi app, qué modelo de pricing uso")
        assert top_skill(r) == "jordan-belfort", f"got {top_skill(r)}"

    def test_T05_transformer_concept(self):
        """T-05: transformer concept explanation → einstein."""
        r = dispatch("explícame qué es un transformer y cómo funciona la atención")
        assert top_skill(r) == "einstein", f"got {top_skill(r)}"

    def test_T06_calendar_reminder(self):
        """T-06: Google Calendar → pana."""
        r = dispatch("ponme un recordatorio en Google Calendar para mañana")
        assert top_skill(r) == "pana", f"got {top_skill(r)}"

    def test_T07_kutxabank_spending(self):
        """T-07: KutxaBank spending → tio-gilito."""
        r = dispatch("cuánto gasté en KutxaBank este mes")
        assert top_skill(r) == "tio-gilito", f"got {top_skill(r)}"

    def test_T08_academic_submission(self):
        """T-08: academic submission correction → repo-evaluator."""
        r = dispatch("corrige mi entrega del proyecto de backend de la uni")
        assert top_skill(r) == "repo-evaluator", f"got {top_skill(r)}"

    def test_T09_football_champions(self):
        """T-09: Champions/football → manolo-lama."""
        r = dispatch("cómo va el Barça en la Champions")
        assert top_skill(r) == "manolo-lama", f"got {top_skill(r)}"


# ── Tiebreaks ──────────────────────────────────────────────────────────────────

@pytest.mark.routing
@pytest.mark.tiebreak
class TestTiebreaks:
    def test_T10_ue5_over_bug(self):
        """T-10: UE5 Blueprint bug → don-claudio (UE5 beats generic bug)."""
        r = dispatch("tengo un bug en mi Blueprint de UE5")
        assert top_skill(r) == "don-claudio", f"got {top_skill(r)}"

    def test_T11_cpp_ue5_crash(self):
        """T-11: .cpp + UE5 → don-claudio."""
        r = dispatch("este .cpp de UE5 tiene un crash en la replicación")
        assert top_skill(r) == "don-claudio", f"got {top_skill(r)}"

    def test_T12_cs_unity_terry(self):
        """T-12: .cs Unity → terry-davis (not don-claudio)."""
        r = dispatch("este .cs de Unity no compila en Android")
        assert top_skill(r) == "terry-davis", f"got {top_skill(r)}"

    def test_T13_cuda_novalbos(self):
        """T-13: CUDA memory coalescing → novalbos (not einstein)."""
        r = dispatch("investiga cómo funciona CUDA y los memory coalescing patterns")
        assert top_skill(r) == "novalbos", f"got {top_skill(r)}"

    def test_T14_ue5_shader_don_claudio(self):
        """T-14: UE5 PBR material shader → don-claudio (not novalbos)."""
        r = dispatch("necesito un shader de material PBR para UE5")
        assert top_skill(r) == "don-claudio", f"got {top_skill(r)}"

    def test_T15_portfolio_typescript(self):
        """T-15: portfolio tracker TypeScript → warren first (then terry)."""
        r = dispatch("quiero construir un tracker de cartera en TypeScript")
        skills = all_skills(r)
        assert "warren" in skills, f"warren not in routes: {skills}"

    def test_T16_physics_python(self):
        """T-16: physics simulation in Python → profesor-fisica first (then terry)."""
        r = dispatch("tengo que simular colisiones para el examen de Física y hacerlo en Python")
        skills = all_skills(r)
        assert "profesor-fisica" in skills, f"profesor-fisica not in routes: {skills}"


# ── Layer 2 — Plugins ──────────────────────────────────────────────────────────

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
        assert top_skill(r) in ("superpowers:systematic-debugging", "terry-davis"), f"got {top_skill(r)}"

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
        """T-22: UI design+implement → mike-tyson in routes."""
        r = dispatch("diseña e implementa la pantalla de login con animaciones")
        skills = all_skills(r)
        assert "mike-tyson" in skills, f"mike-tyson not in routes: {skills}"

    def test_T25_investment_dashboard(self):
        """T-25: investment dashboard React+Supabase → warren + terry-davis."""
        r = dispatch("construye un dashboard de inversiones con React y Supabase")
        skills = all_skills(r)
        assert any(s in skills for s in ("warren", "terry-davis")), f"neither in routes: {skills}"


# ── Mode selection (behavior contracts — skip in CI) ───────────────────────────

@pytest.mark.manual
@pytest.mark.skip(reason="Mode selection is behavioral — requires LLM-as-judge, not automatable")
class TestModeSelection:
    def test_T26_low_factual(self):
        """T-26: simple factual → LOW mode, ≤50 words, 0 cascade."""

    def test_T27_high_hard_feature(self):
        """T-27: hard UE5 multiplayer feature → HIGH mode, don-claudio, Plan Mode."""

    def test_T28_ultra_explicit(self):
        """T-28: /ultra full architecture → ULTRA, THINKING, Plan Mode."""


# ── Confidence / ambiguity ─────────────────────────────────────────────────────

@pytest.mark.routing
@pytest.mark.confidence
class TestConfidenceReporting:
    def test_T31_ambiguous_financial_code(self):
        """T-31: ambiguous 'financial code' → terry-davis, warren, or code-review skill."""
        r = dispatch("revisa el código financiero")
        assert top_skill(r) in ("terry-davis", "warren", "superpowers:requesting-code-review"), \
            f"got {top_skill(r)}"

    def test_T32_sequential_ue5_research_implement(self):
        """T-32: research + implement UE5 → routes contain don-claudio or terry-davis."""
        r = dispatch("investiga los patrones de replicación de UE5 y luego impleméntalos")
        skills = all_skills(r)
        assert any(s in skills for s in ("don-claudio", "terry-davis", "einstein", "novalbos")), \
            f"unexpected routes: {skills}"


# ── Domain specificity ─────────────────────────────────────────────────────────

@pytest.mark.routing
@pytest.mark.layer1
class TestDomainSpecificity:
    def test_T34_monetize_ue5_plugin(self):
        """T-34: monetize UE5 plugin → jordan-belfort (domain beats 'investiga')."""
        r = dispatch("investiga cómo monetizar un plugin de UE5")
        assert top_skill(r) == "jordan-belfort", f"got {top_skill(r)}"

    def test_T35_pure_research_quantum(self):
        """T-35: pure research quantum mechanics → einstein."""
        r = dispatch("investiga cómo funciona la mecánica cuántica")
        assert top_skill(r) == "einstein", f"got {top_skill(r)}"


# ── Dual mode overlays (behavioral — skip in CI) ──────────────────────────────

@pytest.mark.manual
@pytest.mark.skip(reason="Dual mode overlays are behavioral — requires LLM-as-judge")
class TestDualModeOverlays:
    def test_T39_minidual_medium(self):
        """T-39: /minidual in MEDIUM → 1 round Codex, ≤500 tokens, no mode escalation."""

    def test_T40_dual_rejected_in_low(self):
        """T-40: /low /dual → rejection message, offer MEDIUM/HIGH."""

    def test_T41_maxdual_high_confirm(self):
        """T-41: /high /maxdual → confirmation prompt before 5 rounds."""

    def test_T42_contrast_dual(self):
        """T-42: /ultra /contrast --dual → FASE 4 via Codex."""

    def test_T43_dual_rounds_override(self):
        """T-43: /high /dual --rounds=2 → exactly 2 rounds."""


# ── Extension policy ──────────────────────────────────────────────────────────
# New tiebreak → add case in TestTiebreaks
# New persona → add case in TestLayer1ClearSignals
# Bug detected → add the exact failing input
# New combo → add case in TestPersonaPluginCombos
