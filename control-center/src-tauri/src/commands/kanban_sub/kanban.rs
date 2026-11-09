use crate::kanban::{
    self, create_card, delete_card, load, move_card, update_card, Card, CardPartial, CardPatch,
    Column, ColumnRole, KanbanBoard,
};

// El despacho de tarjetas por PTY (RunBatch, «Run again») se retiró el
// 2026-10-17 (H12): lanzaba un Claude invisible, sin el prompt de la tarjeta y
// saltándose los permisos. `kanban_dispatch_card`, que quedó solo para
// explicar la retirada a un llamante viejo, se quitó el 2026-10-23: el
// frontend va empaquetado con el binario y ya no lo invoca (la tarjeta ofrece
// «Abrir en Sessions»). Recuperable del historial de git.

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

/// Mueve una tarjeta. Desde el 2026-10-17 llevarla a «In Progress» ya no
/// lanza nada (despacho retirado, ver la cabecera): solo persiste el movimiento.
#[tauri::command]
pub async fn kanban_move_card(
    project_id: String,
    card_id: String,
    target_column_id: String,
    order: i32,
) -> Result<KanbanBoard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        move_card(&project_id, &card_id, &target_column_id, order)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kanban_delete_card(project_id: String, card_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_card(&project_id, &card_id))
        .await
        .map_err(|e| e.to_string())?
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
