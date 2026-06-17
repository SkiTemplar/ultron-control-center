// projects/scan.rs — Project scanner invocation and emit-aware wrappers.

use super::read_ops::list_projects_inner;
use super::types::{CreateProjectPayload, CreateProjectResult, DeleteProjectResult, ProjectInfo};
use super::write_ops::{create_project_inner, delete_project_inner};

/// Run the project scanner and return the rescanned project list. v15.4:
/// invokes `uv run python scan_projects.py` directly instead of routing
/// through the legacy `ultron.ps1 scan` dispatcher.
pub async fn scan_projects_inner(app: &tauri::AppHandle) -> Result<Vec<ProjectInfo>, String> {
    use tauri_plugin_shell::ShellExt;
    let py = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/scan_projects.py");
    let py_str = py.to_string_lossy().to_string();
    let _output = app
        .shell()
        .command("uv")
        .args(["run", "python", &py_str])
        .output()
        .await
        .map_err(|e| format!("spawn uv run scan_projects.py: {}", e))?;
    // Re-read the registry — the scan rewrites projects.json
    list_projects_inner()
}

/// Wrapper that calls `create_project_inner` and, on success, fires an
/// info alert through `toast_emit`.
pub fn create_project_inner_with_emit(
    app: &tauri::AppHandle,
    p: CreateProjectPayload,
) -> Result<CreateProjectResult, String> {
    let name = p.name.trim().to_string();
    let res = create_project_inner(p)?;
    if res.success {
        crate::toast_emit::record_alert_and_maybe_toast(
            app,
            "project.created",
            "info",
            &format!("Project created: {} ({})", name, res.id),
        );
    }
    Ok(res)
}

/// Wrapper that calls `delete_project_inner` and, on actual removal
/// (success=true, i.e. an entry was found), fires an info alert.
pub fn delete_project_inner_with_emit(
    app: &tauri::AppHandle,
    id: String,
) -> Result<DeleteProjectResult, String> {
    let res = delete_project_inner(id.clone())?;
    if res.success {
        crate::toast_emit::record_alert_and_maybe_toast(
            app,
            "project.deleted",
            "info",
            &format!("Project deleted: {}", id),
        );
    }
    Ok(res)
}
