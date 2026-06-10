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

/// Prefer items of the requested project, accept GLOBAL items (no project),
/// drop everything else; `project = None` keeps the original cross-project
/// behaviour. Generic + pure so it is unit-testable without a MemoryItem.
///
/// Fix Kirkardo Pass3 HIGH (2026-06-10): the resume DECLARED a project_id but
/// injected decisions/tasks/pinned from EVERY project (mandamiento 13 —
/// declara el alcance real). The store API has no project filter, so callers
/// over-fetch a wide window and this narrows it.
fn prefer_project<T>(
    items: Vec<T>,
    project: Option<&str>,
    limit: usize,
    proj_of: impl Fn(&T) -> Option<String>,
) -> Vec<T> {
    match project {
        None => items.into_iter().take(limit).collect(),
        Some(p) => {
            let (mine, rest): (Vec<T>, Vec<T>) = items
                .into_iter()
                .partition(|it| proj_of(it).as_deref() == Some(p));
            let global = rest.into_iter().filter(|it| proj_of(it).is_none());
            mine.into_iter().chain(global).take(limit).collect()
        }
    }
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

    // Over-fetch (the store lists newest-first without project filter), then
    // narrow to the requested project + global items.
    let proj = project_id.as_deref();
    let decisions = to_resume(prefer_project(
        MemoryService::list_active_of_type(MemoryType::Decision, 96).map_err(|e| e.to_string())?,
        proj,
        8,
        |it| it.project_id.clone(),
    ));
    let open_tasks = to_resume(prefer_project(
        MemoryService::list_active_of_type(MemoryType::Task, 96).map_err(|e| e.to_string())?,
        proj,
        12,
        |it| it.project_id.clone(),
    ));
    let pinned = to_resume(prefer_project(
        MemoryService::list_pinned(48).map_err(|e| e.to_string())?,
        proj,
        12,
        |it| it.project_id.clone(),
    ));
    let stats = MemoryService::stats().map_err(|e| e.to_string())?;

    let next_action = open_tasks
        .first()
        .and_then(|t| t.summary.clone())
        .or_else(|| {
            active_workflows
                .first()
                .map(|w| format!("continue workflow {}", w.workflow_id))
        });

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

#[cfg(test)]
mod tests {
    use super::prefer_project;

    fn proj(it: &Option<String>) -> Option<String> {
        it.clone()
    }

    /// Pass3 HIGH — con proyecto: solo items del proyecto + globales, en ese
    /// orden; los de OTROS proyectos se descartan. Sin proyecto: passthrough.
    #[test]
    fn prefer_project_scopes_and_keeps_globals() {
        let items: Vec<Option<String>> = vec![
            Some("libro".into()),
            Some("ultron".into()),
            None,
            Some("bank".into()),
            Some("ultron".into()),
        ];

        let scoped = prefer_project(items.clone(), Some("ultron"), 8, proj);
        assert_eq!(
            scoped,
            vec![Some("ultron".to_string()), Some("ultron".to_string()), None],
            "proyecto primero, luego globales; otros proyectos fuera"
        );

        // Caso negativo: un proyecto sin items propios solo recibe globales.
        let only_global = prefer_project(items.clone(), Some("niajska"), 8, proj);
        assert_eq!(only_global, vec![None]);

        // Sin proyecto: comportamiento cross-project original (cap al limite).
        let cross = prefer_project(items, None, 3, proj);
        assert_eq!(cross.len(), 3);
        assert_eq!(cross[0], Some("libro".to_string()));
    }
}
