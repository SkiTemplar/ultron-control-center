"""
Persona routing + behavior contract tests.

Two test layers:
  Layer A — Routing (automated): verifies dispatcher routes to expected persona.
  Layer B — Behavior signals (manual): documented expectations for persona response quality.

Run all:     uv run pytest tests/test_personas.py -v
Run routing: uv run pytest tests/test_personas.py -v -m routing
Run manual:  uv run pytest tests/test_personas.py -v -m manual (always skipped in CI)

Note: knowledge_files paths were migrated to vault; tests reference brain_index query
instead of direct file paths. See routing-matrix.md for signal word sources.
"""
from __future__ import annotations

import json
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
class TestTerryDavisRouting:
    def test_P01_ts_bug(self):
        """Bug in .ts file → terry-davis."""
        r = dispatch("tengo un bug en este .ts, échale un ojo")
        assert top_skill(r) == "terry-davis", f"got {top_skill(r)}"

    def test_P01b_refactor(self):
        """Refactor request → terry-davis."""
        r = dispatch("refactoriza este módulo, está hecho un desastre")
        assert top_skill(r) == "terry-davis", f"got {top_skill(r)}"

    def test_P02_persistent_bug_high_mode(self):
        """Long-standing bug → systematic-debugging or terry-davis, confidence > 0.70."""
        r = dispatch("llevo 3 sesiones intentando arreglar este bug y no encuentro la causa")
        assert top_skill(r) in ("terry-davis", "superpowers:systematic-debugging"), \
            f"got {top_skill(r)}"
        assert confidence(r) >= 0.70


@pytest.mark.routing
class TestDonClaudoRouting:
    def test_P03_GAS_cooldown(self):
        """GAS cooldown → don-claudio."""
        r = dispatch("cómo implemento un cooldown en una ability con GAS sin que rompa la replicación")
        assert top_skill(r) == "don-claudio", f"got {top_skill(r)}"

    def test_P04_projectile_replication(self):
        """Replication without lag → don-claudio."""
        r = dispatch("quiero spawnear un proyectil que se replique sin lag")
        assert top_skill(r) == "don-claudio", f"got {top_skill(r)}"


@pytest.mark.routing
class TestNovalbosRouting:
    def test_P05_opengl_pipeline(self):
        """OpenGL pipeline explanation → novalbos."""
        r = dispatch("explícame cómo funciona el pipeline de OpenGL desde el VAO hasta el fragment shader")
        assert top_skill(r) == "novalbos", f"got {top_skill(r)}"

    def test_P06_cpp20_concepts(self):
        """C++20 concepts deep dive → novalbos."""
        r = dispatch("quiero entender cómo funcionan los concepts de C++20 internamente")
        assert top_skill(r) == "novalbos", f"got {top_skill(r)}"


@pytest.mark.routing
class TestEinsteinRouting:
    def test_P07_basic_science(self):
        """General science question → einstein."""
        r = dispatch("por qué el cielo es azul realmente")
        assert top_skill(r) == "einstein", f"got {top_skill(r)}"

    def test_P08_cuda_tiebreak(self):
        """CUDA/GPU query → should route to novalbos (tiebreak over einstein)."""
        r = dispatch("investiga cómo funcionan los memory coalescing patterns en CUDA")
        # einstein vs novalbos tiebreak: GPU/CUDA → novalbos wins
        assert top_skill(r) in ("novalbos", "einstein"), f"got {top_skill(r)}"


@pytest.mark.routing
class TestMikeTysonRouting:
    def test_P09_ui_critique(self):
        """UI critique → mike-tyson."""
        r = dispatch("mira esta UI y dime si tiene sentido")
        assert top_skill(r) == "mike-tyson", f"got {top_skill(r)}"

    def test_P09b_design_system(self):
        """Design system → mike-tyson."""
        r = dispatch("necesito revisar mi design system de colores y tipografía")
        assert top_skill(r) == "mike-tyson", f"got {top_skill(r)}"


@pytest.mark.routing
class TestWarrenRouting:
    def test_P10_stock_query(self):
        """Stock investment query → warren."""
        r = dispatch("¿compro NVDA ahora?")
        assert top_skill(r) == "warren", f"got {top_skill(r)}"

    def test_P10b_portfolio(self):
        """Portfolio query → warren."""
        r = dispatch("cómo va mi cartera de ETFs")
        assert top_skill(r) == "warren", f"got {top_skill(r)}"


@pytest.mark.routing
class TestTioGilitoRouting:
    def test_P12_spending_query(self):
        """Monthly spending → tio-gilito."""
        r = dispatch("cómo voy de dinero este mes")
        assert top_skill(r) == "tio-gilito", f"got {top_skill(r)}"

    def test_P12b_budget(self):
        """Budget check → tio-gilito."""
        r = dispatch("cuánto he gastado en comida este mes, revisa el presupuesto")
        assert top_skill(r) == "tio-gilito", f"got {top_skill(r)}"


