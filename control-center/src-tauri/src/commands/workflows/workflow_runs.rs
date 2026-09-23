// ULTRON Control Center — Workflow run + YAML loader commands (KIRKARDO 23 P2).
//
// Exposes two commands to the frontend:
//
//   workflow_get_runs         — list runs with optional filters
//   workflow_load_user_defined — merged user + built-in workflow list
//
// workflow_record_run / workflow_update_run existían aquí como wrappers Tauri
// pero nunca tuvieron llamador en la UI (el escritor real de runs es
// batches.rs, que llama a `workflow_runs::record_run_inner`/`update_run_inner`
// directamente) — podados 2026-09-23. workflow_set_state/workflow_get_state
// (Workflow State #6) se podaron con ellos: sin comando vivo que los usara,
// el side-channel `state_json` se eliminó también.

use crate::agent_orchestration::{self, WorkflowDefinition};
use crate::workflow_loader;
use crate::workflow_runs::{self, WorkflowRun};

// ---------------------------------------------------------------------------
// List runs
// ---------------------------------------------------------------------------

/// Return workflow runs newest-first, optionally filtered by `workflow_id`
/// and/or `project_id`. `limit` defaults to 50 and is capped at 500.
#[tauri::command]
pub async fn workflow_get_runs(
    workflow_id: Option<String>,
    project_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<WorkflowRun>, String> {
    let cap = limit.unwrap_or(50);
    tauri::async_runtime::spawn_blocking(move || {
        workflow_runs::list_runs_inner(workflow_id, project_id, cap)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Load merged workflow list
// ---------------------------------------------------------------------------

/// Return the merged list of built-in and user-defined workflows.
///
/// User workflows loaded from `~/.ultron/cockpit/workflows/*.yaml` take
/// priority over built-ins on `id` collision. Built-ins that are not
/// overridden are appended after the user-defined ones.
///
/// Files that fail to parse or validate are skipped with a stderr warning —
/// the call always succeeds, returning at minimum the seven built-ins.
#[tauri::command]
pub async fn workflow_load_user_defined() -> Result<Vec<WorkflowDefinition>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let user = workflow_loader::load_user_workflows().unwrap_or_else(|e| {
            eprintln!("[workflow_load_user_defined] load error: {e}");
            vec![]
        });
        let builtin = agent_orchestration::list_workflows_inner();
        Ok(workflow_loader::merge_with_builtin(user, builtin))
    })
    .await
    .map_err(|e| e.to_string())?
}
