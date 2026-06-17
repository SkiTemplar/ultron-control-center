// orchestrator/types_model.rs — public types and constants.

use serde::Serialize;

use crate::commands::memory::recall_unified::RecallEntry;

pub const TOKEN_BUDGET: i64 = 2000;

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
    /// Mejora de prompt (cat13 / pilar 6, 2026-06-10): plan determinista que
    /// convierte el prompt en una tarea ejecutable — reescritura con el
    /// encuadre del intent, modo sugerido, preguntas de clarificacion si es
    /// demasiado vago, y criterios de exito. Sin LLM (<1ms), siempre presente.
    pub prompt_plan: PromptPlan,
}

/// Salida del paso de mejora de prompt (diseño A de CONTINUAR.md 2026-06-08:
/// paso en `orchestrate()` del sidecar, visible en el visor y en el hook —
/// NO una skill huerfana). Rule-based: barato, reproducible, sin red.
#[derive(Debug, Clone, Serialize)]
pub struct PromptPlan {
    /// Prompt reescrito con el encuadre de trabajo del intent detectado.
    pub improved_prompt: String,
    /// Modo ULTRON sugerido: low | medium | high | ultra.
    pub suggested_mode: String,
    /// Preguntas a responder antes de ejecutar cuando el prompt es vago.
    pub clarifying_questions: Vec<String>,
    /// Criterios de exito derivados del intent (verificables, no decorativos).
    pub success_criteria: Vec<String>,
}
