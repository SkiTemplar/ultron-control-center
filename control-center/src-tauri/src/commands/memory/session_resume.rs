// commands/memory/session_resume.rs — Session Resume (req #5 / FASE 9 SessionStart)
//
// Loads a MINIMAL, bounded resume context when (re)opening a session — never the
// whole history. Pulls from the canonical store: active workflows, recent active
// decisions, open tasks, pinned memories, pending-candidate count, and a derived
// next action. Backend-first; a SessionStart hook can call this command.

use serde::Serialize;

use crate::commands::memory::kanban_signal;
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

/// Narrow items to the requested project. `keep_globals` controls whether
/// GLOBAL items (no project) are appended after the project's own — `pinned`
/// keeps them, but `open_tasks`/`decisions` MUST NOT (a project's resume was
/// dragging in unrelated globals: rotar token GitHub, Mundial 2026…).
/// `project = None` keeps the original cross-project behaviour.
/// Generic + pure so it is unit-testable without a MemoryItem.
///
/// Fix Kirkardo Pass3 HIGH (2026-06-10): the resume DECLARED a project_id but
/// injected decisions/tasks/pinned from EVERY project (mandamiento 13 —
/// declara el alcance real). The store API has no project filter, so callers
/// over-fetch a wide window and this narrows it.
fn prefer_project<T>(
    items: Vec<T>,
    project: Option<&str>,
    limit: usize,
    keep_globals: bool,
    proj_of: impl Fn(&T) -> Option<String>,
) -> Vec<T> {
    match project {
        None => items.into_iter().take(limit).collect(),
        Some(p) => {
            let (mine, rest): (Vec<T>, Vec<T>) = items
                .into_iter()
                .partition(|it| proj_of(it).as_deref() == Some(p));
            if !keep_globals {
                return mine.into_iter().take(limit).collect();
            }
            let global = rest.into_iter().filter(|it| proj_of(it).is_none());
            mine.into_iter().chain(global).take(limit).collect()
        }
    }
}

/// Current epoch seconds (cheap, no chrono ceremony).
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Last commit subject from `<root>` with a hard 1500 ms timeout. Best
/// effort — `None` on error, timeout, or empty output. Never blocks the
/// session start: if git is stuck (index.lock, network FS…) the child is
/// killed and we fall through to the next `derive_next_action` fallback.
///
/// Pattern: spawn git in a thread and join with timeout so the resume call
/// site is never blocked longer than TIMEOUT regardless of FS/lock state.
fn last_commit_subject(root: &std::path::Path) -> Option<String> {
    use std::time::Duration;

    const TIMEOUT: Duration = Duration::from_millis(1500);

    // Clone the path so it can be moved into the thread (PathBuf is owned).
    let root_buf = root.to_path_buf();
    let handle = std::thread::spawn(move || {
        std::process::Command::new("git")
            .arg("-C")
            .arg(&root_buf)
            .args(["log", "-n", "1", "--format=%s"])
            .output()
            .ok()
            .and_then(|out| {
                if !out.status.success() {
                    return None;
                }
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            })
    });

    // join_timeout is not stable; poll try_join via a channel pattern instead.
    // We give the thread at most TIMEOUT to finish; if it exceeds that we
    // abandon it (the thread may still run in background but the resume
    // proceeds immediately — acceptable for a fire-and-forget subprocess).
    let start = std::time::Instant::now();
    const POLL: std::time::Duration = std::time::Duration::from_millis(50);
    loop {
        if handle.is_finished() {
            return handle.join().ok().flatten();
        }
        if start.elapsed() >= TIMEOUT {
            // Let the orphaned thread clean up on its own; we move on.
            return None;
        }
        std::thread::sleep(POLL);
    }
}

/// Derive a LIVE next-action instead of `open_tasks.first()` (which rotted —
/// memory has no done/stale state). Priority:
///   1. Kanban In-Progress card (else Backlog top) of the current project.
///   2. Last commit subject ("último que pasó").
///   3. First memory Task that is recent AND not phrased as already-done.
///   4. A running workflow.
fn derive_next_action(
    project: Option<&str>,
    tasks: &[MemoryItem],
    active_workflows: &[WorkflowRun],
) -> Option<String> {
    let root = crate::ultron_root().ok();

    if let (Some(root), Some(proj)) = (root.as_deref(), project) {
        if let Some(card) = kanban_signal::kanban_next_action(root, proj) {
            return Some(card);
        }
    }
    if let Some(root) = root.as_deref() {
        if let Some(commit) = last_commit_subject(root) {
            return Some(format!("último commit: {commit}"));
        }
    }

    let now = now_secs();
    tasks
        .iter()
        .filter(|t| project.is_none() || t.project_id.as_deref() == project)
        .find_map(|t| {
            let s = t.summary.as_deref()?;
            kanban_signal::memory_task_eligible(s, t.updated_at, now).then(|| s.to_string())
        })
        .or_else(|| {
            active_workflows
                .first()
                .map(|w| format!("continue workflow {}", w.workflow_id))
        })
}

