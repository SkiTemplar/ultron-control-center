// ULTRON Control Center - Workdays command wrappers (v2.8 automatic surface)
use crate::workdays::{
    self, DrainReport, GoalStatus, PendingLink, Workday, WorkdayMetrics, WorkdayTemplate,
    WorkdayTodayView, WorkflowTemplate,
};

#[tauri::command]
pub async fn create_workday(title: String, planned_date: Option<String>, template_id: Option<String>, goals: Option<Vec<String>>) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::create_workday_inner(title, planned_date, template_id, goals)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn start_workday(id: String, energy_before: Option<u8>) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::start_workday_inner(id, energy_before)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn pause_workday(id: String, break_seconds_delta: Option<u64>) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::pause_workday_inner(id, break_seconds_delta)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn resume_workday(id: String) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::resume_workday_inner(id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn complete_workday(id: String, focus_seconds: Option<u64>, energy_after: Option<u8>, mood_note: Option<String>, retro_good: Option<String>, retro_bad: Option<String>, retro_learned: Option<String>) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::complete_workday_inner(id, focus_seconds, energy_after, mood_note, retro_good, retro_bad, retro_learned)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn archive_workday(id: String) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::archive_workday_inner(id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn list_workdays(status_filter: Option<String>, date_from: Option<String>, date_to: Option<String>, limit: Option<usize>) -> Result<Vec<Workday>, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::list_workdays_inner(status_filter, date_from, date_to, limit)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn get_workday_detail(id: String) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::get_workday_detail_inner(id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn get_workday_metrics(id: String) -> Result<WorkdayMetrics, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::get_workday_metrics_inner(id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn link_session(id: String, session_id: String) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::link_session_inner(id, session_id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn link_task(id: String, task_id: String) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::link_task_inner(id, task_id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn list_templates() -> Result<Vec<WorkdayTemplate>, String> {
    tauri::async_runtime::spawn_blocking(workdays::list_templates_inner).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn save_template(name: String, default_title: Option<String>, default_goals: Option<Vec<String>>, notes: Option<String>) -> Result<WorkdayTemplate, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::save_template_inner(name, default_title, default_goals, notes)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn update_goal(workday_id: String, goal_id: String, status: GoalStatus, text: Option<String>) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::update_goal_inner(workday_id, goal_id, status, text)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn workday_list(limit: Option<usize>) -> Result<Vec<Workday>, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::workday_list_inner(limit)).await.map_err(|e| e.to_string())?
}

// -- T2 -- Sessions <-> Workdays auto-link drainer ----------------------------

#[tauri::command]
pub async fn workday_pending_link_record(
    session_id: String,
    cwd: Option<String>,
) -> Result<PendingLink, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workdays::append_pending_link_inner(session_id, cwd)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workday_drain_pending_links() -> Result<DrainReport, String> {
    tauri::async_runtime::spawn_blocking(workdays::drain_pending_links_inner)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workday_auto_link_session(
    session_id: String,
    cwd: Option<String>,
) -> Result<DrainReport, String> {
    // High-level entrypoint the JS hook uses while the Control Center is
    // running: record the link and immediately try to drain. The hook gets
    // a single deterministic response -- `linked >= 1` means the session is
    // now wired to a workday.
    tauri::async_runtime::spawn_blocking(move || {
        workdays::append_pending_link_inner(session_id, cwd)?;
        workdays::drain_pending_links_inner()
    })
    .await
    .map_err(|e| e.to_string())?
}

// -- Automatic surface (2026-05-26 redesign) ---------------------------------

/// Get or create today's `in_progress` workday for the given project. Used
/// by spawn hooks and the kanban dispatch path so any activity inside a
/// project automatically opens a workday without user intervention.
#[tauri::command]
pub async fn workday_auto_start_for_project(
    project_id: String,
    cwd: Option<String>,
    workflow_template: Option<String>,
) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workdays::auto_start_for_project_inner(project_id, cwd, workflow_template)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Auto-resolve `cwd` -> project, auto-start its workday, link the session.
/// Returns `None` when `cwd` doesn't match any registered project (we
/// deliberately don't create orphan workdays for arbitrary directories).
#[tauri::command]
pub async fn workday_auto_for_session(
    session_id: String,
    cwd: String,
) -> Result<Option<Workday>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workdays::auto_workday_for_session_inner(session_id, cwd)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Append a shared-context entry to a workday. Agents / sessions / scripts
/// use this to leave notes, decisions, file-change logs, or agent messages
/// for the next invocation.
#[tauri::command]
pub async fn workday_append_context(
    workday_id: String,
    kind: String,
    text: String,
    source: Option<String>,
) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workdays::append_context_inner(workday_id, kind, text, source)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Record a kanban card movement against today's active workday. Done moves
/// add a completed goal; other moves append a context note.
#[tauri::command]
pub async fn workday_record_kanban_event(
    project_id: String,
    card_id: String,
    card_title: String,
    target_column: String,
) -> Result<Option<Workday>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workdays::record_kanban_event_inner(project_id, card_id, card_title, target_column)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Today's timeline -- active workday + any other workdays dated today.
#[tauri::command]
pub async fn workday_today_timeline() -> Result<WorkdayTodayView, String> {
    tauri::async_runtime::spawn_blocking(workdays::today_timeline_inner)
        .await
        .map_err(|e| e.to_string())?
}

/// Historic workdays (everything *not* dated today), sorted by date desc.
#[tauri::command]
pub async fn workday_history(limit: Option<usize>) -> Result<Vec<Workday>, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::history_inner(limit))
        .await
        .map_err(|e| e.to_string())?
}

// -- Workflow templates orchestrator surface (2026-05-26 redesign) -----------

/// Return the seven hardcoded workflow templates the Workdays tab renders as
/// clickable cards. See `workdays::list_workflow_templates_inner`.
#[tauri::command]
pub async fn workday_list_templates() -> Result<Vec<WorkflowTemplate>, String> {
    tauri::async_runtime::spawn_blocking(workdays::list_workflow_templates_inner)
        .await
        .map_err(|e| e.to_string())?
}

/// Return today's `in_progress` workday for the given project, or `None`.
#[tauri::command]
pub async fn workday_active_today_for_project(
    project_id: String,
) -> Result<Option<Workday>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workdays::active_today_for_project_inner(project_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open today's workday for the given project using the supplied workflow
/// template id. Idempotent on (project, day).
#[tauri::command]
pub async fn workday_start_with_template(
    project_id: String,
    template_id: String,
) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workdays::start_with_template_inner(project_id, template_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
