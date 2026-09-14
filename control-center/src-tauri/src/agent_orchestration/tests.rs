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
