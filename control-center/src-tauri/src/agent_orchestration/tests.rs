// agent_orchestration/tests.rs — unit tests for the agent_orchestration module.
//
// The delegate/provider_router test coverage (validate_agent_slug,
// validate_delegate_request, strip_ansi, resolve_cheap_model, sentinel
// detection...) was retired alongside those modules (2026-09-14, kanban
// "comandos huérfanos" — delegate_task_launch had zero frontend callers).
// Recoverable from git history if the feature gets wired to a UI later.

use super::workflows::list_workflows_inner;

// ------------------------------------------------------------------
// list_workflows_inner
// ------------------------------------------------------------------

#[test]
fn list_workflows_contains_canonical_seven() {
    // list_workflows_inner() returns only the built-in set (>= 7 entries).
    // The merged list (user + built-ins) may exceed 7 when the user has
    // YAML files in ~/.ultron/cockpit/workflows/ — that path is tested in
    // workflow_loader::tests. Here we only assert the built-in floor.
    let wf = list_workflows_inner();
    assert!(
        wf.len() >= 7,
        "expected at least 7 built-in workflows, got {}",
        wf.len()
    );
    let ids: Vec<&str> = wf.iter().map(|w| w.id.as_str()).collect();
    for required in [
        "quick", "feature", "debug", "security", "research", "game", "learning",
    ] {
        assert!(
            ids.contains(&required),
            "missing workflow id '{}'",
            required
        );
    }
}

/// Los pasos delegan por subagent_type en agentes de ~/.claude/agents/: un id
/// con espacio de nombres de plugin (`plugin:agente`) depende de un plugin
/// instalado. `agent-skills:security-auditor` no lo estaba (2026-10-23).
#[test]
fn ningun_paso_apunta_a_un_agente_de_plugin() {
    let plugin_steps: Vec<String> = list_workflows_inner()
        .iter()
        .flat_map(|w| {
            w.steps
                .iter()
                .map(move |s| format!("{}: {}", w.id, s.agent))
        })
        .filter(|s| s.split_once(": ").is_some_and(|(_, a)| a.contains(':')))
        .collect();
    assert!(plugin_steps.is_empty(), "{plugin_steps:?}");
}
