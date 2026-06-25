// orchestrator/orchestrate.rs — main orchestrate() function.

use crate::agent_orchestration::list_workflows_inner;
use crate::commands::memory::recall_unified::build_trace;
use crate::memory::catalog;

use super::ranking::{inject_preferred_floor, rank_skills, rebalance_delegates};
use super::rules::{classify_intent, detect_cross_project};
use super::types_model::{
    AgentChoice, OrchestrationContext, SkillChoice, WorkflowChoice, FORMAT_OVERHEAD_TOKENS,
    TOKEN_BUDGET,
};

/// `dense_enabled` controls whether the semantic (E5) paths run. The
/// UserPromptSubmit hot path passes `false`: agents/skills route by intent rules
/// and recall is sparse-only (FTS5), keeping the whole call E5-free so it fits
/// the <300ms hook budget. Quality callers can pass `true` for the full semantic
/// catalog + hybrid recall (an E5 query embed costs ~1.1s on CPU even warm).
pub fn orchestrate(
    prompt: &str,
    project_id: Option<&str>,
    dense_enabled: bool,
) -> OrchestrationContext {
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

    // Real specialists to DELEGATE to. With dense_enabled we semantic-match over
    // the agent catalog (E5) and over-fetch; on the sparse-first hot path we skip
    // the E5 embed entirely and let inject_preferred_floor seed the intent's
    // preferred specialists by rule. Either way rebalance keeps the meta
    // ULTRON-internal agents from crowding out the real specialists.
    let raw_hits = if dense_enabled {
        catalog::search_catalog(prompt, Some("agent"), 16)
    } else {
        Vec::new()
    };
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
    let skill_hits = if dense_enabled {
        catalog::search_catalog(prompt, Some("skill"), 10)
    } else {
        Vec::new()
    };
    let delegate_skills: Vec<SkillChoice> = rank_skills(skill_hits, intent, 4);

    // CROSS-PROJECT auto-detect: a no-op without a current project (cross-project
    // is meaningless then). When the prompt asks about another / all projects we
    // widen recall to the whole brain — security gates (Secret excluded) untouched.
    let cross_project = project_id.is_some() && detect_cross_project(prompt);
    if cross_project {
        warnings.push(
            "cross-project recall — searching the whole brain (other projects included)"
                .to_string(),
        );
    }

    // Relevant memories. On the hot path (dense_enabled=false) recall is SPARSE-
    // first: an E5-large query embed (~1.1s on CPU even with the daemon warm)
    // blows the latency budget, so FTS5 sparse + the confidence/recency re-ranker
    // carry it. Quality callers (dense_enabled=true) and the manual Memory Browser
    // (recall_unified command) keep full hybrid recall.
    let memories = match build_trace(prompt, 12, project_id, cross_project, dense_enabled) {
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

    // cat13.2: optimize_prompt is the canonical optimizer (alias of
    // build_prompt_plan) — the routing optimizes the prompt before building the plan.
    let prompt_plan = super::ranking::optimize_prompt(prompt, intent);

    // cat13.4: when the routing proposes a multi-step GROUP (workflow), optimize
    // each step's prompt by the role sub-intent of the agent that runs it. Empty
    // for a single-step / no-workflow turn (optimize_prompt already covers that).
    let step_plans = workflow
        .as_ref()
        .map(|w| super::ranking::build_step_plans(&w.steps))
        .unwrap_or_default();

    // cat16.4: TOKEN_BUDGET es ahora un presupuesto COMPARTIDO entre las 4 capas
    // inyectadas (antes los caps por capa 12/5/4/6 lo ignoraban y el campo
    // token_budget era decorativo). Se reparte por prioridad — memories primero,
    // luego agents/skills/step_plans — reservando ~200 tokens de overhead de
    // formato (ver types_model::TOKEN_BUDGET). Si el presupuesto alcanza para
    // todo lo ya seleccionado, no recorta nada.
    let (memories, delegate_agents, delegate_skills, step_plans) =
        super::ranking::apply_token_budget(
            memories,
            delegate_agents,
            delegate_skills,
            step_plans,
            TOKEN_BUDGET,
            FORMAT_OVERHEAD_TOKENS,
        );

    // Delegación automática (plano chat, 2026-06-23): si el intent es delegable y
    // la tarea no-trivial, emite una directiva imperativa con el especialista top
    // ya rankeado y el prompt optimizado como objetivo. None = sin delegación.
    //
    // Fix 2026-06-25: la DIRECTIVA se ancla al primer especialista canónico
    // de `preferred_specialists(intent)` que esté presente en `delegate_agents`,
    // en lugar de al [0] reordenado por E5 (que puede subir cpp-pro sobre
    // rust-engineer, etc.). La lista visible `delegate_agents` no cambia.
    let directive_agent = super::ranking::preferred_specialists(intent)
        .iter()
        .find_map(|p| delegate_agents.iter().find(|a| a.name == *p))
        .or_else(|| delegate_agents.first());
    let delegation_directive = super::delegation::decide_delegation(
        intent,
        prompt,
        &prompt_plan.improved_prompt,
        directive_agent,
    );

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
        prompt_plan,
        step_plans,
        delegation_directive,
    }
}
