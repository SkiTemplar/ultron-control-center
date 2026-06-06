// ULTRON Control Center — Orchestrator "Ultron" (Auto-routing #7)
//
// Maps a (possibly vague) prompt to an ORCHESTRATION CONTEXT:
//   prompt -> intent -> workflow -> delegate agents -> memories -> constraints.
//
// Intent classification is RULES-based on purpose: the master prompt says "no
// usar modelo grande para lo que resuelven reglas/triggers/metadata". The LLM
// (AI Routing #8) is reserved for the ambiguous tail later.
//
// Reuses, does NOT duplicate: agent catalog (memory::catalog), recall
// (commands::memory::recall_unified::build_trace), and the 7 built-in workflows
// (agent_orchestration::list_workflows_inner). The orchestrator NEVER writes
// persistent memory (only the Memory Agent does) and DELEGATES to the real
// agents in ~/.claude/agents (ghost agents are sanitized out).

use serde::Serialize;

use crate::agent_orchestration::list_workflows_inner;
use crate::commands::memory::recall_unified::{build_trace, RecallEntry};
use crate::memory::catalog;

const TOKEN_BUDGET: i64 = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct AgentChoice {
    pub name: String,
    pub description: String,
    pub score: f32,
}

/// A SKILL the prompt should also consider (personas like `tio-gilito`,
/// technical skills like `rust-patterns`, meta skills like `council`). Skills
/// are indexed in the same `ultron_catalog` but were previously excluded from
/// the routing read-path (agent-only filter) — ~60% of the catalog was dead.
#[derive(Debug, Clone, Serialize)]
pub struct SkillChoice {
    pub name: String,
    pub description: String,
    pub kind: String, // persona | technical | meta
    pub score: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowChoice {
    pub id: String,
    pub label: String,
    pub description: String,
    /// Template step agents, with ghosts (non-existent on disk) removed.
    pub steps: Vec<String>,
}

/// The compact `<ORCHESTRATION_CONTEXT>` handed to the model.
#[derive(Debug, Clone, Serialize)]
pub struct OrchestrationContext {
    pub prompt: String,
    pub route: String, // detected intent
    pub project_id: Option<String>,
    pub workflow: Option<WorkflowChoice>,
    pub delegate_agents: Vec<AgentChoice>, // real specialists, semantic match
    pub delegate_skills: Vec<SkillChoice>, // relevant skills (personas/technical/meta)
    pub memories: Vec<RecallEntry>,        // from hybrid recall
    pub constraints: Vec<String>,
    pub warnings: Vec<String>,
    pub token_budget: i64,
    /// Whether recall ran in CROSS-PROJECT mode (whole-brain). True only when a
    /// `project_id` is set AND the prompt explicitly asks about another project
    /// (see `detect_cross_project`). Surfaced so the hook/UI can show it triggered.
    pub cross_project: bool,
}

struct IntentRule {
    intent: &'static str,
    workflow_id: &'static str,
    patterns: &'static [&'static str],
}

