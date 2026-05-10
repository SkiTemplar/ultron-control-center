"""Test corpus para intent-rules.yaml — false-positive guard.

Cada caso tiene un prompt + un `expected`:
  - "skill_name"  → debe enrutar a esa skill
  - None          → no debe enrutar (no-route)

El corpus mezcla:
  - Triggers legítimos (positives)
  - Falsos positivos históricos del Sprint intent-rules-precision (2026-05-09)
  - Casos ambiguos donde decidimos qué priorizar

Estructura: bloques por skill destino, cada bloque alterna positivos/negativos.
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
# Test corpus
# ---------------------------------------------------------------------------

CORPUS: list[tuple[str, str | None, str]] = [
    # (prompt, expected_skill_or_None, comment)

    # ── tio-gilito (financial) ────────────────────────────────────────────
    ("Tío Gilito, mis finanzas",                          "tio-gilito",  "explicit name"),
    ("Gilito, cuánto he gastado",                         "tio-gilito",  "explicit short name"),
    ("cuánto he gastado este mes",                         "tio-gilito",  "verb 1ª persona pasada"),
    ("añade un gasto de 50 euros en restaurante",          "tio-gilito",  "comando explícito"),
    ("presupuesto mensual de KutxaBank",                   "tio-gilito",  "nombre propio + multi-keyword"),
    ("cómo va mi saldo",                                   "tio-gilito",  "saldo coloquial"),
    ("cómo voy de dinero este mes",                        "tio-gilito",  "frase completa"),

    # tio-gilito false positives históricos (must NOT match)
    ("para evitar gasto de tokens del modelo",             None,          "FP histórico — gasto técnico"),
    ("el gasto computacional del embedding es alto",       None,          "FP histórico — gasto computacional"),
    ("el presupuesto de la API key se acaba",              None,          "FP — presupuesto suelto"),
    ("el modelo gasta mucha memoria",                      None,          "verbo gastar técnico"),

    # ── terry-davis (code) ────────────────────────────────────────────────
    ("hay un bug en el código del módulo X",               "terry-davis", "bug + código próximo"),
    ("refactoriza el módulo de auth",                      "terry-davis", "verb + módulo"),
    ("el código está roto en producción",                  "terry-davis", "está roto + código"),

    # terry-davis false positives potenciales
    ("error 429 en la API de OpenAI",                      None,          "error sin objeto código próximo"),
    ("hay un error en mi vida personal",                   None,          "error en contexto humano"),

    # ── novalbos (low-level) ──────────────────────────────────────────────
    ("kernel CUDA con coalescing",                         "novalbos",    "CUDA + coalescing"),
    ("programar en CUDA para el GPU",                      "novalbos",    "frase técnica explícita"),
    ("compute shader de Vulkan",                           "novalbos",    "compute shader"),

    # novalbos false positives potenciales
    ("ejecuté el modelo en GPU coloquial",                 None,          "GPU coloquial sin contexto"),
    ("la tarjeta GPU del servidor",                        None,          "GPU como hardware mention"),

    # ── jordan-belfort (business) ─────────────────────────────────────────
    ("validar la idea de negocio para el SaaS",            "jordan-belfort", "negocio explícito"),
    ("modelo de negocio freemium",                          "jordan-belfort", "modelo de negocio"),
    ("pitch deck para investors",                           "jordan-belfort", "pitch deck"),

    # jordan-belfort false positives potenciales
    ("validar el código antes del commit",                  None,          "validar código (no negocio)"),
    ("validar la entrada del usuario",                      None,          "validar input"),
    ("mercado de valores hoy",                              "warren",      "mercado bursátil → warren correcto"),

    # ── einstein (science) ────────────────────────────────────────────────
    ("qué es un transformer en deep learning",              "einstein",    "concepto IA explícito"),
    ("cómo funciona la red neuronal de attention",          "einstein",    "concepto + técnico"),
    ("por qué el cielo es azul",                            "einstein",    "sky-science specific"),

    # einstein false positives potenciales
    ("explícame el concepto del proyecto",                  None,          "concepto suelto coloquial"),
    ("qué es un endpoint REST",                             None,          "endpoint no es concepto científico"),

    # ── manolo-lama (football) ────────────────────────────────────────────
    ("narra el partido del REDACTED_TEAM vs Barça",          "manolo-lama", "narra + partido"),
    ("gol del clásico",                                     "manolo-lama", "gol del clásico"),
    ("Champions League final",                              "manolo-lama", "Champions League completo"),

    # manolo-lama false positives potenciales
    ("La Liga de programación competitiva",                 None,          "Liga en contexto no-fútbol"),
    ("REDACTED_TEAM de las APIs (Spain region)",              None,          "Madrid mention sin contexto"),
    ("la liga de los lenguajes de programación",            None,          "liga genérica"),

    # ── tolkien (narrative) ───────────────────────────────────────────────
    ("escribe el capítulo del libro siguiente",             "tolkien",     "capítulo del libro"),
    ("plot hole en el arco de Aric",                        "tolkien",     "plot hole"),
    ("worldbuilding para el Imperio",                       "tolkien",     "worldbuilding"),

    # tolkien false positives potenciales
    ("capítulo de física: cinemática",                      None,          "capítulo académico"),
    ("capítulo 3 del manual técnico",                       None,          "capítulo técnico no narrativo"),

    # ── security-review ───────────────────────────────────────────────────
    ("audita la seguridad del repo de auth",                "security-review", "audit + seguridad explícita"),
    ("escanea CVEs del proyecto",                           "security-review", "CVE explícito"),
    ("pentest del backend",                                 "security-review", "pentest"),

    # security-review false positives potenciales
    ("type safety en TypeScript es seguridad de tipos",     None,          "seguridad de tipos no es security review"),
    ("la seguridad psicológica del equipo",                 None,          "seguridad humana"),

    # ── kirkardo-audit (skill audit) ──────────────────────────────────────
    ("Kirkardo, audita la skill de tio-gilito",             "ultron",      "Kirkardo + audita skill"),
    ("auditar la skill de mike-tyson",                      "ultron",      "auditar skill"),

    # kirkardo false positives potenciales
    ("audita el código de auth",                            None,          "audit código → security/repo-eval, no kirkardo"),
    ("auditar la seguridad del repo",                       "security-review", "audit seguridad → security-review correcto"),

    # ── tests-create ──────────────────────────────────────────────────────
    ("crea los tests para el módulo X",                     "superpowers:test-driven-development", "crea tests"),
    ("haz unos tests unitarios",                            "superpowers:test-driven-development", "haz tests"),

    # tests-create false positives potenciales
    ("crea un endpoint y luego mira los tests del proyecto", "terry-davis", "crea endpoint → terry, gap a tests OK"),

    # ── pana (personal assistant) ─────────────────────────────────────────
    ("buenos días, dame el briefing de hoy",                "pana",        "morning mode"),
    ("revisa mis emails de Gmail",                          "pana",        "Gmail explícito"),
    ("recordatorio en el calendario",                        "pana",        "calendar"),
    ("modo mañana",                                          "pana",        "trigger directo"),
    ("qué tengo hoy en la agenda",                           "pana",        "qué tengo hoy"),
    ("añade un evento en Google Calendar",                   "pana",        "calendar event"),
    ("revisa la bandeja de entrada",                         "pana",        "bandeja de entrada"),

    # ── EXPANSION 2026-05-09: cobertura completa ──────────────────────────

    # ── UE5 / don-claudio extended ────────────────────────────────────────
    ("tengo un bug en el Blueprint de UE5",                  "don-claudio", "blueprint UE5 bug"),
    ("cómo replicar un actor en UE5 dedicated server",       "don-claudio", "replication UE5"),
    ("GAS cooldown ability",                                 "don-claudio", "GAS context"),
    ("spawnear proyectil que se replique sin lag",            "don-claudio", "spawn replication"),
    ("post-process material en UE5",                          "don-claudio", "shader UE5"),
    ("Unreal Engine 5 con C++",                               "don-claudio", "explicit Unreal C++"),
    ("Blueprint AbilityTask custom",                          "don-claudio", "Blueprint+AbilityTask"),
    # UE5 false positives potenciales
    ("blueprint para diseñar la base de datos",               "don-claudio", "blueprint suelto matchea UE5 (acepted ambiguity)"),

    # ── novalbos / GPU / low-level ────────────────────────────────────────
    ("OpenGL VBO y VAO",                                      "novalbos",    "OpenGL pipeline"),
    ("fragment shader GLSL",                                  "novalbos",    "fragment shader"),
    ("C++20 concepts y constexpr",                            "novalbos",    "cpp deep"),
    ("template specialization en C++",                         "novalbos",    "template metaprogramming"),
    ("SIMD intrinsics AVX",                                   "novalbos",    "SIMD bajo nivel"),
    ("pipeline de renderizado en Vulkan",                     "novalbos",    "Vulkan pipeline"),
    # novalbos false positives
    ("DirectX 12 desde Unity",                                "novalbos",    "DirectX → novalbos OK"),

    # ── terry-davis extended ──────────────────────────────────────────────
    ("hay un bug en el archivo auth.ts",                      "terry-davis", "ts bug archivo"),
    ("la función parseJSON está rota",                        "terry-davis", "función rota"),
    ("crash en el módulo de pagos",                           "terry-davis", "crash módulo"),
    ("refactoriza la clase UserService",                      "terry-davis", "refactor clase"),
    ("reescribe el código de autenticación",                  "terry-davis", "reescribe código"),
    ("implementa un endpoint POST en TypeScript",             "terry-davis", "implementa endpoint TS"),
    ("desarrolla una server action en Next.js",               "terry-davis", "server action"),
    ("crea una API route",                                    "terry-davis", "api route"),
    # terry-davis tiebreaks
    ("error en el código UE5",                                "don-claudio", "UE5 beats code-bug"),
    ("Unity error en MonoBehaviour Android",                  "terry-davis", "Unity+cs+Android → terry"),
    # terry-davis false positives
    ("error humano en la planificación",                       None,          "error humano no código"),
    ("crash bursátil de 2008",                                None,          "crash económico"),
    ("la función pública del producto",                       None,          "función no técnica"),

    # ── mike-tyson (UI design) ────────────────────────────────────────────
    ("diseña la UI del dashboard",                            "mike-tyson",  "diseña UI"),
    ("revisa este wireframe",                                 "mike-tyson",  "wireframe"),
    ("critica el mockup",                                     "mike-tyson",  "critica mockup"),
    ("design system con tokens de diseño",                    "mike-tyson",  "design system"),
    ("paleta de colores y tipografía",                         "mike-tyson",  "paleta + tipografía"),
    ("revisa la pantalla de login",                            "mike-tyson",  "pantalla login"),
    # mike-tyson false positives
    ("pantalla de error 500 del backend",                      None,          "pantalla técnica no UI design"),

    # ── jordan-belfort extended ───────────────────────────────────────────
    ("cómo monetizar este SaaS",                              "jordan-belfort", "monetizar SaaS"),
    ("qué pricing pongo a mi plugin",                         "jordan-belfort", "pricing"),
    ("cuánto cobrar por la consultoría",                      "jordan-belfort", "cuánto cobrar"),
    ("freemium vs tier de suscripción del SaaS",              "jordan-belfort", "freemium tier SaaS"),
    ("modelo de negocio para mi app",                         "jordan-belfort", "modelo de negocio"),
    ("TAM SAM SOM del producto",                              "jordan-belfort", "TAM SAM"),
    # jordan-belfort false positives
    ("el mercado del frontend está saturado",                  None,          "mercado coloquial sin contexto biz"),
    ("plan de precios del API rate limit",                     None,          "plan de precios técnico"),

    # ── einstein extended ─────────────────────────────────────────────────
    ("cómo funciona la mecánica cuántica",                    "einstein",    "mecánica cuántica"),
    ("por qué el cielo es azul de día",                        "einstein",    "sky-science full"),
    ("scattering de Rayleigh",                                "einstein",    "Rayleigh"),
    ("qué es un transformer en NLP",                          "einstein",    "transformer concept"),
    ("cómo funciona la red neuronal recurrente",              "einstein",    "RNN concept"),
    ("explícame el algoritmo de attention",                   "einstein",    "attention algoritmo"),
    # einstein vs novalbos tiebreak (C++/GPU técnico)
    ("cómo funciona el algoritmo de coalescing en CUDA",      "novalbos",    "CUDA beats einstein"),
    # einstein false positives
    ("cómo funciona la app móvil",                             None,          "app no es concepto científico"),
    ("qué es un endpoint REST",                                None,          "endpoint coloquial"),

    # ── pr-code-review ────────────────────────────────────────────────────
    ("hacer un review de este PR",                            "pr-review-toolkit:code-reviewer", "review PR"),
    ("revisa este pull request",                              "pr-review-toolkit:code-reviewer", "revisa PR"),
    ("code review del PR #123",                               "pr-review-toolkit:code-reviewer", "code review PR"),
    # pr false positives
    ("review del libro de Tolkien",                            None,          "review no PR"),

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
    # debug vs terry tiebreak
    ("hay un bug en el código del módulo X y llevo horas",    "superpowers:systematic-debugging", "horas+bug → systematic"),

    # ── mcp-builder ──────────────────────────────────────────────────────
    ("crea un MCP server",                                    "mcp-builder",  "crea MCP"),
    ("construir un servidor MCP custom",                      "mcp-builder",  "construir MCP"),
    ("hacer un MCP para Notion",                              "mcp-builder",  "hacer MCP"),

    # ── db-schema ────────────────────────────────────────────────────────
    ("diseña el schema de la base de datos",                  "database-schema-designer", "schema BD"),
    ("crea el schema de la tabla users",                       "database-schema-designer", "schema tabla"),
    ("define el database schema",                             "database-schema-designer", "DB schema"),

    # ── academic ─────────────────────────────────────────────────────────
    ("corrígeme la T9",                                       "repo-evaluator", "academic T9"),
    ("evalúa esta entrega",                                   "repo-evaluator", "evalúa entrega"),
    ("dame nota a este código universidad",                   "repo-evaluator", "nota universidad"),
    ("qué nota me pones",                                     "repo-evaluator", "qué nota me pones"),
    ("corrige esta entrega del backend de la asignatura",     "repo-evaluator", "academic submission"),

    # ── physics ──────────────────────────────────────────────────────────
    ("ejercicio de cinemática para el examen",                "profesor-fisica", "cinemática examen"),
    ("repasa el tema de termodinámica",                        "profesor-fisica", "termodinámica"),
    ("problema de física no me sale, dinámica",                "profesor-fisica", "problema física"),
    # physics tiebreaks
    ("simular colisiones físicas en Unity",                    "profesor-fisica", "física aún viene primero"),

    # ── alfred (system) ──────────────────────────────────────────────────
    ("qué procesos están consumiendo más RAM",                "alfred",      "procesos RAM"),
    ("limpiar archivos temporales",                            "alfred",      "limpiar temp"),
    ("Windows con PowerShell automation",                      "alfred",      "Windows + PS"),
    ("registro de Windows HKLM",                               "alfred",      "registro Windows"),
    # alfred false positives
    ("registro de auditoría de la app",                        None,          "registro coloquial no Windows"),

    # ── investments / warren ─────────────────────────────────────────────
    ("compro NVDA",                                            "warren",      "NVDA stock"),
    ("análisis fundamental de TSLA",                          "warren",      "análisis fundamental"),
    ("dividendos del SPY",                                    "warren",      "dividendos"),
    ("ETF para mi cartera",                                   "warren",      "ETF cartera"),
    ("cómo va la bolsa hoy",                                  "warren",      "bolsa"),
    ("P/E ratio de AAPL",                                     "warren",      "P/E ratio"),
    # warren false positives
    ("la cartera de productos de la empresa",                  None,          "cartera no financiera (corporativa)"),

    # ── kirkardo audit ────────────────────────────────────────────────────
    ("Kirkardo, audita las skills",                            "ultron",      "Kirkardo direct"),
    ("kirkardo evalúa mi skill",                               "ultron",      "kirkardo lower"),
    ("auditar la skill terry-davis",                           "ultron",      "auditar skill"),
    # kirkardo false positives
    ("auditar la calidad del producto",                        None,          "auditar coloquial"),

    # ── tolkien narrative ────────────────────────────────────────────────
    ("escribe la siguiente escena del libro",                  "tolkien",     "siguiente escena del libro"),
    ("plot hole en el arco de Aric",                          "tolkien",     "plot hole"),
    ("worldbuilding del Imperio de los Once Grandes",          "tolkien",     "worldbuilding once grandes"),
    # tolkien false positives
    ("escribe el siguiente paso del algoritmo",                None,          "escribe siguiente coloquial"),
    ("la consistencia del estado en React",                    None,          "consistencia técnica"),

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
    ("cómo va el proyecto OrbitalDB",                          None,          "project-status emite ctx, no skill"),

    # ── ARCHITECT ────────────────────────────────────────────────────────
    ("diseña la arquitectura del sistema de pagos",            "agent-skills:plan", "diseña arquitectura"),
    ("design del sistema de notificaciones",                   "agent-skills:plan", "design sistema"),

    # ── EDGE CASES: acentos perdidos ─────────────────────────────────────
    ("cuanto he gastado este mes",                             "tio-gilito",  "sin acentos"),
    ("como va mi saldo",                                       "tio-gilito",  "como sin acento"),
    ("Tio Gilito",                                             "tio-gilito",  "Tio sin tilde"),
    ("escribe la siguiente escena del libro",                  "tolkien",     "siguiente escena dup"),

    # ── EDGE CASES: case mix ─────────────────────────────────────────────
    ("CUDA y warps",                                           "novalbos",    "uppercase"),
    ("CUDA Y WARPS EN MAYUSCULAS",                             "novalbos",    "all caps"),
    ("cuda y warps en minusculas",                             "novalbos",    "all lower"),
    ("KutxaBank saldo",                                        "tio-gilito",  "KutxaBank"),
    ("kutxabank saldo",                                        "tio-gilito",  "kutxabank lower"),

    # ── EDGE CASES: prompts cortos ───────────────────────────────────────
    ("Gilito",                                                 "tio-gilito",  "1-word trigger"),
    ("CUDA",                                                   "novalbos",    "CUDA solo (nombre propio único)"),
    ("UE5",                                                    "don-claudio", "UE5 1-word"),
    ("Kirkardo",                                               "ultron",      "Kirkardo 1-word"),
    ("Mike",                                                   None,          "Mike 1-word ambiguo (no es exact 'mike-tyson')"),

    # ── EDGE CASES: prompts largos con multiple skills ──────────────────
    ("estoy debugging un bug en TypeScript pero también quiero hacer review del PR",
                                                              "pr-review-toolkit:code-reviewer", "PR gana primero"),
    ("Tío Gilito, dime cuánto he gastado y luego revisa mi código",
                                                              "tio-gilito",  "Tío Gilito wins (first match)"),

    # ── EDGE CASES: adversarial ──────────────────────────────────────────
    ("este prompt no debería disparar ninguna skill ok",       None,          "prompt sin trigger"),
    ("hola",                                                   None,          "saludo simple"),
    ("ok",                                                     None,          "ok simple"),
    ("",                                                       None,          "empty string"),

    # ── ANTI-PATTERN: combinaciones peligrosas ───────────────────────────
    ("gasto computacional en GPU",                             None,          "GPU+gasto técnico, no novalbos (GPU suelto) ni tio-gilito"),
    ("seguridad de tipos del módulo de pagos",                 None,          "tipos+seguridad técnica + módulo NO es security-review"),
    ("La Liga Champions del cripto",                           None,          "Liga+Champions adversarial sin contexto fútbol"),
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
    """Sanity: corpus tiene al menos 30 casos como prometía el sprint."""
    assert len(CORPUS) >= 30, f"corpus too small: {len(CORPUS)}"


def test_no_route_for_slash_commands(dispatch):
    """Slash commands deben hacer short-circuit (Step 1)."""
    assert dispatch("/high revisa esto") == ""
    assert dispatch("/low typo") == ""
    assert dispatch("/dual analiza") == ""
