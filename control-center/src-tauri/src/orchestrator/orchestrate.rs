// orchestrator/orchestrate.rs — main orchestrate() function.

use crate::agent_orchestration::list_workflows_inner;
use crate::commands::memory::recall_unified::build_trace;
use crate::memory::catalog;

use super::ranking::{inject_preferred_floor, rank_skills, rebalance_delegates};
use super::rules::{classify_intent, detect_cross_project};
use super::types_model::{
    AgentChoice, OrchestrationContext, SkillChoice, WorkflowChoice, TOKEN_BUDGET,
};

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

    let prompt_plan = super::ranking::build_prompt_plan(prompt, intent);

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
    }
}
