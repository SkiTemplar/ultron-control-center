// orchestrator/rules.rs — intent classification rules and cross-project detection.

pub(super) struct IntentRule {
    pub intent: &'static str,
    pub workflow_id: &'static str,
    pub patterns: &'static [&'static str],
}

// First match wins — specific intents before general. Bilingual (es/en).
pub(super) const RULES: &[IntentRule] = &[
    IntentRule {
        intent: "security",
        workflow_id: "security",
        patterns: &[
            "seguridad",
            "security",
            "vulnerab",
            "owasp",
            "pentest",
            "secreto",
            "secret",
            "auth",
            "cve",
        ],
    },
    IntentRule {
        intent: "bug_fix",
        workflow_id: "debug",
        patterns: &[
            "bug",
            "arregla",
            "arreglar",
            "fix",
            "error",
            "falla",
            "rompe",
            "crash",
            "debug",
            "depura",
            "no funciona",
        ],
    },
    IntentRule {
        intent: "game",
        workflow_id: "game",
        patterns: &[
            "unity",
            "unreal",
            "ue5",
            "gameplay",
            "game design",
            "combat system",
            "combat mechanic",
            "combo",
            "parry",
            "shader",
            "niagara",
            "blueprint",
            "videojuego",
            "juego",
            "juegos",
            "netcode",
        ],
    },
    IntentRule {
        // UI / design / frontend — route to the feature flow (design-first),
        // but the delegate boost below targets UI/UX/frontend specialists.
        intent: "ui_design",
        workflow_id: "feature",
        patterns: &[
            "interfaz",
            "interface",
            "ui",
            "ux",
            "diseña",
            "diseño de",
            "frontend",
            "componente",
            "component",
            "css",
            "tailwind",
            "responsive",
            "landing",
            "maqueta",
            "mockup",
            "dashboard",
            "wireframe",
            "design system",
            "estilo visual",
        ],
    },
    IntentRule {
        // Testing / QA / coverage — keep it light (quick flow); delegate boost
        // targets test-automator / qa-expert.
        intent: "testing",
        workflow_id: "quick",
        patterns: &[
            "test",
            "tests",
            "prueba",
            "pruebas",
            "unit test",
            "cobertura",
            "coverage",
            "e2e",
            "mock",
            "tdd",
            "escribe pruebas",
            "escribe tests",
        ],
    },
    IntentRule {
        // Performance / optimization — route through the debug flow (profile +
        // verify); delegate boost targets performance-engineer.
        intent: "performance",
        workflow_id: "debug",
        patterns: &[
            "performance",
            "rendimiento",
            "optimiza",
            "optimizar",
            "optimize",
            "lento",
            "slow",
            "latencia",
            "latency",
            "profil",
            "cuello de botella",
            "bottleneck",
            "n+1",
            "memory leak",
            "fuga de memoria",
        ],
    },
    IntentRule {
        // Documentation — quick flow; delegate boost targets documentation
        // specialists over the meta ultron-docs.
        intent: "docs",
        workflow_id: "quick",
        patterns: &[
            "documenta",
            "documentar",
            "documentation",
            "docs",
            "readme",
            "changelog",
            "guia",
            "guía",
            "tutorial de uso",
            "escribe la doc",
            "comenta el codigo",
        ],
    },
    IntentRule {
        // Refactor — behaviour-preserving cleanup; quick flow, delegate boost
        // targets refactoring-specialist over the meta ultron-refactor.
        intent: "refactor",
        workflow_id: "quick",
        patterns: &[
            "refactor",
            "refactoriza",
            "refactorizar",
            "limpia el codigo",
            "limpia el código",
            "reorganiza el codigo",
            "deduplica",
            "simplifica el codigo",
            "code smell",
            "deuda tecnica",
            "deuda técnica",
        ],
    },
    IntentRule {
        // DevOps / infra / deploy — was missing, so CI/CD prompts fell to
        // 'general'. Delegate boost targets devops/deployment/k8s/docker agents.
        intent: "devops",
        workflow_id: "quick",
        patterns: &[
            "ci/cd",
            "cicd",
            "ci cd",
            "pipeline",
            "github actions",
            "deploy",
            "despliegue",
            "desplegar",
            "kubernetes",
            "k8s",
            "docker",
            "dockerfile",
            "terraform",
            "infra",
            "devops",
            "helm",
        ],
    },
    // --- Language / framework / infra DOMAINS (specific names; placed before
    // the generic `feature` rule so a "build X with <tech>" prompt routes to its
    // real specialist instead of falling to a generic intent). ---
    IntentRule {
        intent: "mobile",
        workflow_id: "feature",
        patterns: &[
            "react native",
            "react-native",
            "mobile app",
            "app movil",
            "aplicacion movil",
        ],
    },
    IntentRule {
        intent: "ios",
        workflow_id: "feature",
        patterns: &[
            "swiftui",
            "swift",
            "ios app",
            "iphone",
            "observation framework",
        ],
    },
    IntentRule {
        intent: "android",
        workflow_id: "feature",
        patterns: &["jetpack compose", "android", "kotlin", "hilt"],
    },
    IntentRule {
        intent: "nextjs",
        workflow_id: "feature",
        patterns: &[
            "next.js",
            "nextjs",
            "app router",
            "react",
            "react.",
            "core web vitals",
            "bundle size",
            "renders",
            "app de react",
        ],
    },
    IntentRule {
        intent: "electron",
        workflow_id: "feature",
        patterns: &["electron"],
    },
    IntentRule {
        intent: "websocket",
        workflow_id: "feature",
        patterns: &[
            "websocket",
            "real-time collaborative",
            "broadcasting",
            "tiempo real colaborativo",
            "colaborativo en tiempo",
            "editor colaborativo",
        ],
    },
    IntentRule {
        intent: "ml",
        workflow_id: "feature",
        patterns: &[
            "pytorch",
            "tensorflow",
            "deep learning",
            "machine learning",
            "neural network",
            "training loop",
            "hyperparameter",
            "computer vision",
            "fine-tun",
            "qlora",
            "peft",
            "ml pipeline",
            "ml model",
            "ml",
            "mlops",
            "modelo de ml",
            "fraud detection",
            "recommendation engine",
            "nearest neighbor",
            "faiss",
            "vector quantization",
            "vector search",
            "recommendation system",
        ],
    },
    IntentRule {
        intent: "data_eng",
        workflow_id: "feature",
        patterns: &[
            "etl",
            "apache spark",
            "data warehouse",
            "data pipeline",
            "ingesta de datos",
        ],
    },
    IntentRule {
        intent: "cloud_infra",
        workflow_id: "quick",
        patterns: &[
            "terraform",
            "aws vpc",
            "auto-scaling",
            "load balancer",
            "provision cloud",
            "infraestructura cloud",
            "kubernetes",
            "k8s",
            "helm chart",
            "despliegue en",
            "service mesh",
        ],
    },
    IntentRule {
        intent: "database",
        workflow_id: "quick",
        patterns: &[
            "postgresql",
            "postgres",
            "sql query",
            "window function",
            "consultas sql",
            "consulta sql",
            "base de datos relacional",
            "indices y",
            "mysql",
            "time-series database",
            "time series database",
            "database schema",
            "esquema de base",
            "time-series",
            "time series",
            "sql optimization",
            "sql",
        ],
    },
    IntentRule {
        intent: "golang",
        workflow_id: "feature",
        patterns: &["golang", "grpc", "goroutine", "microservices in go"],
    },
    IntentRule {
        intent: "csharp",
        workflow_id: "feature",
        patterns: &["c#", "asp.net", ".net core", "entity framework", "csharp"],
    },
    IntentRule {
        intent: "rust",
        workflow_id: "feature",
        patterns: &["borrow checker", "rust", "cargo", "lifetime"],
    },
    IntentRule {
        intent: "python",
        workflow_id: "feature",
        patterns: &[
            "python",
            "numba",
            "numpy",
            "pandas",
            "asyncio",
            "django",
            "fastapi",
            "pydantic",
            "codigo python",
            "jit para",
        ],
    },
    IntentRule {
        intent: "typescript",
        workflow_id: "feature",
        patterns: &[
            "typescript",
            "tipos complejos",
            "genericos avanzados",
            "generic types",
            "type-safe",
            "proyecto typescript",
            "tsconfig",
        ],
    },
    IntentRule {
        intent: "api_design",
        workflow_id: "feature",
        patterns: &[
            "graphql",
            "apollo server",
            "rest api",
            "openapi",
            "diseña una api",
            "diseño de api",
        ],
    },
    IntentRule {
        intent: "llm",
        workflow_id: "feature",
        patterns: &[
            "claude api",
            "anthropic",
            "prompt caching",
            "multi-agent",
            "rag pipeline",
            "llm",
            "speculative decoding",
            "kv cache",
            "llama 3",
            "quantization",
            "vllm",
            "inference server",
            "draft model",
        ],
    },
    IntentRule {
        intent: "accessibility",
        workflow_id: "quick",
        patterns: &[
            "wcag",
            "aria",
            "screen reader",
            "lector de pantalla",
            "keyboard navigation",
            "navegacion por teclado",
            "accesibilidad",
            "accessibility",
            "a11y",
            "color contrast",
        ],
    },
    IntentRule {
        intent: "docker",
        workflow_id: "quick",
        patterns: &[
            "docker",
            "container",
            "contenedor",
            "dockerfile",
            "docker-compose",
        ],
    },
    IntentRule {
        // Finance domain -> tio-gilito / warren personas (via preferred_skills).
        intent: "finance",
        workflow_id: "quick",
        patterns: &[
            "financial advice",
            "portfolio",
            "investing",
            "inversion",
            "finanzas",
            "mis gastos",
            "ahorro",
            "retirement",
            "jubilacion",
            "stocks",
            "bonds",
            "reits",
            "npv",
            "capital investment",
            "valoracion financiera",
            "hedging",
            "arbitrage",
            "options spread",
            "delta hedging",
        ],
    },
    IntentRule {
        // Business / marketing -> jordan-belfort / business-strategist personas.
        intent: "business",
        workflow_id: "quick",
        patterns: &[
            "marketing strategy",
            "business strategy",
            "estrategia de negocio",
            "startup",
            "go-to-market",
            "go to market",
            "competitors",
            "competidores",
            "posicionar",
            "modelo de negocio",
            "pricing",
            "punch above",
            "negotiation",
            "negociacion",
            "enterprise deal",
            "saas company",
            "revenue model",
            "arr",
            "sales playbook",
            "pitch deck",
            "investor pitch",
            "investor",
            "b2b saas",
            "growth strategy",
        ],
    },
    IntentRule {
        // Creative writing / narrative -> tolkien persona.
        intent: "writing",
        workflow_id: "quick",
        patterns: &[
            "narrative",
            "narrativa",
            "fantasy trilogy",
            "fantasy novel",
            "epic novel",
            "character arc",
            "arco de personaje",
            "novela",
            // "novel" desnudo hijackearia el adjetivo ingles ('a novel
            // approach'); la frase completa es la unica señal fiable en en.
            "write a novel",
            "escribir un libro",
            "guion",
            "worldbuilding",
            "world-building",
            "world building",
            "plot",
        ],
    },
    IntentRule {
        intent: "feature",
        workflow_id: "feature",
        patterns: &[
            "implementa",
            "feature",
            "añade",
            "agrega",
            "desarrolla",
            "nueva funcion",
            "build a",
            "crea un",
            "crea una",
        ],
    },
    IntentRule {
        intent: "research",
        workflow_id: "research",
        patterns: &[
            "investiga",
            "research",
            "compara",
            "evalua",
            "deep research",
            "busca informacion",
            "estado del arte",
        ],
    },
    IntentRule {
        intent: "learning",
        workflow_id: "learning",
        patterns: &[
            "aprende",
            "explica",
            "explícame",
            "explicame",
            "tutorial",
            "apuntes",
            "enséñame",
            "ensename",
            "como funciona",
            "learn",
        ],
    },
    IntentRule {
        intent: "architecture_review",
        workflow_id: "quick",
        patterns: &[
            "arquitectura",
            "architecture",
            "revisa el diseño",
            "design review",
            "acoplamiento",
            "solid",
        ],
    },
    IntentRule {
        intent: "memory",
        workflow_id: "quick",
        patterns: &[
            "memoria",
            "recuerda",
            "olvida",
            "no uses esa",
            "actualiza la decision",
        ],
    },
    IntentRule {
        intent: "continue",
        workflow_id: "quick",
        patterns: &[
            "sigue",
            "continúa",
            "continua",
            "retoma",
            "lanza el orquestador",
            "orquestador",
        ],
    },
];