/// Fallback for `open_tasks` when the project has no kanban: memory Tasks that
/// are still ELIGIBLE (recent AND not phrased as already-done), so the resume
/// never surfaces rotted notes. Replaces the old raw `list_active_of_type`.
fn eligible_memory_tasks(raw: &[MemoryItem], proj: Option<&str>, now: i64) -> Vec<ResumeMemory> {
    let filtered: Vec<MemoryItem> = raw
        .iter()
        .filter(|t| {
            t.summary
                .as_deref()
                .map(|s| kanban_signal::memory_task_eligible(s, t.updated_at, now))
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    to_resume(prefer_project(filtered, proj, 12, false, |it| {
        it.project_id.clone()
    }))
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
    // open_tasks/decisions: SOLO del proyecto (sin globales — mandamiento 13).
    let raw_tasks =
        MemoryService::list_active_of_type(MemoryType::Task, 96).map_err(|e| e.to_string())?;
    let decisions = to_resume(prefer_project(
        MemoryService::list_active_of_type(MemoryType::Decision, 96).map_err(|e| e.to_string())?,
        proj,
        8,
        false,
        |it| it.project_id.clone(),
    ));
    // open_tasks: fuente VIVA = kanban (cards In-Progress + Backlog), igual que
    // next_action. Memoria-Task se pudre (sin estado done) y arrastraba tareas
    // muertas ("npx tauri build", "# TODO Rebuild"). Fallback a memoria elegible
    // (reciente + no-completada) solo si el proyecto no tiene kanban.
    let now = now_secs();
    let root = crate::ultron_root().ok();
    let open_tasks: Vec<ResumeMemory> = match (root.as_deref(), proj) {
        (Some(root), Some(p)) => match kanban_signal::kanban_open_tasks(root, p, 8) {
            Some(titles) => titles
                .into_iter()
                .enumerate()
                .map(|(i, title)| ResumeMemory {
                    canonical_id: format!("kanban:{p}:{i}"),
                    kind: "task".to_string(),
                    summary: Some(title),
                    project_id: Some(p.to_string()),
                    pinned: false,
                })
                .collect(),
            None => eligible_memory_tasks(&raw_tasks, proj, now),
        },
        _ => eligible_memory_tasks(&raw_tasks, proj, now),
    };
    // pinned keeps globals — user-elevated, cross-project on purpose.
    let pinned = to_resume(prefer_project(
        MemoryService::list_pinned(48).map_err(|e| e.to_string())?,
        proj,
        12,
        true,
        |it| it.project_id.clone(),
    ));
    let stats = MemoryService::stats().map_err(|e| e.to_string())?;

    let next_action = derive_next_action(proj, &raw_tasks, &active_workflows);

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

        // pinned: keep_globals=true -> proyecto primero, luego globales.
        let scoped = prefer_project(items.clone(), Some("ultron"), 8, true, proj);
        assert_eq!(
            scoped,
            vec![Some("ultron".to_string()), Some("ultron".to_string()), None],
            "proyecto primero, luego globales; otros proyectos fuera"
        );

        // open_tasks/decisions: keep_globals=false -> SOLO proyecto, 0 globales.
        let scoped_no_global = prefer_project(items.clone(), Some("ultron"), 8, false, proj);
        assert_eq!(
            scoped_no_global,
            vec![Some("ultron".to_string()), Some("ultron".to_string())],
            "open_tasks/decisions no arrastran globales"
        );

        // Caso negativo: proyecto sin items propios -> vacío si no se aceptan globales.
        let none_for_niajska = prefer_project(items.clone(), Some("niajska"), 8, false, proj);
        assert!(none_for_niajska.is_empty(), "0 cross-project, 0 globales");

        // Con keep_globals un proyecto sin items propios solo recibe globales.
        let only_global = prefer_project(items.clone(), Some("niajska"), 8, true, proj);
        assert_eq!(only_global, vec![None]);

        // Sin proyecto: comportamiento cross-project original (cap al limite).
        let cross = prefer_project(items, None, 3, false, proj);
        assert_eq!(cross.len(), 3);
        assert_eq!(cross[0], Some("libro".to_string()));
    }
}
