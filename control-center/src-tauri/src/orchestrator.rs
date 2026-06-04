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
            "gameplay",
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

/// Classify a prompt into `(intent, workflow_id)`. Default = general/quick.
pub fn classify_intent(prompt: &str) -> (&'static str, &'static str) {
    let p = prompt.to_lowercase();
    for r in RULES {
        if r.patterns.iter().any(|pat| p.contains(pat)) {
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

/// Multiplicative penalty applied to META agents during delegate ranking.
const META_PENALTY: f32 = 0.55;
/// Additive boost applied to agents the detected intent/workflow prefers.
const SPECIALIST_BOOST: f32 = 0.20;

/// Specialist agent names the detected `intent` should prioritise. These are
/// REAL agents in `~/.claude/agents` (verified). The boost lifts them above the
/// meta agents when the prompt clearly belongs to their domain.
fn preferred_specialists(intent: &str) -> &'static [&'static str] {
    match intent {
        "security" => &["security-auditor", "penetration-tester", "ultron-security", "code-reviewer"],
        "bug_fix" => &["debugger", "error-detective", "qa-expert"],
        "performance" => &["performance-engineer", "ultron-perf", "debugger"],
        "testing" => &["test-automator", "qa-expert", "code-reviewer"],
        "ui_design" => &[
            "frontend-developer",
            "react-specialist",
            "ui-designer",
            "accessibility-tester",
        ],
        "docs" => &["documentation-engineer", "ultron-docs"],
        "refactor" => &["refactoring-specialist", "ultron-refactor", "code-reviewer"],
        "architecture_review" => &["architect-reviewer", "ultron-arch"],
        "feature" => &["architect-reviewer", "fullstack-developer", "code-reviewer"],
        "research" => &["ai-engineer", "llm-architect", "architect-reviewer"],
        "game" => &["unreal-engine-engineer", "cpp-pro", "architect-reviewer"],
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
            let mut score = h.score;
            // Demote meta agents that are not pertinent to this intent.
            if is_meta && !is_preferred {
                score *= META_PENALTY;
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
    let raw_hits = catalog::search_catalog(prompt, Some("agent"), 12);
    let delegate_agents: Vec<AgentChoice> = rebalance_delegates(raw_hits, intent, 5);
    if delegate_agents.is_empty() {
        warnings.push("agent catalog empty/unavailable — run `catalog_reindex`".to_string());
    }

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
    let memories = match build_trace(prompt, 12, project_id, cross_project) {
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