/// Domain-specific (language/framework/infra) intents. These WIN over generic
/// action intents (bug_fix/performance/devops/feature) because a prompt like
/// "optimize indexes in PostgreSQL" or "build an ETL pipeline with Spark" should
/// route to the tech specialist (postgres-pro/data-engineer), not the action
/// agent (performance-engineer/devops-engineer). classify_intent checks these
/// FIRST so "pipeline"/"optimize"/"error" no longer hijack a domain prompt.
pub(super) const DOMAIN_INTENTS: &[&str] = &[
    "game",
    "mobile",
    "ios",
    "android",
    "nextjs",
    "electron",
    "websocket",
    "ml",
    "data_eng",
    "cloud_infra",
    "database",
    "golang",
    "csharp",
    "rust",
    "api_design",
    "llm",
    "accessibility",
    "docker",
    "finance",
    "business",
    "writing",
    "python",
    "typescript",
    "architecture_review",
];

/// Skills (personas / domain skills) the detected intent should surface in the
/// delegate_skills list. ULTRON has strong PERSONA skills that should win their
/// domain (don-claudio for gamedev, tio-gilito for finance, jordan-belfort for
/// business, tolkien for writing, mike-tyson for design) but they're skills, not
/// agents, and raw similarity buried them. Boosted + floor-injected like agents.
pub(super) fn preferred_skills(intent: &str) -> &'static [&'static str] {
    match intent {
        "game" => &["don-claudio"],
        "finance" => &["tio-gilito", "warren"],
        "business" => &["jordan-belfort", "business-strategist", "warren"],
        "writing" => &["tolkien"],
        "ui_design" | "accessibility" => &["mike-tyson", "ui-designer", "ui-ux-pro-max"],
        "learning" => &["novalbos", "einstein"],
        _ => &[],
    }
}

