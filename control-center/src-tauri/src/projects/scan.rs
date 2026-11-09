// projects/scan.rs — Emit-aware wrappers de alta y baja. El escaneo vive en discover.rs.

use super::types::{CreateProjectPayload, CreateProjectResult, DeleteProjectResult};
use super::write_ops::{create_project_inner, delete_project_inner};

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