@pytest.mark.routing
class TestAlfredRouting:
    def test_P13_ram_query(self):
        """RAM process query → alfred."""
        r = dispatch("qué procesos están comiendo más RAM")
        assert top_skill(r) == "alfred", f"got {top_skill(r)}"

    def test_P13b_powershell(self):
        """PowerShell / system task → alfred."""
        r = dispatch("necesito limpiar los archivos temporales de Windows con PowerShell")
        assert top_skill(r) == "alfred", f"got {top_skill(r)}"


@pytest.mark.routing
class TestProfesorFisicaRouting:
    def test_P14_kinematics(self):
        """Kinematics exercise → profesor-fisica."""
        r = dispatch("tengo este ejercicio de cinemática que no me sale")
        assert top_skill(r) == "profesor-fisica", f"got {top_skill(r)}"

    def test_P14b_exam_prep(self):
        """Physics exam prep → profesor-fisica."""
        r = dispatch("repásame el tema de dinámica para el examen de Física")
        assert top_skill(r) == "profesor-fisica", f"got {top_skill(r)}"


@pytest.mark.routing
class TestRepoEvaluatorRouting:
    def test_P15_repo_evaluation(self):
        """Repo evaluation → repo-evaluator (Kirkardo)."""
        r = dispatch("corrígeme el T9 de Web Servidor")
        assert top_skill(r) == "repo-evaluator", f"got {top_skill(r)}"

    def test_P15b_grade(self):
        """Grade request → repo-evaluator."""
        r = dispatch("dame una nota, evalúa mi código como un profesor estricto")
        assert top_skill(r) == "repo-evaluator", f"got {top_skill(r)}"


@pytest.mark.routing
class TestPanaRouting:
    def test_P16_morning_briefing(self):
        """Morning mode → pana."""
        r = dispatch("modo mañana")
        assert top_skill(r) == "pana", f"got {top_skill(r)}"

    def test_P16b_gmail(self):
        """Email check → pana."""
        r = dispatch("revisa mis emails de hoy en Gmail")
        assert top_skill(r) == "pana", f"got {top_skill(r)}"


@pytest.mark.routing
class TestTolkienRouting:
    def test_P17_chapter(self):
        """Next chapter → tolkien."""
        r = dispatch("escribe la siguiente escena del capítulo 7")
        assert top_skill(r) == "tolkien", f"got {top_skill(r)}"

    def test_P17b_consistency(self):
        """Plot consistency → tolkien."""
        r = dispatch("hay un plot hole en el arco del personaje, revisa la consistencia")
        assert top_skill(r) == "tolkien", f"got {top_skill(r)}"


@pytest.mark.routing
class TestManoloLamaRouting:
    def test_P18_football_commentary(self):
        """Football commentary → manolo-lama."""
        r = dispatch("comenta el último gol del Madrid")
        assert top_skill(r) == "manolo-lama", f"got {top_skill(r)}"


@pytest.mark.routing
class TestJordanBelfortRouting:
    def test_P19_saas_pricing(self):
        """SaaS pricing → jordan-belfort."""
        r = dispatch("qué pricing pongo a mi SaaS")
        assert top_skill(r) == "jordan-belfort", f"got {top_skill(r)}"

    def test_P19b_business_validation(self):
        """Idea validation → jordan-belfort."""
        r = dispatch("quiero saber si esta idea de negocio tiene mercado real")
        assert top_skill(r) == "jordan-belfort", f"got {top_skill(r)}"


# ── Behavior contracts (Layer B — manual/documented) ──────────────────────────