/// Substring match anclado a límites de palabra: el byte anterior y el
/// posterior al match no pueden ser ASCII alfanuméricos. Sin esto, un
/// `contains()` plano hijackeaba intents: "trust"/"frustrado"→rust,
/// "latest"/"fastest"→test, "array"→business (audit 2026-07-20, cat3).
/// El límite se comprueba FUERA del patrón completo: un espacio de borde en
/// el patrón ("cargo ", " ml ") desplaza el chequeo al carácter que sigue al
/// espacio (casi siempre letra) y mata el patrón. Por eso la tabla RULES no
/// debe llevar espacios de borde — matches_word ya pone el límite. Símbolos
/// que forman parte del token buscado ("c#", ".net core") sí funcionan.
fn matches_word(haystack: &str, pat: &str) -> bool {
    if pat.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(idx) = haystack[from..].find(pat) {
        let start = from + idx;
        let end = start + pat.len();
        let before_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let after_ok = end >= bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        // Avanzar el largo del primer char del patrón (seguro en UTF-8).
        from = start + pat.chars().next().map(char::len_utf8).unwrap_or(1);
    }
    false
}

/// Classify a prompt into `(intent, workflow_id)`. Two-pass: domain-specific
/// intents first (a tech name beats a generic action verb), then action/general.
/// Default = general/quick.
pub fn classify_intent(prompt: &str) -> (&'static str, &'static str) {
    let p = prompt.to_lowercase();
    // Pass 1 — domain-specific intents win over action verbs.
    for r in RULES {
        if DOMAIN_INTENTS.contains(&r.intent) && r.patterns.iter().any(|pat| matches_word(&p, pat))
        {
            return (r.intent, r.workflow_id);
        }
    }
    // Pass 2 — action / general intents (security, bug_fix, ui_design, ...).
    for r in RULES {
        if !DOMAIN_INTENTS.contains(&r.intent) && r.patterns.iter().any(|pat| matches_word(&p, pat))
        {
            return (r.intent, r.workflow_id);
        }
    }
    ("general", "quick")
}

