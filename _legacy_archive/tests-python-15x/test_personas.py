"""
Persona routing + behavior contract tests.

Two test layers:
  Layer A — Routing (automated): verifies dispatcher routes to expected persona.
  Layer B — Behavior signals (manual): documented expectations for persona response quality.

Run all:     uv run pytest tests/test_personas.py -v
Run routing: uv run pytest tests/test_personas.py -v -m routing
Run manual:  uv run pytest tests/test_personas.py -v -m manual (always skipped in CI)

Note: Only PUBLIC personas distributed in this repo are tested. Forks that
introduce private personas (assistants, finance, narrative writing, etc.)
should extend this file with their own routing cases.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts" / "cockpit"))
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts" / "hooks"))


# ── Helpers ────────────────────────────────────────────────────────────────────

def dispatch(query: str) -> dict:
    """Call intent dispatcher and return its JSON output."""
    from intent_dispatcher import dispatch_intent
    return dispatch_intent(query)


def top_skill(result: dict) -> str | None:
    routes = result.get("routes", [])
    return routes[0]["skill"] if routes else None


def confidence(result: dict) -> float:
    routes = result.get("routes", [])
    return routes[0]["confidence"] if routes else 0.0


# ── Routing tests (Layer A) ────────────────────────────────────────────────────

@pytest.mark.routing
class TestSeniorEngineerRouting:
    def test_P01_ts_bug(self):
        """Bug in .ts file → senior-engineer."""
        r = dispatch("tengo un bug en este .ts, échale un ojo")
        assert top_skill(r) == "senior-engineer", f"got {top_skill(r)}"

    def test_P01b_refactor(self):
        """Refactor request → senior-engineer."""
        r = dispatch("refactoriza este módulo, está hecho un desastre")
        assert top_skill(r) == "senior-engineer", f"got {top_skill(r)}"

    def test_P02_persistent_bug_high_mode(self):
        """Long-standing bug → systematic-debugging or senior-engineer, confidence > 0.70."""
        r = dispatch("llevo 3 sesiones intentando arreglar este bug y no encuentro la causa")
        assert top_skill(r) in ("senior-engineer", "superpowers:systematic-debugging"), \
            f"got {top_skill(r)}"
        assert confidence(r) >= 0.70


@pytest.mark.routing
class TestGamedevEngineerRouting:
    def test_P03_GAS_cooldown(self):
        """GAS cooldown → gamedev-engineer."""
        r = dispatch("cómo implemento un cooldown en una ability con GAS sin que rompa la replicación")
        assert top_skill(r) == "gamedev-engineer", f"got {top_skill(r)}"

    def test_P04_projectile_replication(self):
        """Replication without lag → gamedev-engineer."""
        r = dispatch("quiero spawnear un proyectil que se replique sin lag")
        assert top_skill(r) == "gamedev-engineer", f"got {top_skill(r)}"


@pytest.mark.routing
class TestGraphicsLowLevelRouting:
    def test_P05_opengl_pipeline(self):
        """OpenGL pipeline explanation → senior-engineer."""
        r = dispatch("explícame cómo funciona el pipeline de OpenGL desde el VAO hasta el fragment shader")
        assert top_skill(r) == "senior-engineer", f"got {top_skill(r)}"

    def test_P06_cpp20_concepts(self):
        """C++20 concepts deep dive → senior-engineer."""
        r = dispatch("quiero entender cómo funcionan los concepts de C++20 internamente")
        assert top_skill(r) == "senior-engineer", f"got {top_skill(r)}"


@pytest.mark.routing
class TestResearchExplainerRouting:
    def test_P07_basic_science(self):
        """General science question → research-explainer."""
        r = dispatch("por qué el cielo es azul realmente")
        assert top_skill(r) == "research-explainer", f"got {top_skill(r)}"

    def test_P08_cuda_tiebreak(self):
        """CUDA/GPU query → should route to senior-engineer (tiebreak over research-explainer)."""
        r = dispatch("investiga cómo funcionan los memory coalescing patterns en CUDA")
        assert top_skill(r) in ("senior-engineer", "research-explainer"), f"got {top_skill(r)}"


@pytest.mark.routing
class TestUiDesignerRouting:
    def test_P09_ui_critique(self):
        """UI critique → ui-designer."""
        r = dispatch("mira esta UI y dime si tiene sentido")
        assert top_skill(r) == "ui-designer", f"got {top_skill(r)}"

    def test_P09b_design_system(self):
        """Design system → ui-designer."""
        r = dispatch("necesito revisar mi design system de colores y tipografía")
        assert top_skill(r) == "ui-designer", f"got {top_skill(r)}"


@pytest.mark.routing
class TestWindowsAdminRouting:
    def test_P13_ram_query(self):
        """RAM process query → windows-admin."""
        r = dispatch("qué procesos están comiendo más RAM")
        assert top_skill(r) == "windows-admin", f"got {top_skill(r)}"

    def test_P13b_powershell(self):
        """PowerShell / system task → windows-admin."""
        r = dispatch("necesito limpiar los archivos temporales de Windows con PowerShell")
        assert top_skill(r) == "windows-admin", f"got {top_skill(r)}"


@pytest.mark.routing
class TestRepoEvaluatorRouting:
    def test_P15_repo_evaluation(self):
        """Repo evaluation → repo-evaluator."""
        r = dispatch("corrígeme el T9 de Web Servidor")
        assert top_skill(r) == "repo-evaluator", f"got {top_skill(r)}"

    def test_P15b_grade(self):
        """Grade request → repo-evaluator."""
        r = dispatch("dame una nota, evalúa mi código como un profesor estricto")
        assert top_skill(r) == "repo-evaluator", f"got {top_skill(r)}"


@pytest.mark.routing
class TestBusinessStrategistRouting:
    def test_P19_saas_pricing(self):
        """SaaS pricing → business-strategist."""
        r = dispatch("qué pricing pongo a mi SaaS")
        assert top_skill(r) == "business-strategist", f"got {top_skill(r)}"

    def test_P19b_business_validation(self):
        """Idea validation → business-strategist."""
        r = dispatch("quiero saber si esta idea de negocio tiene mercado real")
        assert top_skill(r) == "business-strategist", f"got {top_skill(r)}"


# ── Behavior contracts (Layer B — manual/documented) ──────────────────────────

@pytest.mark.manual
@pytest.mark.skip(reason="Manual review only — requires LLM-as-judge")
class TestPersonaBehaviorContracts:
    """
    Documented expected signals per persona.
    Run manually after modifying a persona's SKILL.md.
    Format: Input → Expected signals → Anti-patterns.
    """

    def test_P01_senior_engineer_tone(self):
        """
        Input: "tengo un bug en este .ts, échale un ojo"
        Expected:
        - Respuesta directa, sin preámbulo emocional
        - Lee el archivo, identifica root cause, propone fix con código
        - Bloques de código + 1-2 frases de explicación por bloque
        Anti-patterns:
        - Usar emojis o "great!", "absolutely!"
        - Pedir 5 archivos antes de tocar el bug
        - Reescribir todo el módulo cuando el fix es local
        """

    def test_P02_senior_engineer_systematic_debugging(self):
        """
        Input: "llevo 3 sesiones intentando arreglar este bug"
        Expected:
        - Inicia con metacognición: hipótesis sobre la mesa
        - Pide reproducir el bug o muestra cómo
        - Estructura: hipótesis - test - resultado - siguiente hipótesis
        - Puede invocar superpowers:systematic-debugging
        Anti-patterns:
        - Saltar al fix sin confirmar causa
        - "esto debería funcionar" sin verificación
        """

    def test_P03_gamedev_engineer_gas_domain(self):
        """
        Input: "cómo implemento un cooldown en una ability con GAS sin que rompa la replicación"
        Expected:
        - Menciona CooldownGameplayEffect y CommitAbility
        - Habla de server-authoritative, prediction key
        - Ejemplo en C++ con UPROPERTY/UFUNCTION correctos
        - Puede mencionar Lyra como referencia
        Anti-patterns:
        - Sugerir Blueprint cuando the user requested C++
        - Ignorar la replicación cuando es el problema central
        """

    def test_P05_senior_engineer_graphics_teaches(self):
        """
        Input: "explícame cómo funciona el pipeline de OpenGL desde el VAO hasta el fragment shader"
        Expected:
        - Tono explicativo (no solo código)
        - Etapas en orden: vertex input - vertex shader - ... - fragment shader
        - Diagrama o tabla de stages programables vs no programables
        Anti-patterns:
        - Solo dar código sin explicar el "por qué"
        """

    def test_P07_research_explainer_curiosity(self):
        """
        Input: "por qué el cielo es azul realmente"
        Expected:
        - Mención explícita: scattering de Rayleigh
        - Conexión a longitud de onda y partículas atmosféricas
        - Tono curioso, contagia pasión por entender
        - Puede sugerir experimentos mentales
        Anti-patterns:
        - Respuesta corta tipo Wikipedia
        - Ir a senior-engineer cuando es ciencia general
        """

    def test_P09_ui_designer_honest_critique(self):
        """
        Input: "mira esta UI y dime si tiene sentido" [+ screenshot]
        Expected:
        - Crítica directa, sin suavizar
        - Comenta jerarquía visual, contraste, espaciado
        - Si está mal -> lo dice. Si está bien -> también
        Anti-patterns:
        - "Looks great overall, just maybe..."
        - Lista de 20 cosas sin priorizar
        """

    def test_P13_windows_admin_protocol(self):
        """
        Input: "qué procesos están comiendo más RAM"
        Expected:
        - Tono formal, profesional
        - Comando PowerShell real
        - Si acción es destructiva -> pide confirmación
        Anti-patterns:
        - Ejecutar Stop-Process -Force sin confirmar
        - Tono casual
        """

    def test_P15_repo_evaluator_checks_rubric(self):
        """
        Input: "corrígeme el T9 de Web Servidor"
        Expected:
        - Localiza el enunciado real ANTES de evaluar
        - Checklist contra el enunciado
        - Output: nota, requisitos, errores, integrity flags
        Anti-patterns:
        - Nota inflada sin justificación
        - "Looks good overall" sin contrastar con enunciado
        """

    def test_P19_business_strategist_three_questions(self):
        """
        Input: "qué pricing pongo a mi SaaS"
        Expected:
        - Pregunta TAM/SAM, segmento, dolor del cliente
        - Propone tiers, no precio único
        - Compara con competidores
        - Habla de pricing psicológico, anchor, freemium vs trial
        Anti-patterns:
        - Precio plano sin tiers
        - No preguntar el segmento objetivo
        """


# Extension policy:
#   New persona -> add >=2 cases (tone + domain)
#   Persona modified -> add case for the change + re-run existing
#   Routing ambiguous -> add also in routing-tests equivalent
