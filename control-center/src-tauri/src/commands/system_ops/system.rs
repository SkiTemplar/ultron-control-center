// Scheduled tasks + system info commands.
use crate::system;

#[tauri::command]
pub async fn list_scheduled_tasks(
    app: tauri::AppHandle,
) -> Result<Vec<system::ScheduledTaskInfo>, String> {
    system::list_tasks_inner(&app).await
}

#[tauri::command]
pub async fn run_scheduled_task(
    app: tauri::AppHandle,
    name: String,
) -> Result<system::RunTaskResult, String> {
    system::run_task_inner(&app, name).await
}

#[tauri::command]
pub async fn system_info(app: tauri::AppHandle) -> Result<system::SystemInfo, String> {
    system::system_info_inner(&app).await
}

#[tauri::command]
pub async fn task_detail(
    app: tauri::AppHandle,
    name: String,
) -> Result<system::TaskDetail, String> {
    system::task_detail_inner(&app, name).await
}

#[tauri::command]
pub async fn rich_system_info(app: tauri::AppHandle) -> Result<system::RichSystemInfo, String> {
    system::rich_system_info_inner(&app).await
}

#[tauri::command]
pub async fn edit_scheduled_task(
    app: tauri::AppHandle,
    name: String,
    new_trigger_type: String,
    new_trigger_at: Option<String>,
    catch_up: Option<bool>,
) -> Result<system::EditTaskResult, String> {
    system::edit_task_inner(&app, name, new_trigger_type, new_trigger_at, catch_up).await
}

#[tauri::command]
pub async fn delete_scheduled_task(
    app: tauri::AppHandle,
    name: String,
) -> Result<system::DeleteTaskResult, String> {
    system::delete_task_inner(&app, name).await
}
