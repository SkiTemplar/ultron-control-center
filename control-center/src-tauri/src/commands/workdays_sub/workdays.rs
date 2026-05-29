// ULTRON Control Center - Workdays command wrappers (v2.8 automatic surface)
// H29 + H30 (2026-05-27): wipe + day view with hour-blocks added.
use crate::workdays::{
    self, DrainReport, GoalStatus, PendingLink, Workday, WorkdayDayView, WorkdayMetrics,
    WorkdayTemplate, WorkdayTodayView, WipeReport,
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

// (workday_list_templates eliminado 2026-05-30 — templates retirados.)

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

// (workday_start_with_template eliminado 2026-05-30 — templates retirados.)

// -- H29: wipe (2026-05-27) --------------------------------------------------

/// Archive all `wd-*.json` + `_pending-links.jsonl` into a timestamped ZIP,
/// then delete the originals. Work-sessions under `cockpit/projects/` are
/// NOT touched.
#[tauri::command]
pub async fn workday_wipe_all() -> Result<WipeReport, String> {
    tauri::async_runtime::spawn_blocking(workdays::wipe_all_with_backup_inner)
        .await
        .map_err(|e| e.to_string())?
}

// -- H30: day view with hour-blocks (2026-05-27) -----------------------------

/// Return a full day view for `date` (ISO `YYYY-MM-DD`; defaults to today).
/// Includes all workdays for that date plus a 24-slot hour-block timeline
/// derived from workday timestamps and context-entry `created_at` values.
#[tauri::command]
pub async fn workday_day_view(date: Option<String>) -> Result<WorkdayDayView, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::day_view_inner(date))
        .await
        .map_err(|e| e.to_string())?
}

// -- H31: Goals CRUD + AI auto-fill ------------------------------------------

/// Add a new manual goal to the workday.
#[tauri::command]
pub async fn workday_goals_add(workday_id: String, text: String) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::goals_add_inner(workday_id, text))
        .await
        .map_err(|e| e.to_string())?
}

/// Update a goal's status and optionally rename it.
#[tauri::command]
pub async fn workday_goals_update(
    workday_id: String,
    goal_id: String,
    status: GoalStatus,
    text: Option<String>,
) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workdays::goals_update_inner(workday_id, goal_id, status, text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete a goal from the workday.
#[tauri::command]
pub async fn workday_goals_delete(workday_id: String, goal_id: String) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workdays::goals_delete_inner(workday_id, goal_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Scan kanban boards for "In Progress" cards, call AI Router to produce
/// concise goal texts, and append them to the workday (dedup by text).
#[tauri::command]
pub async fn workday_goals_auto_fill(workday_id: String) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::goals_auto_fill_inner(workday_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Genera/regenera el resumen IA de la jornada (auto-contexto, 2026-05-30).
#[tauri::command]
pub async fn workday_ai_summary_generate(workday_id: String) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || workdays::ai_summary_generate_inner(workday_id))
        .await
        .map_err(|e| e.to_string())?
}

// -- H32: Auto AI update ------------------------------------------------------

/// Append an auto-update summary note to a workday. Called by the 15-min
/// scheduled hook (`workday-auto-update.js`).
#[tauri::command]
pub async fn workday_context_auto_append(
    workday_id: String,
    summary: String,
    payload_json: Option<String>,
) -> Result<Workday, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workdays::context_auto_append_inner(workday_id, summary, payload_json)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return the active workday id for today (in_progress status). Used by
/// the scheduled hook to resolve the target workday without the UI running.
#[tauri::command]
pub async fn workday_active_id_today() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(workdays::active_workday_id_today_inner)
        .await
        .map_err(|e| e.to_string())?
}

/// Register (or replace idempotently) a Windows scheduled task that runs
/// `~/.claude/hooks/workday-auto-update.js` every 15 minutes.
#[tauri::command]
pub async fn register_workday_autoupdate_task() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(workdays::register_autoupdate_task_inner)
        .await
        .map_err(|e| e.to_string())?
}