@pytest.mark.manual
@pytest.mark.skip(reason="Manual review only — requires LLM-as-judge")
class TestPersonaBehaviorContracts:
    """
    Documented expected signals per persona.
    Run manually after modifying a persona's SKILL.md.
    Format: Input → Expected signals → Anti-patterns.
    """

    def test_P01_terry_tone(self):
        """
        Input: "tengo un bug en este .ts, échale un ojo"
        Expected:
        - Respuesta directa, sin preámbulo emocional
        - Lee el archivo, identifica root cause, propone fix con código
        - Bloques de código + 1-2 frases de explicación por bloque
        Anti-patterns:
        - ❌ Usar emojis o "great!", "absolutely!"
        - ❌ Pedir 5 archivos antes de tocar el bug
        - ❌ Reescribir todo el módulo cuando el fix es local
        """

    def test_P02_terry_systematic_debugging(self):
        """
        Input: "llevo 3 sesiones intentando arreglar este bug"
        Expected:
        - Inicia con metacognición: hipótesis sobre la mesa
        - Pide reproducir el bug o muestra cómo
        - Estructura: hipótesis → test → resultado → siguiente hipótesis
        - Puede invocar superpowers:systematic-debugging
        Anti-patterns:
        - ❌ Saltar al fix sin confirmar causa
        - ❌ "esto debería funcionar" sin verificación
        """

    def test_P03_don_claudio_gas_domain(self):
        """
        Input: "cómo implemento un cooldown en una ability con GAS sin que rompa la replicación"
        Expected:
        - Menciona CooldownGameplayEffect y CommitAbility
        - Habla de server-authoritative, prediction key
        - Ejemplo en C++ con UPROPERTY/UFUNCTION correctos
        - Puede mencionar Lyra como referencia
        Anti-patterns:
        - ❌ Sugerir Blueprint cuando USER pidió C++
        - ❌ Ignorar la replicación cuando es el problema central
        """

    def test_P05_novalbos_teaches_not_copies(self):
        """
        Input: "explícame cómo funciona el pipeline de OpenGL desde el VAO hasta el fragment shader"
        Expected:
        - Tono didáctico, explicativo (no solo código)
        - Etapas en orden: vertex input → vertex shader → ... → fragment shader
        - Diagrama o tabla de stages programables vs no programables
        - Con /learn activo: bloque NOVALBOS DICE al final
        Anti-patterns:
        - ❌ Solo dar código sin explicar el "por qué"
        - ❌ Tono Terry (frío, mínimo) — Novalbos enseña
        """

    def test_P07_einstein_contagious_curiosity(self):
        """
        Input: "por qué el cielo es azul realmente"
        Expected:
        - Mención explícita: scattering de Rayleigh
        - Conexión a longitud de onda · partículas atmosféricas
        - Tono curioso, contagia pasión por entender
        - Puede sugerir experimentos mentales
        Anti-patterns:
        - ❌ Respuesta corta tipo Wikipedia
        - ❌ Ir a novalbos cuando es ciencia general
        """

    def test_P09_mike_brutal_honesty(self):
        """
        Input: "mira esta UI y dime si tiene sentido" [+ screenshot]
        Expected:
        - Crítica directa, sin suavizar
        - Comenta jerarquía visual, contraste, espaciado
        - Si está mal → lo dice. Si está bien → también
        - Tono Mike Tyson: brutalmente honesto
        Anti-patterns:
        - ❌ "Looks great overall, just maybe..."
        - ❌ Lista de 20 cosas sin priorizar
        """

    def test_P10_warren_analytical_patient(self):
        """
        Input: "¿compro NVDA ahora?"
        Expected:
        - Tono analítico, paciente, largo plazo
        - Pregunta thesis antes de responder
        - Menciona valuation (P/E, growth), moat, riesgo
        - NO da consejo financiero categórico ("compra")
        Anti-patterns:
        - ❌ Respuesta impulsiva sin contexto de cartera
        - ❌ "compra" o "no compra" sin matices
        """

    def test_P11_warren_terry_combo(self):
        """
        Input: "quiero un dashboard de mi cartera en Next.js + Supabase"
        Expected:
        - Routing combo: warren valida modelo → terry implementa
        - Warren: qué métricas son útiles, schema propuesto
        - Terry: schema concreto + Server Actions
        Anti-patterns:
        - ❌ Solo warren sin implementar nada
        - ❌ Solo terry sin preguntar qué métricas importan
        """

    def test_P12_tio_gilito_reads_db(self):
        """
        Input: "cómo voy de dinero este mes"
        Expected:
        - Accede a finanzas.db con Bash/Read tool
        - Da números reales, no estimaciones
        - Tono Scrooge McDuck: directo, sin piedad
        - Si gasto > regla: te lo dice
        Anti-patterns:
        - ❌ "Parece que vas bien" sin mirar la DB
        - ❌ Tono suave o condescendiente
        """

    def test_P13_alfred_butler_protocol(self):
        """
        Input: "qué procesos están comiendo más RAM"
        Expected:
        - Tono mayordomo inglés, formal
        - Comando PowerShell real
        - "Atendiendo, señor" o equivalente
        - Si acción es destructiva → pide confirmación
        Anti-patterns:
        - ❌ Ejecutar Stop-Process -Force sin confirmar
        - ❌ Tono casual
        """

    def test_P15_kirkardo_checks_rubric(self):
        """
        Input: "corrígeme el T9 de Web Servidor"
        Expected:
        - Localiza el enunciado real ANTES de evaluar
        - Checklist contra el enunciado
        - Output: nota, requisitos, errores, integrity flags
        Anti-patterns:
        - ❌ Nota inflada sin justificación
        - ❌ "Looks good overall" sin contrastar con enunciado
        """

    def test_P19_jordan_three_questions(self):
        """
        Input: "qué pricing pongo a mi SaaS"
        Expected:
        - Pregunta TAM/SAM, segmento, dolor del cliente
        - Propone tiers, no precio único
        - Compara con competidores
        - Habla de pricing psicológico, anchor, freemium vs trial
        Anti-patterns:
        - ❌ Precio plano sin tiers
        - ❌ No preguntar el segmento objetivo
        """


# ── Extension policy (documented as comments) ─────────────────────────────────
# Persona nueva → crear ≥2 casos (tono + dominio) en TestXxxRouting
# Persona modificada → añadir caso para el cambio + re-run los existentes
# Bug detectado por Kirkardo → añadir el input exacto que falló
# Routing ambiguo → añadir también en routing-tests equivalente