/// Distinctive bilingual (es/en) phrases that imply the user is asking about a
/// DIFFERENT project than the current one ("aquel proyecto", "otro proyecto",
/// "the other project", "across all my projects"...). Substring-matched, same
/// cheap heuristic as `classify_intent` — no NLU. Kept narrow on purpose: a false
/// positive only WIDENS recall (still security-gated), but we avoid generic words
/// like "proyecto" alone that would fire on in-project prompts.
const CROSS_PROJECT_PHRASES: &[&str] = &[
    "otro proyecto",
    "otros proyectos",
    "aquel proyecto",
    "aquel otro proyecto",
    "ese proyecto",
    "en otro proyecto",
    "todos mis proyectos",
    "todos los proyectos",
    "cualquier proyecto",
    "entre proyectos",
    "cross-project",
    "cross project",
    "other project",
    "another project",
    "the other project",
    "all my projects",
    "all projects",
    "across projects",
    "any project",
];

/// Heuristic intent detector for CROSS-PROJECT (whole-brain) recall. Returns true
/// only when the prompt explicitly references a different / other / all projects.
/// Deliberately conservative — see `CROSS_PROJECT_PHRASES`. The caller still gates
/// this on having a current `project_id` (cross-project is a no-op without one).
pub fn detect_cross_project(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    CROSS_PROJECT_PHRASES.iter().any(|pat| p.contains(pat))
}

