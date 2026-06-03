// commands/memory/session_resume.rs — Session Resume (req #5 / FASE 9 SessionStart)
//
// Loads a MINIMAL, bounded resume context when (re)opening a session — never the
// whole history. Pulls from the canonical store: active workflows, recent active
// decisions, open tasks, pinned memories, pending-candidate count, and a derived
// next action. Backend-first; a SessionStart hook can call this command.

use serde::Serialize;

use crate::memory::{MemoryItem, MemoryService, MemoryType};
use crate::workflow_runs::{list_runs_inner, RunStatus, WorkflowRun};

/// Compact memory shape for the resume context (summary only, lazy content).
#[derive(Debug, Clone, Serialize)]
pub struct ResumeMemory {
    pub canonical_id: String,
    pub kind: String,
    pub summary: Option<String>,
    pub project_id: Option<String>,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionResume {
    pub project_id: Option<String>,
    pub active_workflows: Vec<WorkflowRun>,
    pub decisions: Vec<ResumeMemory>,  // active, recent
    pub open_tasks: Vec<ResumeMemory>, // active
    pub pinned: Vec<ResumeMemory>,     // user-pinned, always surfaced
    pub pending_candidates: i64,
    pub next_action: Option<String>,
    pub warnings: Vec<String>,
}

fn to_resume(items: Vec<MemoryItem>) -> Vec<ResumeMemory> {
    items
        .into_iter()
        .map(|it| ResumeMemory {
            canonical_id: it.id,
            kind: it.kind.as_str().to_string(),
            summary: it.summary,
            project_id: it.project_id,
            pinned: it.pinned,
        })
        .collect()
}

/// Sync core of session resume — reused by the CLI sidecar (`ultron-memory
/// resume`) and the Tauri command. Loads only MINIMAL, bounded slices.
pub fn session_resume_inner(project_id: Option<String>) -> Result<SessionResume, String> {
    // Active (running) workflows for the project — bounded list.
    let active_workflows: Vec<WorkflowRun> = list_runs_inner(None, project_id.clone(), 50)
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.status == RunStatus::Running)
        .collect();

    let decisions = to_resume(
        MemoryService::list_active_of_type(MemoryType::Decision, 8).map_err(|e| e.to_string())?,
    );
    let open_tasks = to_resume(
        MemoryService::list_active_of_type(MemoryType::Task, 12).map_err(|e| e.to_string())?,
    );
    let pinned = to_resume(MemoryService::list_pinned(12).map_err(|e| e.to_string())?);
    let stats = MemoryService::stats().map_err(|e| e.to_string())?;

    let next_action = open_tasks
        .first()
        .and_then(|t| t.summary.clone())
        .or_else(|| active_workflows.first().map(|w| format!("continue workflow {}", w.workflow_id)));

    let mut warnings = Vec::new();
    if stats.candidates_pending > 0 {
        warnings.push(format!(
            "{} memory candidate(s) await validation in the inbox",
            stats.candidates_pending
        ));
    }

    Ok(SessionResume {
        project_id,
        active_workflows,
        decisions,
        open_tasks,
        pinned,
        pending_candidates: stats.candidates_pending,
        next_action,
        warnings,
    })
}

/// Bounded session resume. `project_id = None` = cross-project.
#[tauri::command]
pub async fn session_resume(project_id: Option<String>) -> Result<SessionResume, String> {
    tauri::async_runtime::spawn_blocking(move || session_resume_inner(project_id))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}
