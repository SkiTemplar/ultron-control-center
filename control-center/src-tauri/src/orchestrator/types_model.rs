// orchestrator/types_model.rs — public types and constants.

use serde::Serialize;

use crate::commands::memory::recall_unified::RecallEntry;

/// Token budget cap for the orchestrated prompt context, summed across all
/// injected layers. Estimated breakdown (per layer, approximate):
///
///   - memories (recall hits):     ~1200 tokens
///   - agents (routing choices):    ~300 tokens
///   - skills (routing choices):    ~300 tokens
///   - overhead (headers/format):   ~200 tokens
///
/// Total: ~2000. Layers compete within this cap so the context stays bounded.
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
    /// cat13.4 (2026-06-19): cuando el routing propone un GRUPO (workflow
    /// multi-paso), cada paso/agente lleva su PROPIO encuadre derivado del
    /// sub-intent de su rol — no solo el encuadre global del turno. Vacio para
    /// turnos de un solo paso / sin workflow.
    pub step_plans: Vec<StepPlan>,
}

/// Encuadre optimizado POR PASO del grupo (cat13.4). `optimize_prompt`/
/// `build_prompt_plan` optimizan el TURNO; esto optimiza cada PASO del workflow
/// segun el rol del agente que lo ejecuta (debugger -> bug_fix, code-reviewer ->
/// review, rust-engineer -> feature, ...).
#[derive(Debug, Clone, Serialize)]
pub struct StepPlan {
    /// Agente especialista del paso (real, en ~/.claude/agents).
    pub agent: String,
    /// Sub-intent derivado del rol del agente.
    pub sub_intent: String,
    /// Encuadre de trabajo especifico de ese paso.
    pub frame: String,
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
