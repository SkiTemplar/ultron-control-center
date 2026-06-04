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
            "refactor",
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
    let delegate_agents: Vec<AgentChoice> = catalog::search_catalog(prompt, Some("agent"), 5)
        .into_iter()
        .map(|h| AgentChoice {
            name: h.name,
            description: h.description,
            score: h.score,
        })
        .collect();
    if delegate_agents.is_empty() {
        warnings.push("agent catalog empty/unavailable — run `catalog_reindex`".to_string());
    }

    // Relevant memories via hybrid recall (already token-budgeted).
    let memories = match build_trace(prompt, 6, project_id) {
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
