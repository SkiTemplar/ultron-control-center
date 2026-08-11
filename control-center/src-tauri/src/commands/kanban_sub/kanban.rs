use crate::kanban::{
    self, append_run, card_by_id, column_by_name, create_card, delete_card, load, move_card,
    update_card, Card, CardPartial, CardPatch, CardRun, Column, ColumnRole, KanbanBoard, RunStatus,
};
use crate::pty::spawn_inner;
use tauri::{AppHandle, Runtime};

#[tauri::command]
pub async fn kanban_load(project_id: String) -> Result<KanbanBoard, String> {
    tauri::async_runtime::spawn_blocking(move || load(&project_id))
        .await
        .map_err(|e| e.to_string())?
}

// Higiene 2026-08-11 (audit 08-09 #42): kanban_save borrado — superseded por
// los comandos granulares (create/update/move/delete_card); un save de board
// entero desde la UI podia pisar cambios concurrentes.

#[tauri::command]
pub async fn kanban_create_card(
    project_id: String,
    column_id: String,
    partial: CardPartial,
) -> Result<Card, String> {
    tauri::async_runtime::spawn_blocking(move || create_card(&project_id, &column_id, partial))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kanban_update_card(
    project_id: String,
    card_id: String,
    patch: CardPatch,
) -> Result<Card, String> {
    tauri::async_runtime::spawn_blocking(move || update_card(&project_id, &card_id, patch))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kanban_move_card<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    card_id: String,
    target_column_id: String,
    order: i32,
) -> Result<KanbanBoard, String> {
    // Phase 1: persist the move on a blocking thread.
    let pid_for_move = project_id.clone();
    let cid_for_move = card_id.clone();
    let tcid_for_move = target_column_id.clone();
    let board = tauri::async_runtime::spawn_blocking(move || {
        move_card(&pid_for_move, &cid_for_move, &tcid_for_move, order)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Phase 2: if the target column is "In Progress" and the last run is not Running,
    // dispatch a PTY. Failure to dispatch must not break the move — log + continue.
    let dispatch_pid = project_id.clone();
    let dispatch_cid = card_id.clone();
    if let Some(in_progress) = column_by_name(&board, "In Progress") {
        if in_progress.id == target_column_id {
            let should_dispatch = match card_by_id(&board, &card_id) {
                Some(c) => match c.runs.last() {
                    Some(r) => !matches!(r.status, RunStatus::Running),
                    None => true,
                },
                None => false,
            };
            if should_dispatch {
                let _ = dispatch(app, &dispatch_pid, &dispatch_cid).await;
            }
        }
    }

    // Reload to include the run that dispatch appended (if any).
    let pid_for_reload = project_id.clone();
    let board = tauri::async_runtime::spawn_blocking(move || load(&pid_for_reload))
        .await
        .map_err(|e| e.to_string())??;
    Ok(board)
}

#[tauri::command]
pub async fn kanban_delete_card(project_id: String, card_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_card(&project_id, &card_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kanban_dispatch_card<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    card_id: String,
) -> Result<String, String> {
    dispatch(app, &project_id, &card_id).await
}

async fn dispatch<R: Runtime>(
    app: AppHandle<R>,
    project_id: &str,
    card_id: &str,
) -> Result<String, String> {
    let board = {
        let pid = project_id.to_string();
        tauri::async_runtime::spawn_blocking(move || load(&pid))
            .await
            .map_err(|e| e.to_string())??
    };
    let card = card_by_id(&board, card_id)
        .ok_or_else(|| format!("card {card_id} not found"))?
        .clone();

    let agent = card.agent.clone().or(board.default_agent.clone());
    let cwd = card.cwd.clone().unwrap_or_else(|| ".".to_string());
    let prompt = materialize_prompt(&card, board.default_prompt_template.as_deref());

    let session_id = {
        let app_inner = app.clone();
        let pid = project_id.to_string();
        let cid = card_id.to_string();
        let agent_inner = agent.clone();
        let cwd_inner = cwd.clone();
        let prompt_inner = prompt.clone();
        tauri::async_runtime::spawn_blocking(move || {
            spawn_inner(
                app_inner,
                pid,
                Some(cid),
                "claude".to_string(),
                agent_inner,
                cwd_inner,
                prompt_inner,
            )
        })
        .await
        .map_err(|e| e.to_string())??
    };

    let run = CardRun {
        session_id: session_id.clone(),
        started_at: now_iso(),
        ended_at: None,
        status: RunStatus::Running,
        exit_code: None,
    };
    let pid_for_run = project_id.to_string();
    let cid_for_run = card_id.to_string();
    tauri::async_runtime::spawn_blocking(move || append_run(&pid_for_run, &cid_for_run, run))
        .await
        .map_err(|e| e.to_string())??;

    Ok(session_id)
}

fn materialize_prompt(card: &Card, board_default: Option<&str>) -> Option<String> {
    let tmpl = card.prompt_template.as_deref().or(board_default)?;
    let mut out = tmpl.to_string();
    out = out.replace("{title}", &card.title);
    out = out.replace("{description}", &card.description);
    out = out.replace("{card_id}", &card.id);
    out = out.replace("{tags}", &card.tags.join(", "));
    Some(out)
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{}", secs)
}

// Higiene 2026-08-11 (audit 08-09 #42): kanban_migrate_existing borrado — la
// migracion real corre via crate::kanban::migrate_all_projects directo en
// setup() (lib.rs), nunca via invoke.

// ---------------------------------------------------------------------------
// v2.6.2 — archive commands (named groups for archived Done cards).
//
// All three delegate to `crate::kanban::*` so the persistence rules stay in
// the domain module. The frontend wires them in src/components/projects/
// ProjectBoard.tsx ("Archive Done" toolbar button + "Show Archived" panel).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn kanban_archive_done(
    project_id: String,
    archive_name: String,
) -> Result<kanban::KanbanArchive, String> {
    tauri::async_runtime::spawn_blocking(move || kanban::archive_done(&project_id, &archive_name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kanban_list_archives(
    project_id: String,
) -> Result<Vec<kanban::KanbanArchiveSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || kanban::list_archives(&project_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kanban_load_archive(
    project_id: String,
    archive_name: String,
) -> Result<kanban::KanbanArchive, String> {
    tauri::async_runtime::spawn_blocking(move || kanban::load_archive(&project_id, &archive_name))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// v2.14 — Column CRUD commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn kanban_add_column(
    project_id: String,
    name: String,
    role: ColumnRole,
) -> Result<Column, String> {
    tauri::async_runtime::spawn_blocking(move || kanban::add_column(&project_id, name, role))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kanban_delete_column(
    project_id: String,
    column_id: String,
    reassign_to_column_id: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        kanban::delete_column(&project_id, &column_id, reassign_to_column_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kanban_rename_column(
    project_id: String,
    column_id: String,
    name: String,
) -> Result<Column, String> {
    tauri::async_runtime::spawn_blocking(move || {
        kanban::rename_column(&project_id, &column_id, name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kanban_reorder_columns(
    project_id: String,
    ordered_ids: Vec<String>,
) -> Result<KanbanBoard, String> {
    tauri::async_runtime::spawn_blocking(move || kanban::reorder_columns(&project_id, &ordered_ids))
        .await
        .map_err(|e| e.to_string())?
}