/// Frases (es/en) de tareas META/INTROSPECTIVAS sobre la propia sesión:
/// autoevaluación, resumen de la conversación, "ponte nota"... Un subagente
/// NO tiene el transcript de la conversación, así que ordenar DELEGAR esta
/// clase es ordenar un imposible (card bvaqws 2026-06-23). Mismo patrón
/// barato que `CROSS_PROJECT_PHRASES`: frases con espacios, específicas —
/// nada de palabras sueltas genéricas (lección routing 2026-06-05).
const META_INTROSPECTIVE_PHRASES: &[&str] = &[
    "autoevalua",
    "autoevalúa",
    "autoevaluacion",
    "autoevaluación",
    "evalua la sesion",
    "evalúa la sesión",
    "evalua esta sesion",
    "evalúa esta sesión",
    "evalua tu trabajo",
    "evalúa tu trabajo",
    "evalua tu rendimiento",
    "evalúa tu rendimiento",
    "evalua esta conversacion",
    "evalúa esta conversación",
    "resume la sesion",
    "resume la sesión",
    "resume esta sesion",
    "resume esta sesión",
    "resume la conversacion",
    "resume la conversación",
    "resume esta conversacion",
    "resume esta conversación",
    "que nota te pones",
    "qué nota te pones",
    "ponte nota",
    "evaluate this session",
    "evaluate your performance",
    "summarize this session",
    "summarize this conversation",
    "self-assess",
    "self-evaluate",
    "rate your performance",
];

