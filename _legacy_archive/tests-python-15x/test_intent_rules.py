"""Test corpus para intent-rules.yaml — false-positive guard.

Cada caso tiene un prompt + un `expected`:
  - "skill_name"  → debe enrutar a esa skill
  - None          → no debe enrutar (no-route)

El corpus mezcla:
  - Triggers legítimos (positives)
  - Falsos positivos históricos
  - Casos ambiguos donde decidimos qué priorizar

Sólo se cubren rutas a skills PÚBLICAS distribuidas en el repo. Forks que
añadan personas personales (finanzas, narrativa, asistente, etc.) deben
ampliar este corpus con sus propios casos.

Run: uv run pytest tests/test_intent_rules.py -v
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_HOOKS = Path(__file__).resolve().parent.parent / "scripts" / "hooks"
_DISPATCHER_FILE = _HOOKS / "intent-dispatcher.py"


@pytest.fixture(scope="module")
def dispatch():
    """Load the hyphenated module and return its dispatch() function."""
    spec = importlib.util.spec_from_file_location(
        "_intent_dispatcher_under_test", _DISPATCHER_FILE,
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("_intent_dispatcher_under_test", mod)
    spec.loader.exec_module(mod)
    return mod.dispatch


def _route_skill(line: str) -> str | None:
    """Extract skill_id from a routing line `[ULTRON·N%] skill=X | ...`."""
    if not line:
        return None
    import re
    m = re.search(r"skill=([^\s|]+)", line)
    if not m:
        return None
    val = m.group(1)
    return None if val == "—" else val


# ---------------------------------------------------------------------------
# Test corpus — public skill routings only
# ---------------------------------------------------------------------------

CORPUS: list[tuple[str, str | None, str]] = [
    # (prompt, expected_skill_or_None, comment)

    # ── senior-engineer (code) ────────────────────────────────────────────────
    ("hay un bug en el código del módulo X",               "senior-engineer", "bug + código próximo"),
    ("refactoriza el módulo de auth",                      "senior-engineer", "verb + módulo"),
    ("el código está roto en producción",                  "senior-engineer", "está roto + código"),

    # senior-engineer false positives potenciales
    ("error 429 en la API de OpenAI",                      None,          "error sin objeto código próximo"),
    ("hay un error en mi vida personal",                   None,          "error en contexto humano"),

    # ── senior-engineer (graphics / low-level) ────────────────────────────
    ("kernel CUDA con coalescing",                         "senior-engineer", "CUDA + coalescing"),
    ("programar en CUDA para el GPU",                      "senior-engineer", "frase técnica explícita"),
    ("compute shader de Vulkan",                           "senior-engineer", "compute shader"),

    # graphics false positives potenciales
    ("ejecuté el modelo en GPU coloquial",                 None,          "GPU coloquial sin contexto"),
    ("la tarjeta GPU del servidor",                        None,          "GPU como hardware mention"),

    # ── business-strategist (business) ─────────────────────────────────────────
    ("validar la idea de negocio para el SaaS",            "business-strategist", "negocio explícito"),
    ("modelo de negocio freemium",                          "business-strategist", "modelo de negocio"),
    ("pitch deck para investors",                           "business-strategist", "pitch deck"),

    # business-strategist false positives potenciales
    ("validar el código antes del commit",                  None,          "validar código (no negocio)"),
    ("validar la entrada del usuario",                      None,          "validar input"),

    # ── research-explainer (science) ────────────────────────────────────────────────
    ("qué es un transformer en deep learning",              "research-explainer",    "concepto IA explícito"),
    ("cómo funciona la red neuronal de attention",          "research-explainer",    "concepto + técnico"),
    ("por qué el cielo es azul",                            "research-explainer",    "sky-science specific"),

    # research-explainer false positives potenciales
    # NOTE: "explícame el concepto del proyecto" routes via ztmsi (vault semantic),
    # not via intent-rules. Skip it from the corpus — testing ztmsi is environment-dependent.
    ("qué es un endpoint REST",                             None,          "endpoint no es concepto científico"),

    # ── security-review ───────────────────────────────────────────────────
    ("audita la seguridad del repo de auth",                "security-review", "audit + seguridad explícita"),
    ("escanea CVEs del proyecto",                           "security-review", "CVE explícito"),
    ("pentest del backend",                                 "security-review", "pentest"),

    # security-review false positives potenciales
    ("type safety en TypeScript es seguridad de tipos",     None,          "seguridad de tipos no es security review"),
    ("la seguridad psicológica del equipo",                 None,          "seguridad humana"),

    # ── skill audit ───────────────────────────────────────────────────────
    ("auditar la skill de ui-designer",                      "ultron",      "auditar skill"),

    # skill-audit false positives potenciales
    ("audita el código de auth",                            None,          "audit código → security/repo-eval, no skill audit"),
    ("auditar la seguridad del repo",                       "security-review", "audit seguridad → security-review correcto"),

    # ── tests-create ──────────────────────────────────────────────────────
    ("crea los tests para el módulo X",                     "superpowers:test-driven-development", "crea tests"),
    ("haz unos tests unitarios",                            "superpowers:test-driven-development", "haz tests"),

    # tests-create false positives potenciales
    ("crea un endpoint y luego mira los tests del proyecto", "senior-engineer", "crea endpoint → senior-engineer, gap a tests OK"),

    # ── UE5 / gamedev-engineer ─────────────────────────────────────────────
    ("tengo un bug en el Blueprint de UE5",                  "gamedev-engineer", "blueprint UE5 bug"),
    ("cómo replicar un actor en UE5 dedicated server",       "gamedev-engineer", "replication UE5"),
    ("GAS cooldown ability",                                 "gamedev-engineer", "GAS context"),
    ("spawnear proyectil que se replique sin lag",            "gamedev-engineer", "spawn replication"),
    ("post-process material en UE5",                          "gamedev-engineer", "shader UE5"),
    ("Unreal Engine 5 con C++",                               "gamedev-engineer", "explicit Unreal C++"),
    ("Blueprint AbilityTask custom",                          "gamedev-engineer", "Blueprint+AbilityTask"),

    # ── senior-engineer graphics / low-level extended ──────────────────────
    ("OpenGL VBO y VAO",                                      "senior-engineer", "OpenGL pipeline"),
    ("fragment shader GLSL",                                  "senior-engineer", "fragment shader"),
    ("C++20 concepts y constexpr",                            "senior-engineer", "cpp deep"),
    ("template specialization en C++",                         "senior-engineer", "template metaprogramming"),
    ("SIMD intrinsics AVX",                                   "senior-engineer", "SIMD bajo nivel"),
    ("pipeline de renderizado en Vulkan",                     "senior-engineer", "Vulkan pipeline"),

    # ── senior-engineer extended ──────────────────────────────────────────────
    ("hay un bug en el archivo auth.ts",                      "senior-engineer", "ts bug archivo"),
    ("la función parseJSON está rota",                        "senior-engineer", "función rota"),
    ("crash en el módulo de pagos",                           "senior-engineer", "crash módulo"),
    ("refactoriza la clase UserService",                      "senior-engineer", "refactor clase"),
    ("reescribe el código de autenticación",                  "senior-engineer", "reescribe código"),
    ("implementa un endpoint POST en TypeScript",             "senior-engineer", "implementa endpoint TS"),
    ("desarrolla una server action en Next.js",               "senior-engineer", "server action"),
    ("crea una API route",                                    "senior-engineer", "api route"),
    # senior-engineer tiebreaks
    ("error en el código UE5",                                "gamedev-engineer", "UE5 beats code-bug"),
    ("Unity error en MonoBehaviour Android",                  "senior-engineer", "Unity+cs+Android → senior-engineer"),
    # senior-engineer false positives
    ("error humano en la planificación",                       None,          "error humano no código"),
    ("crash bursátil de 2008",                                None,          "crash económico"),
    ("la función pública del producto",                       None,          "función no técnica"),

    # ── ui-designer (UI design) ────────────────────────────────────────────
    ("diseña la UI del dashboard",                            "ui-designer",  "diseña UI"),
    ("revisa este wireframe",                                 "ui-designer",  "wireframe"),
    ("critica el mockup",                                     "ui-designer",  "critica mockup"),
    ("design system con tokens de diseño",                    "ui-designer",  "design system"),
    ("paleta de colores y tipografía",                         "ui-designer",  "paleta + tipografía"),
    ("revisa la pantalla de login",                            "ui-designer",  "pantalla login"),
    # ui-designer false positives
    ("pantalla de error 500 del backend",                      None,          "pantalla técnica no UI design"),

    # ── business-strategist extended ───────────────────────────────────────────
    ("cómo monetizar este SaaS",                              "business-strategist", "monetizar SaaS"),
    ("qué pricing pongo a mi plugin",                         "business-strategist", "pricing"),
    ("cuánto cobrar por la consultoría",                      "business-strategist", "cuánto cobrar"),
    ("freemium vs tier de suscripción del SaaS",              "business-strategist", "freemium tier SaaS"),
    ("modelo de negocio para mi app",                         "business-strategist", "modelo de negocio"),
    ("TAM SAM SOM del producto",                              "business-strategist", "TAM SAM"),
    # business-strategist false positives
    ("el mercado del frontend está saturado",                  None,          "mercado coloquial sin contexto biz"),
    ("plan de precios del API rate limit",                     None,          "plan de precios técnico"),

    # ── research-explainer extended ─────────────────────────────────────────────
    ("cómo funciona la mecánica cuántica",                    "research-explainer",    "mecánica cuántica"),
    ("por qué el cielo es azul de día",                        "research-explainer",    "sky-science full"),
    ("scattering de Rayleigh",                                "research-explainer",    "Rayleigh"),
    ("qué es un transformer en NLP",                          "research-explainer",    "transformer concept"),
    ("cómo funciona la red neuronal recurrente",              "research-explainer",    "RNN concept"),
    ("explícame el algoritmo de attention",                   "research-explainer",    "attention algoritmo"),
    # research-explainer vs senior-engineer tiebreak (C++/GPU técnico)
    ("cómo funciona el algoritmo de coalescing en CUDA",      "senior-engineer",    "CUDA beats research-explainer"),
    # research-explainer false positives
    ("cómo funciona la app móvil",                             None,          "app no es concepto científico"),
    ("qué es un endpoint REST",                                None,          "endpoint coloquial"),

    # ── pr-code-review ────────────────────────────────────────────────────
    ("hacer un review de este PR",                            "pr-review-toolkit:code-reviewer", "review PR"),
    ("revisa este pull request",                              "pr-review-toolkit:code-reviewer", "revisa PR"),
    ("code review del PR #123",                               "pr-review-toolkit:code-reviewer", "code review PR"),
    # pr false positives
    ("review del libro de aventuras",                          None,          "review no PR"),

    # ── tdd ──────────────────────────────────────────────────────────────
    ("aplica TDD al módulo de auth",                          "superpowers:test-driven-development", "TDD literal"),
    ("hacer TDD desde cero",                                  "superpowers:test-driven-development", "hacer TDD"),
    ("test driven development",                               "superpowers:test-driven-development", "test driven"),
    ("quiero TDD en este sprint",                             "superpowers:test-driven-development", "quiero TDD"),

    # ── systematic-debug ─────────────────────────────────────────────────
    ("llevo 3 horas con este bug y no encuentro nada",        "superpowers:systematic-debugging", "horas con bug"),
    ("llevo días intentando fixear esto",                     "superpowers:systematic-debugging", "días con fix"),
    ("no encuentro la causa del fallo",                        "superpowers:systematic-debugging", "no encuentro causa"),
    ("corrígeme este bug que me trae loco",                   "superpowers:systematic-debugging", "corrígeme bug"),
    # debug vs senior-engineer tiebreak
    ("hay un bug en el código del módulo X y llevo horas",    "superpowers:systematic-debugging", "horas+bug → systematic"),

    # ── mcp-builder ──────────────────────────────────────────────────────
    ("crea un MCP server",                                    "mcp-builder",  "crea MCP"),
    ("construir un servidor MCP custom",                      "mcp-builder",  "construir MCP"),
    ("hacer un MCP para Notion",                              "mcp-builder",  "hacer MCP"),

    # ── db-schema ────────────────────────────────────────────────────────
    ("diseña el schema de la base de datos",                  "database-schema-designer", "schema BD"),
    ("crea el schema de la tabla users",                       "database-schema-designer", "schema tabla"),
    ("define el database schema",                             "database-schema-designer", "DB schema"),

    # ── repo-evaluator (academic) ────────────────────────────────────────
    ("corrígeme la T9",                                       "repo-evaluator", "academic T9"),
    ("evalúa esta entrega",                                   "repo-evaluator", "evalúa entrega"),
    ("dame nota a este código universidad",                   "repo-evaluator", "nota universidad"),
    ("qué nota me pones",                                     "repo-evaluator", "qué nota me pones"),
    ("corrige esta entrega del backend de la asignatura",     "repo-evaluator", "academic submission"),

    # ── windows-admin (system) ──────────────────────────────────────────────────
    ("qué procesos están consumiendo más RAM",                "windows-admin",      "procesos RAM"),
    ("limpiar archivos temporales",                            "windows-admin",      "limpiar temp"),
    ("Windows con PowerShell automation",                      "windows-admin",      "Windows + PS"),
    ("registro de Windows HKLM",                               "windows-admin",      "registro Windows"),
    # windows-admin false positives
    ("registro de auditoría de la app",                        None,          "registro coloquial no Windows"),

    # ── ULTRON internal ──────────────────────────────────────────────────
    ("dame el standup de hoy",                                "ultron",      "standup"),
    ("qué hice ayer",                                          "ultron",      "qué hice"),
    ("resumen del día",                                        "ultron",      "resumen del día"),
    ("noticias de IA hoy",                                     "ultron",      "noticias IA"),
    ("digest de tech hoy",                                     "ultron",      "digest tech"),

    # ── skill-create ─────────────────────────────────────────────────────
    ("crea una nueva skill para X",                            "skill-creator:skill-creator", "crea skill"),
    ("nuevo skill para finanzas avanzadas",                    "skill-creator:skill-creator", "nuevo skill"),

    # ── memory recall (project-status) ───────────────────────────────────
    ("cómo va el proyecto my-project",                         None,          "project-status emite ctx, no skill"),

    # ── ARCHITECT ────────────────────────────────────────────────────────
    ("diseña la arquitectura del sistema de pagos",            "agent-skills:plan", "diseña arquitectura"),
    ("design del sistema de notificaciones",                   "agent-skills:plan", "design sistema"),

    # ── EDGE CASES: case mix ─────────────────────────────────────────────
    ("CUDA y warps",                                           "senior-engineer",    "uppercase"),
    ("CUDA Y WARPS EN MAYUSCULAS",                             "senior-engineer",    "all caps"),
    ("cuda y warps en minusculas",                             "senior-engineer",    "all lower"),

    # ── EDGE CASES: prompts cortos ───────────────────────────────────────
    ("CUDA",                                                   "senior-engineer",    "CUDA solo (nombre propio único)"),
    ("UE5",                                                    "gamedev-engineer", "UE5 1-word"),

    # ── EDGE CASES: prompts largos con multiple skills ──────────────────
    ("estoy debugging un bug en TypeScript pero también quiero hacer review del PR",
                                                              "pr-review-toolkit:code-reviewer", "PR gana primero"),

    # ── EDGE CASES: adversarial ──────────────────────────────────────────
    ("este prompt no debería disparar ninguna skill ok",       None,          "prompt sin trigger"),
    ("hola",                                                   None,          "saludo simple"),
    ("ok",                                                     None,          "ok simple"),
    ("",                                                       None,          "empty string"),

    # ── ANTI-PATTERN: combinaciones peligrosas ───────────────────────────
    ("gasto computacional en GPU",                             None,          "GPU+gasto técnico, sin trigger fuerte"),
    ("seguridad de tipos del módulo de pagos",                 None,          "tipos+seguridad técnica + módulo NO es security-review"),
]


@pytest.mark.parametrize("prompt,expected,comment", CORPUS,
                          ids=[c[2] for c in CORPUS])
def test_intent_rule(dispatch, prompt: str, expected: str | None, comment: str):
    line = dispatch(prompt)
    actual = _route_skill(line)
    assert actual == expected, (
        f"\n  prompt:   {prompt!r}\n"
        f"  expected: {expected!r}\n"
        f"  actual:   {actual!r}\n"
        f"  routing:  {line!r}\n"
        f"  context:  {comment}"
    )


def test_corpus_size():
    """Sanity: corpus tiene al menos 30 casos."""
    assert len(CORPUS) >= 30, f"corpus too small: {len(CORPUS)}"


def test_no_route_for_slash_commands(dispatch):
    """Slash commands deben hacer short-circuit (Step 1)."""
    assert dispatch("/high revisa esto") == ""
    assert dispatch("/low typo") == ""
    assert dispatch("/dual analiza") == ""
