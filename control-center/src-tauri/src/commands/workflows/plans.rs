// Plans CRUD + auto-archive commands.
use crate::plans;

#[tauri::command]
pub async fn list_plans() -> Result<plans::PlansReport, String> {
    plans::list_plans_inner()
}

#[tauri::command]
pub async fn patch_plan_status(
    app: tauri::AppHandle,
    id: String,
    status: String,
) -> Result<bool, String> {
    // F2: route through *_with_emit so plan.resolved notifications fire
    plans::patch_plan_status_inner_with_emit(&app, id, status)
}

#[tauri::command]
pub async fn add_plan(
    title: String,
    priority: Option<String>,
    status: Option<String>,
    kind: Option<String>,
    description: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<plans::PlanMutateResult, String> {
    plans::add_plan_inner(plans::CreatePlanPayload {
        title,
        priority,
        status,
        kind,
        description,
        tags,
    })
}

#[tauri::command]
pub async fn update_plan(
    id: String,
    title: Option<String>,
    priority: Option<String>,
    kind: Option<String>,
    description: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<plans::PlanMutateResult, String> {
    plans::update_plan_inner(plans::UpdatePlanPayload {
        id,
        title,
        priority,
        kind,
        description,
        tags,
    })
}

#[tauri::command]
pub async fn delete_plan(id: String) -> Result<plans::PlanMutateResult, String> {
    plans::delete_plan_inner(id)
}

#[tauri::command]
pub async fn clean_resolved_plans() -> Result<u64, String> {
    plans::clean_resolved_plans_inner()
}

// LIB_RS_WIRING: new command for Phase 3 Plans auto-archive.
#[tauri::command]
pub async fn auto_archive_resolved_plans(days: Option<u32>) -> Result<usize, String> {
    plans::auto_archive_resolved(days.unwrap_or(30))
}