/// `true` si el prompt es de clase meta/introspectiva sobre la propia sesión —
/// no delegable a subagentes (no tienen el transcript).
pub fn is_meta_introspective(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    META_INTROSPECTIVE_PHRASES.iter().any(|pat| p.contains(pat))
}

#[cfg(test)]
mod tests {
    use super::{classify_intent, matches_word};

    #[test]
    fn matches_word_anchors_both_boundaries() {
        // Los bordes del prompt cuentan como límite de palabra.
        assert!(matches_word("ml pipeline", "ml"));
        assert!(matches_word("es ml", "ml"));
        assert!(matches_word("ui/ux", "ui"));
        // Vecino multi-byte UTF-8 ('ñ') no rompe el chequeo de límite.
        assert!(matches_word("añade auth ya", "auth"));
        // Sub-palabra nunca matchea.
        assert!(!matches_word("html", "ml"));
        assert!(!matches_word("build", "ui"));
        assert!(!matches_word("me encargo del deploy", "cargo"));
        assert!(!matches_word("frustrado", "rust"));
        assert!(!matches_word("latest", "test"));
        assert!(!matches_word("array", "arr"));
    }

    /// Los 12 patrones que traían el límite como espacio embebido (muertos
    /// con matches_word) rutean de nuevo tras normalizar la tabla RULES.
    #[test]
    fn normalized_patterns_route_to_their_zone() {
        assert_eq!(
            classify_intent("cargo build falla en ci"),
            ("rust", "feature")
        );
        assert_eq!(
            classify_intent("optimiza el sql lento"),
            ("database", "quick")
        );
        assert_eq!(
            classify_intent("añade auth middleware"),
            ("security", "security")
        );
        assert_eq!(
            classify_intent("entrena el ml con estos datos"),
            ("ml", "feature")
        );
        assert_eq!(
            classify_intent("mejora la ui de la pagina"),
            ("ui_design", "feature")
        );
        assert_eq!(
            classify_intent("actualiza los docs del proyecto"),
            ("docs", "quick")
        );
        assert_eq!(
            classify_intent("migra la app a react"),
            ("nextjs", "feature")
        );
        assert_eq!(classify_intent("escribe esto en swift"), ("ios", "feature"));
        assert_eq!(
            classify_intent("integra un llm en el backend"),
            ("llm", "feature")
        );
        assert_eq!(
            classify_intent("proyecta el arr del proximo año"),
            ("business", "quick")
        );
        assert_eq!(
            classify_intent("crea un juego de plataformas"),
            ("game", "game")
        );
        assert_eq!(
            classify_intent("mecanicas para juegos multijugador"),
            ("game", "game")
        );
    }

    /// Anti-hijack (audit 2026-07-20, cat3): sub-palabras no disparan intents.
    #[test]
    fn word_boundary_kills_known_hijacks() {
        // "frustrado" contiene "rust" pero NO es rust.
        assert_eq!(
            classify_intent("estoy frustrado con este error").0,
            "bug_fix"
        );
        // "latest" contiene "test" pero NO es testing.
        assert_eq!(
            classify_intent("usa la latest version disponible").0,
            "general"
        );
        // "array" ya no alimenta "arr" (hijack array→business).
        assert_eq!(
            classify_intent("convierte el array en un objeto").0,
            "general"
        );
        // "oauth2" no dispara "auth".
        assert_eq!(
            classify_intent("configura oauth2 con el proveedor").0,
            "general"
        );
    }

    #[test]
    fn prompt_edges_count_as_word_boundary() {
        // Patrón al inicio del prompt.
        assert_eq!(classify_intent("ml en produccion, revisalo").0, "ml");
        // Patrón al final del prompt.
        assert_eq!(classify_intent("explícame qué es un llm").0, "llm");
    }
}
