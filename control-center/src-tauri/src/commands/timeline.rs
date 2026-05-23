// Per-project timeline aggregator command.
//
// `project_timeline_list` walks kanban + claude session jsonl + backup
// snapshots and produces a chronological feed. Read-only and cheap to
// recompute, so the frontend can refresh it on demand.

use crate::timeline;

#[tauri::command]
pub async fn project_timeline_list(
    project_id: String,
    project_path: Option<String>,
) -> Result<Vec<timeline::TimelineEvent>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(timeline::list_inner(&project_id, project_path.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}
