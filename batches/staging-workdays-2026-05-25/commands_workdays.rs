// ULTRON Control Center - Workdays command wrappers (v2.7 full backend)
use crate::workdays::{self, GoalStatus, Workday, WorkdayMetrics, WorkdayTemplate};

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
