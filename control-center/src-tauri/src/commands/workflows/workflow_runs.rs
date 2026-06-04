// ULTRON Control Center — Workflow run + YAML loader commands (KIRKARDO 23 P2).
//
// Exposes four commands to the frontend:
//
//   workflow_record_run       — open a new run record, returns run_id
//   workflow_update_run       — patch status/progress/error on a run
//   workflow_get_runs         — list runs with optional filters
//   workflow_load_user_defined — merged user + built-in workflow list

use crate::agent_orchestration::{self, WorkflowDefinition};
use crate::workflow_loader;
use crate::workflow_runs::{self, RunStatus, RunUpdate, WorkflowRun, WorkflowState};

// ---------------------------------------------------------------------------
// Record a new run
// ---------------------------------------------------------------------------

/// Create a new workflow run record in the local SQLite DB.
///
/// Returns the auto-assigned integer `run_id` that the caller should pass to
/// `workflow_update_run` as the run progresses.
///
/// `started_at` is an optional ISO-8601 UTC timestamp string; when absent the
/// server clock is used. `steps_total` defaults to 0 when absent.
#[tauri::command]
pub async fn workflow_record_run(
    workflow_id: String,
    project_id: Option<String>,
    started_at: Option<String>,
    steps_total: Option<u32>,
) -> Result<i64, String> {
    let ts = started_at
        .as_deref()
        .map(|s| {
            s.parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|e| format!("invalid started_at '{s}': {e}"))
        })
        .transpose()?;

    tauri::async_runtime::spawn_blocking(move || {
        workflow_runs::record_run_inner(workflow_id, project_id, ts, steps_total.unwrap_or(0))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Update an existing run
// ---------------------------------------------------------------------------

/// Update mutable fields of a workflow run.
///
/// All payload fields are optional — only supplied fields are written. The
/// command returns the updated `WorkflowRun` record so the frontend can
/// refresh its local state in a single round-trip.
#[tauri::command]
pub async fn workflow_update_run(
    run_id: i64,
    status: Option<RunStatus>,
    steps_completed: Option<u32>,
    steps_total: Option<u32>,
    output_summary: Option<String>,
    error: Option<String>,
    ended_at: Option<String>,
) -> Result<WorkflowRun, String> {
    let ended_at_parsed = ended_at
        .as_deref()
        .map(|s| {
            s.parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|e| format!("invalid ended_at '{s}': {e}"))
        })
        .transpose()?;

    let payload = RunUpdate {
        status,
        steps_completed,
        steps_total,
        output_summary,
        error,
        ended_at: ended_at_parsed,
    };

    tauri::async_runtime::spawn_blocking(move || workflow_runs::update_run_inner(run_id, payload))
        .await
        .map_err(|e| e.to_string())?
}

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

// ---------------------------------------------------------------------------
// Workflow State (#6) — persist/recover rich run state
// ---------------------------------------------------------------------------

/// Persist the rich state of a workflow run (current step, next action, agents/
/// skills used, associated memories, files touched, blockers, decisions, errors).
#[tauri::command]
pub async fn workflow_set_state(run_id: i64, state: WorkflowState) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workflow_runs::set_run_state(run_id, &state))
        .await
        .map_err(|e| e.to_string())?
}

/// Read the rich state of a workflow run (for resume / continue).
#[tauri::command]
pub async fn workflow_get_state(run_id: i64) -> Result<WorkflowState, String> {
    tauri::async_runtime::spawn_blocking(move || workflow_runs::get_run_state(run_id))
        .await
        .map_err(|e| e.to_string())?
}