// First match wins — specific intents before general. Bilingual (es/en).
const RULES: &[IntentRule] = &[
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
            "auth ",
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
            " juego",
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
            "ui ",
            " ui",
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
            " docs",
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
        patterns: &["react native", "react-native", "mobile app", "app movil", "aplicacion movil"],
    },
    IntentRule {
        intent: "ios",
        workflow_id: "feature",
        patterns: &["swiftui", "swift ", "ios app", "iphone", "observation framework"],
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
            "next.js", "nextjs", "app router", "react ", "react.", "core web vitals",
            "bundle size", "renders", "app de react",
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
            "websocket", "real-time collaborative", "broadcasting",
            "tiempo real colaborativo", "colaborativo en tiempo", "editor colaborativo",
        ],
    },
    IntentRule {
        intent: "ml",
        workflow_id: "feature",
        patterns: &[
            "pytorch", "tensorflow", "deep learning", "machine learning", "neural network",
            "training loop", "hyperparameter", "computer vision", "fine-tun", "qlora", "peft",
            "ml pipeline", "ml model", " ml ", "mlops", "modelo de ml", "fraud detection",
            "recommendation engine", "nearest neighbor", "faiss",
            "vector quantization", "vector search", "recommendation system",
        ],
    },
    IntentRule {
        intent: "data_eng",
        workflow_id: "feature",
        patterns: &["etl", "apache spark", "data warehouse", "data pipeline", "ingesta de datos"],
    },
    IntentRule {
        intent: "cloud_infra",
        workflow_id: "quick",
        patterns: &[
            "terraform", "aws vpc", "auto-scaling", "load balancer", "provision cloud",
            "infraestructura cloud", "kubernetes", "k8s", "helm chart", "despliegue en", "service mesh",
        ],
    },
    IntentRule {
        intent: "database",
        workflow_id: "quick",
        patterns: &[
            "postgresql", "postgres", "sql query", "window function", "consultas sql",
            "consulta sql", "base de datos relacional", "indices y", "mysql",
            "time-series database", "time series database", "database schema",
            "esquema de base", "time-series", "time series", "sql optimization", " sql ",
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
        patterns: &["borrow checker", "rust", "cargo ", "lifetime"],
    },
    IntentRule {
        intent: "python",
        workflow_id: "feature",
        patterns: &[
            "python", "numba", "numpy", "pandas", "asyncio", "django", "fastapi",
            "pydantic", "codigo python", "jit para",
        ],
    },
    IntentRule {
        intent: "typescript",
        workflow_id: "feature",
        patterns: &[
            "typescript", "tipos complejos", "genericos avanzados", "generic types",
            "type-safe", "proyecto typescript", "tsconfig",
        ],
    },
    IntentRule {
        intent: "api_design",
        workflow_id: "feature",
        patterns: &["graphql", "apollo server", "rest api", "openapi", "diseña una api", "diseño de api"],
    },
    IntentRule {
        intent: "llm",
        workflow_id: "feature",
        patterns: &[
            "claude api", "anthropic", "prompt caching", "multi-agent", "rag pipeline", " llm ",
            "speculative decoding", "kv cache", "llama 3", "quantization", "vllm", "inference server",
            "draft model",
        ],
    },
    IntentRule {
        intent: "accessibility",
        workflow_id: "quick",
        patterns: &[
            "wcag", "aria", "screen reader", "lector de pantalla", "keyboard navigation",
            "navegacion por teclado", "accesibilidad", "accessibility", "a11y", "color contrast",
        ],
    },
    IntentRule {
        intent: "docker",
        workflow_id: "quick",
        patterns: &["docker", "container", "contenedor", "dockerfile", "docker-compose"],
    },
    IntentRule {
        // Finance domain -> tio-gilito / warren personas (via preferred_skills).
        intent: "finance",
        workflow_id: "quick",
        patterns: &[
            "financial advice", "portfolio", "investing", "inversion", "finanzas",
            "mis gastos", "ahorro", "retirement", "jubilacion", "stocks", "bonds", "reits",
            "npv", "capital investment", "valoracion financiera", "hedging", "arbitrage",
            "options spread", "delta hedging",
        ],
    },
    IntentRule {
        // Business / marketing -> jordan-belfort / business-strategist personas.
        intent: "business",
        workflow_id: "quick",
        patterns: &[
            "marketing strategy", "business strategy", "estrategia de negocio", "startup",
            "go-to-market", "go to market", "competitors", "competidores", "posicionar",
            "modelo de negocio", "pricing", "punch above", "negotiation", "negociacion",
            "enterprise deal", "saas company", "revenue model", " arr", "sales playbook",
            "pitch deck", "investor pitch", "investor", "b2b saas", "growth strategy",
        ],
    },
    IntentRule {
        // Creative writing / narrative -> tolkien persona.
        intent: "writing",
        workflow_id: "quick",
        patterns: &[
            "narrative", "narrativa", "fantasy trilogy", "fantasy novel", "epic novel",
            "character arc", "arco de personaje", "novela", "novel ", "escribir un libro",
            "guion", "worldbuilding", "world-building", "world building", "plot",
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
            "build a ",
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
const DOMAIN_INTENTS: &[&str] = &[
    "game", "mobile", "ios", "android", "nextjs", "electron", "websocket", "ml",
    "data_eng", "cloud_infra", "database", "golang", "csharp", "rust",
    "api_design", "llm", "accessibility", "docker", "finance", "business", "writing",
    "python", "typescript", "architecture_review",
];

/// Skills (personas / domain skills) the detected intent should surface in the
/// delegate_skills list. ULTRON has strong PERSONA skills that should win their
/// domain (don-claudio for gamedev, tio-gilito for finance, jordan-belfort for
/// business, tolkien for writing, mike-tyson for design) but they're skills, not
/// agents, and raw similarity buried them. Boosted + floor-injected like agents.
fn preferred_skills(intent: &str) -> &'static [&'static str] {
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

/// Classify a prompt into `(intent, workflow_id)`. Two-pass: domain-specific
/// intents first (a tech name beats a generic action verb), then action/general.
/// Default = general/quick.
pub fn classify_intent(prompt: &str) -> (&'static str, &'static str) {
    let p = prompt.to_lowercase();
    // Pass 1 — domain-specific intents win over action verbs.
    for r in RULES {
        if DOMAIN_INTENTS.contains(&r.intent)
            && r.patterns.iter().any(|pat| p.contains(pat))
        {
            return (r.intent, r.workflow_id);
        }
    }
    // Pass 2 — action / general intents (security, bug_fix, ui_design, ...).
    for r in RULES {
        if !DOMAIN_INTENTS.contains(&r.intent)
            && r.patterns.iter().any(|pat| p.contains(pat))
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

/// ULTRON-internal META agents. They are housekeeping/self-improvement helpers
/// (refresh docs, compose changelog, behaviour-preserving refactor, compress
/// context, etc.), NOT task specialists. The semantic index over-weights them
/// because their descriptions are generic, so the delegate ranking used to put
/// `ultron-docs`/`ultron-changelog`/`ultron-refactor` above real specialists
/// like `debugger` or `code-reviewer`. We demote them unless the prompt is
/// explicitly about that meta task (handled via the intent boost below).
const META_AGENTS: &[&str] = &[
    "ultron-changelog",
    "ultron-context",
    "ultron-docs",
    "ultron-metadata",
    "ultron-news",
    "ultron-refactor",
    "ultron-self-improve",
    "ultron-skill-editor",
    "ultron-test",
];

/// Generic "catch-all" agents whose broad descriptions match almost ANY prompt,
/// so the raw semantic score crowds out the real domain specialist. The
/// independent verifier found code-reviewer/qa-expert/architect-reviewer ranking
/// ~1.0 over postgres-pro/swift-expert/terraform-engineer (~0.84) across mobile,
/// db, ios, android, go, cloud, data, graphql, etc. Demoted like meta agents
/// UNLESS the detected intent explicitly prefers them (e.g. code-reviewer for a
/// review/security/testing prompt, debugger for bug_fix). This scales to ALL ~78
/// agents without enumerating each domain: the specialist the retrieval already
/// surfaced simply stops being buried.
const GENERIC_AGENTS: &[&str] = &[
    "code-reviewer",
    "qa-expert",
    "architect-reviewer",
    "debugger",
    "error-detective",
];

/// Multiplicative penalty applied to META agents during delegate ranking.
const META_PENALTY: f32 = 0.55;
/// Multiplicative penalty for GENERIC agents that the intent does not prefer.
const GENERIC_PENALTY: f32 = 0.60;
/// Additive boost applied to agents the detected intent/workflow prefers.
const SPECIALIST_BOOST: f32 = 0.20;
/// Floor score for a preferred specialist that E5 retrieval MISSED entirely
/// (cross-lingual noise). Just above the ~0.78-0.81 noise ceiling so that, once
/// the +SPECIALIST_BOOST is applied, it ranks above irrelevant retrieved agents
/// but below specialists that were genuinely retrieved with a real high score.
const PREFERRED_FLOOR: f32 = 0.80;

/// Specialist agent names the detected `intent` should prioritise. These are
/// REAL agents in `~/.claude/agents` (verified). The boost lifts them above the
/// meta agents when the prompt clearly belongs to their domain.
fn preferred_specialists(intent: &str) -> &'static [&'static str] {
    match intent {
        "security" => &["security-auditor", "penetration-tester", "ultron-security", "code-reviewer"],
        "bug_fix" => &["debugger", "error-detective", "qa-expert"],
        "performance" => &["performance-engineer", "ultron-perf", "debugger"],
        "testing" => &["test-automator", "qa-expert", "code-reviewer"],
        // NOTE: 'ui-designer' is a SKILL, not an agent on disk — it used to sit
        // here as a dead ref (boost impossible). Real UI agents only; the
        // ui-designer/mike-tyson SKILLS now compete via the skill read-path.
        "ui_design" => &[
            "frontend-developer",
            "react-specialist",
            "accessibility-tester",
            "mobile-developer",
        ],
        "devops" => &[
            "devops-engineer",
            "deployment-engineer",
            "kubernetes-specialist",
            "docker-expert",
        ],
        "docs" => &["documentation-engineer", "ultron-docs"],
        "refactor" => &["refactoring-specialist", "ultron-refactor", "code-reviewer"],
        "architecture_review" => &["architect-reviewer", "microservices-architect", "cloud-architect", "ultron-arch"],
        "feature" => &["architect-reviewer", "fullstack-developer", "code-reviewer"],
        "research" => &["ai-engineer", "llm-architect", "architect-reviewer"],
        "game" => &["unreal-engine-engineer", "cpp-pro", "architect-reviewer"],
        // Language / framework / infra domains — verifier found these buried
        // under generic agents. Floor-injected + boosted so they win their domain.
        "database" => &["postgres-pro", "sql-pro", "database-administrator"],
        "mobile" => &["mobile-developer", "react-specialist"],
        "ios" => &["swift-expert", "mobile-developer"],
        "android" => &["kotlin-specialist", "mobile-developer"],
        "golang" => &["golang-pro", "backend-developer"],
        "csharp" => &["csharp-developer", "backend-developer"],
        "rust" => &["rust-engineer", "cpp-pro"],
        "python" => &["python-pro", "backend-developer"],
        "typescript" => &["typescript-pro", "javascript-pro", "frontend-developer"],
        "cloud_infra" => &["terraform-engineer", "cloud-architect", "kubernetes-specialist"],
        "ml" => &["ml-engineer", "mlops-engineer", "ai-engineer"],
        "data_eng" => &["data-engineer", "database-administrator"],
        "websocket" => &["websocket-engineer", "backend-developer"],
        "electron" => &["electron-pro", "frontend-developer"],
        "nextjs" => &["nextjs-developer", "react-specialist"],
        "api_design" => &["api-designer", "backend-developer", "microservices-architect"],
        "llm" => &["llm-architect", "ai-engineer", "prompt-engineer"],
        "accessibility" => &["accessibility-tester", "frontend-developer"],
        "docker" => &["docker-expert", "devops-engineer", "kubernetes-specialist"],
        "finance" => &["backend-developer"],
        "business" => &["backend-developer"],
        "writing" => &["documentation-engineer"],
        "learning" => &["llm-architect", "code-reviewer"],
        _ => &["code-reviewer", "qa-expert"],
    }
}

/// Re-rank the raw semantic catalog hits so that real specialists pertinent to
/// the detected `intent` rank above the generic ULTRON-internal meta agents.
///
/// Rules (first-match-wins ordering preserved upstream):
///   - META agents get a multiplicative `META_PENALTY` (demoted)...
///   - ...UNLESS they are also in `preferred_specialists(intent)` (e.g.
///     `ultron-docs` for the `docs` intent), in which case the penalty is
///     waived and they get the boost like any other preferred specialist.
///   - Any preferred specialist gets an additive `SPECIALIST_BOOST`.
/// Then sort by adjusted score (desc) and keep the top `keep`.
fn rebalance_delegates(
    hits: Vec<catalog::CatalogHit>,
    intent: &str,
    keep: usize,
) -> Vec<AgentChoice> {
    let preferred = preferred_specialists(intent);
    let mut scored: Vec<AgentChoice> = hits
        .into_iter()
        .map(|h| {
            let is_preferred = preferred.iter().any(|p| *p == h.name);
            let is_meta = META_AGENTS.contains(&h.name.as_str());
            let is_generic = GENERIC_AGENTS.contains(&h.name.as_str());
            let mut score = h.score;
            // Demote meta agents that are not pertinent to this intent.
            if is_meta && !is_preferred {
                score *= META_PENALTY;
            }
            // Demote generic catch-all agents the intent doesn't prefer, so the
            // real domain specialist (already retrieved) is no longer buried.
            if is_generic && !is_preferred {
                score *= GENERIC_PENALTY;
            }
            // Boost specialists this intent prefers.
            if is_preferred {
                score += SPECIALIST_BOOST;
            }
            AgentChoice {
                name: h.name,
                description: h.description,
                score,
            }
        })
        .collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(keep);
    scored
}

/// Embedding noise floor — multilingual E5 scores for irrelevant catalog entries
/// cluster around 0.78-0.81 (measured). Skills at or below this are dropped so
/// the assistant only sees pertinent ones (an empty skill list is valid).
const NOISE_FLOOR: f32 = 0.80;

/// Guarantee the intent's preferred specialists enter the rebalance pool even
/// when E5 retrieval (cross-lingual ES-prompt vs EN-description noise) failed to
/// surface them in the raw top-k. Without this the +SPECIALIST_BOOST is
/// decorative — it can only lift already-retrieved agents. Any preferred agent
/// that exists on disk but is missing from `hits` is injected at PREFERRED_FLOOR
/// so the downstream boost ranks it. This is the core fix for the UI/testing
/// 0/3 routing failures (the right agent never made the top-12 retrieval).
fn inject_preferred_floor(
    mut hits: Vec<catalog::CatalogHit>,
    intent: &str,
) -> Vec<catalog::CatalogHit> {
    let preferred = preferred_specialists(intent);
    let present: std::collections::HashSet<String> = hits.iter().map(|h| h.name.clone()).collect();
    let known = catalog::known_agent_names();
    for name in preferred {
        if !present.contains(*name) && known.contains(*name) {
            hits.push(catalog::CatalogHit {
                entity: "agent".into(),
                name: (*name).to_string(),
                description: catalog::agent_description(name).unwrap_or_default(),
                score: PREFERRED_FLOOR,
                kind: String::new(),
            });
        }
    }
    hits
}

/// Rank skill hits and keep the top `keep` above the noise floor. Skills arrive
/// pre-sorted by semantic score from Qdrant; we drop sub-floor noise so a prompt
/// with no pertinent skill yields an empty list rather than fake suggestions.
fn rank_skills(hits: Vec<catalog::CatalogHit>, intent: &str, keep: usize) -> Vec<SkillChoice> {
    let preferred = preferred_skills(intent);
    let mut skills: Vec<SkillChoice> = hits
        .into_iter()
        .filter(|h| h.score > NOISE_FLOOR || preferred.contains(&h.name.as_str()))
        .map(|h| {
            let mut score = h.score;
            if preferred.contains(&h.name.as_str()) {
                score += SPECIALIST_BOOST;
            }
            SkillChoice { name: h.name, description: h.description, kind: h.kind, score }
        })
        .collect();
    // Floor-inject the intent's preferred persona/domain skills the retrieval
    // missed, so e.g. tio-gilito wins a finance prompt even if E5 buried it.
    let present: std::collections::HashSet<String> = skills.iter().map(|s| s.name.clone()).collect();
    for name in preferred {
        if !present.contains(*name) {
            skills.push(SkillChoice {
                name: (*name).to_string(),
                description: String::new(),
                kind: "persona".to_string(),
                score: PREFERRED_FLOOR + SPECIALIST_BOOST,
            });
        }
    }
    skills.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    skills.truncate(keep);
    skills
}

/// Build the orchestration context for a prompt. Pure read — writes no memory.
pub fn orchestrate(prompt: &str, project_id: Option<&str>) -> OrchestrationContext {
    let (intent, wf_id) = classify_intent(prompt);
    let known = catalog::known_agent_names();
    let mut warnings: Vec<String> = Vec::new();

    // Selected workflow (built-in), with ghost step-agents sanitized.
    let workflow = list_workflows_inner()
        .into_iter()
        .find(|w| w.id == wf_id)
        .map(|w| {
            let mut steps = Vec::new();
            for s in &w.steps {
                if known.is_empty() || known.contains(&s.agent) {
                    steps.push(s.agent.clone());
                } else {
                    warnings.push(format!(
                        "workflow step agent '{}' not found on disk (ghost) — skipped",
                        s.agent
                    ));
                }
            }
            WorkflowChoice {
                id: w.id,
                label: w.label,
                description: w.description,
                steps,
            }
        });

    // Real specialists to DELEGATE to (semantic match over the agent catalog).
    // Over-fetch, then rebalance so the meta ULTRON-internal agents don't crowd
    // out the real specialists pertinent to the detected intent.
    let raw_hits = catalog::search_catalog(prompt, Some("agent"), 16);
    // Floor-inject the intent's preferred specialists so the boost isn't
    // decorative when cross-lingual retrieval missed them (UI/testing 0/3 fix).
    let pooled = inject_preferred_floor(raw_hits, intent);
    let delegate_agents: Vec<AgentChoice> = rebalance_delegates(pooled, intent, 5);
    if delegate_agents.is_empty() {
        warnings.push("agent catalog empty/unavailable — run `catalog_reindex`".to_string());
    }

    // SKILLS now compete in routing (previously the agent-only filter left the
    // ~119 indexed skills — personas + technical — dead). Separate read-path so
    // the assistant sees pertinent skills (e.g. tio-gilito for finance) too.
    let skill_hits = catalog::search_catalog(prompt, Some("skill"), 10);
    let delegate_skills = rank_skills(skill_hits, intent, 4);

    // CROSS-PROJECT auto-detect: a no-op without a current project (cross-project
    // is meaningless then). When the prompt asks about another / all projects we
    // widen recall to the whole brain — security gates (Secret excluded) untouched.
    let cross_project = project_id.is_some() && detect_cross_project(prompt);
    if cross_project {
        warnings.push(
            "cross-project recall — searching the whole brain (other projects included)".to_string(),
        );
    }

    // Relevant memories via hybrid recall (already token-budgeted).
    let memories = match build_trace(prompt, 12, project_id, cross_project, None) {
        Ok(t) => {
            warnings.extend(t.warnings.clone());
            t.injected
        }
        Err(e) => {
            warnings.push(format!("recall unavailable: {e}"));
            Vec::new()
        }
    };

    let constraints = vec![
        "Minimizar tokens: usar el context pack, no memoria cruda".to_string(),
        "Solo el Memory Agent escribe memoria persistente".to_string(),
        "DELEGAR a los agentes reales existentes; no reinventar capacidades".to_string(),
    ];

    OrchestrationContext {
        prompt: prompt.to_string(),
        route: intent.to_string(),
        project_id: project_id.map(str::to_string),
        workflow,
        delegate_agents,
        delegate_skills,
        memories,
        constraints,
        warnings,
        token_budget: TOKEN_BUDGET,
        cross_project,
    }
}

/// Tauri command: run the orchestrator for a prompt (the "Ultron" trigger).
#[tauri::command]
pub async fn orchestrate_prompt(
    prompt: String,
    project_id: Option<String>,
) -> Result<OrchestrationContext, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(orchestrate(&prompt, project_id.as_deref())))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_vague_prompts_to_workflows() {
        assert_eq!(classify_intent("arregla el bug de login").1, "debug");
        assert_eq!(
            classify_intent("revisa la seguridad del endpoint").1,
            "security"
        );
        assert_eq!(
            classify_intent("implementa una feature de export").1,
            "feature"
        );
        assert_eq!(
            classify_intent("investiga opciones de embeddings").1,
            "research"
        );
        assert_eq!(
            classify_intent("explícame cómo funciona Qdrant").1,
            "learning"
        );
        assert_eq!(classify_intent("sigue con esto").1, "quick");
        assert_eq!(classify_intent("lanza el orquestador").0, "continue");
        assert_eq!(classify_intent("algo totalmente ambiguo xyz").0, "general");
    }

    #[test]
    fn detect_cross_project_fires_only_on_other_project_phrases() {
        // Positive — bilingual phrases referencing another / all projects.
        assert!(detect_cross_project("¿te acuerdas de aquel proyecto del banco?"));
        assert!(detect_cross_project("busca en otro proyecto"));
        assert!(detect_cross_project("mira en todos mis proyectos"));
        assert!(detect_cross_project("what did we decide in the other project?"));
        assert!(detect_cross_project("search across projects please"));
        assert!(detect_cross_project("anything in any project about finanzas"));
        // Negative — in-project work must NOT trigger whole-brain recall.
        assert!(!detect_cross_project("arregla el bug de este proyecto"));
        assert!(!detect_cross_project("sigue con la feature de export"));
        assert!(!detect_cross_project("optimiza esta consulta"));
        assert!(!detect_cross_project("proyecto")); // bare word does not fire
    }

    #[test]
    fn classifies_new_intents_ui_test_perf_docs_refactor() {
        // UI / design -> feature flow
        assert_eq!(
            classify_intent("diseña la interfaz del dashboard"),
            ("ui_design", "feature")
        );
        assert_eq!(
            classify_intent("crea un componente responsive con tailwind"),
            ("ui_design", "feature")
        );
        // Testing -> quick flow
        assert_eq!(
            classify_intent("escribe tests unitarios para el parser"),
            ("testing", "quick")
        );
        assert_eq!(
            classify_intent("falta cobertura en este modulo"),
            ("testing", "quick")
        );
        // Performance -> debug flow
        assert_eq!(
            classify_intent("optimiza esta consulta, va lento"),
            ("performance", "debug")
        );
        assert_eq!(
            classify_intent("hay un cuello de botella en el render"),
            ("performance", "debug")
        );
        // Docs -> quick flow
        assert_eq!(
            classify_intent("documenta esta API en el readme"),
            ("docs", "quick")
        );
        // Refactor -> quick flow
        assert_eq!(
            classify_intent("refactoriza este modulo sin cambiar comportamiento"),
            ("refactor", "quick")
        );
    }

    #[test]
    fn rebalance_demotes_meta_and_boosts_specialists() {
        // Meta agent ranks first by raw semantic score; the pertinent specialist
        // is below it. After rebalancing for the `bug_fix` intent, `debugger`
        // (a preferred specialist) must outrank `ultron-refactor` (a meta agent
        // not pertinent to this intent).
        let hits = vec![
            catalog::CatalogHit {
                entity: "agent".into(),
                name: "ultron-refactor".into(),
                description: "meta refactor".into(),
                score: 0.90,
                kind: String::new(),
            },
            catalog::CatalogHit {
                entity: "agent".into(),
                name: "debugger".into(),
                description: "systematic debugging".into(),
                score: 0.80,
                kind: String::new(),
            },
        ];
        let ranked = rebalance_delegates(hits, "bug_fix", 5);
        assert_eq!(
            ranked[0].name, "debugger",
            "preferred specialist must outrank a non-pertinent meta agent"
        );
        assert_eq!(ranked[1].name, "ultron-refactor");
        // ultron-refactor demoted: 0.90 * META_PENALTY < 0.90
        assert!(ranked[1].score < 0.90);
    }

    #[test]
    fn rebalance_waives_penalty_for_pertinent_meta() {
        // For the `docs` intent, `ultron-docs` IS a preferred specialist, so it
        // must NOT be penalised — it should be boosted instead.
        let hits = vec![catalog::CatalogHit {
            entity: "agent".into(),
            name: "ultron-docs".into(),
            description: "refresh docs".into(),
            score: 0.50,
            kind: String::new(),
        }];
        let ranked = rebalance_delegates(hits, "docs", 5);
        assert_eq!(ranked[0].name, "ultron-docs");
        assert!(
            ranked[0].score > 0.50,
            "pertinent meta agent should be boosted, not penalised"
        );
    }

    // Real e2e: needs ultron_catalog + ultron_memory indexed (run after the
    // catalog + memory e2e). Run: cargo test --lib -- --ignored --nocapture e2e_orchestrate
    #[test]
    #[ignore = "e2e: real catalog + memory + E5"]
    fn e2e_orchestrate_real() {
        let ctx = orchestrate(
            "revisa el código en busca de fallos de seguridad",
            Some("ultron"),
        );
        eprintln!("\n=== ORCHESTRATE route={} ===", ctx.route);
        eprintln!("workflow: {:?}", ctx.workflow.as_ref().map(|w| &w.id));
        eprintln!("delegate agents:");
        for a in &ctx.delegate_agents {
            eprintln!("  [{:.3}] {}", a.score, a.name);
        }
        eprintln!("memories injected: {}", ctx.memories.len());
        for w in &ctx.warnings {
            eprintln!("  warn: {w}");
        }
        assert_eq!(ctx.route, "security");
        assert!(ctx.workflow.is_some(), "a workflow must be selected");
        assert!(
            !ctx.delegate_agents.is_empty(),
            "agents to delegate must be found"
        );
        assert!(
            ctx.delegate_agents
                .iter()
                .take(5)
                .any(|a| a.name.contains("security")
                    || a.name.contains("review")
                    || a.name.contains("pentest")),
            "a security/review specialist should be selected"
        );
    }
}
