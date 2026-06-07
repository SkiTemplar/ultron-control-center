// ULTRON Control Center — Tauri command wrappers for the Decision Registry
// (KIRKARDO 24). All heavy I/O is delegated to `crate::decisions::*_inner`
// so this file stays a thin async façade — the same pattern used by
// commands/kanban.rs and commands/kg.rs.

use crate::decisions::{
    add_inner, delete_inner, drain_all_to_inbox, drain_pending_inner, list_inner,
    purge_noise_confirmed, reject_all_auto_inner, search_inner, update_inner, DecisionPatch,
    DecisionPayload, DecisionRecord, DecisionSearchResult, DrainAllResult, PurgeNoiseResult,
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn decisions_add(
    project_id: String,
    payload: DecisionPayload,
) -> Result<DecisionRecord, String> {
    tauri::async_runtime::spawn_blocking(move || add_inner(&project_id, payload))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn decisions_update(
    project_id: String,
    id: String,
    patch: DecisionPatch,
) -> Result<DecisionRecord, String> {
    tauri::async_runtime::spawn_blocking(move || update_inner(&project_id, &id, patch))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn decisions_list(project_id: String) -> Result<Vec<DecisionRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || list_inner(&project_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn decisions_delete(project_id: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_inner(&project_id, &id))
        .await
        .map_err(|e| e.to_string())?
}

/// Drain the Stop-hook pending file into proposed decisions (auto-capture).
/// Returns the newly added records (empty when nothing was pending).
#[tauri::command]
pub async fn decisions_drain_pending(project_id: String) -> Result<Vec<DecisionRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || drain_pending_inner(&project_id))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// Search decisions within a specific project.
/// Scoring: decision*3 + rationale*2 + tags*2 + alternatives*1 + author*1
#[tauri::command]
pub async fn decisions_search(
    query: String,
    project_id: String,
) -> Result<Vec<DecisionSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || search_inner(&query, Some(&project_id)))
        .await
        .map_err(|e| e.to_string())?
}

/// Search decisions across ALL projects (wraps decisions_search with scope=None).
/// This is the `kanban_decisions_search` variant mentioned in KIRKARDO 24.
#[tauri::command]
pub async fn kanban_decisions_search(query: String) -> Result<Vec<DecisionSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || search_inner(&query, None))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Bulk cleanup commands
// ---------------------------------------------------------------------------

/// Mark every `Proposed` + `auto-captured` decision for the given project as
/// `Rejected` in a single atomic write.  Returns the count of records changed.
///
/// Use this to quickly discard a batch drain that imported noise.  Manually
/// added decisions and decisions already in a terminal status are unaffected.
#[tauri::command]
pub async fn decisions_reject_all_auto(project_id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || reject_all_auto_inner(&project_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Remove auto-Proposed noise records from `decisions.jsonl`.
///
/// Only purges records with `author == "auto"` AND `status == Proposed` that
/// the noise filter identifies as operational chatter. Manual decisions and
/// records in any terminal status (Accepted/Rejected/Superseded) are NEVER
/// touched.
///
/// A timestamped backup is created before any write. `confirm` must be `true`
/// or the command returns an error — this prevents accidental one-click data
/// loss from an unguarded UI button.
///
/// Returns the IDs of the purged records for a future "Undo" path.
#[tauri::command]
pub async fn decisions_purge_noise(
    project_id: String,
    confirm: bool,
) -> Result<PurgeNoiseResult, String> {
    tauri::async_runtime::spawn_blocking(move || purge_noise_confirmed(&project_id, confirm))
        .await
        .map_err(|e| e.to_string())?
}

/// Drain ALL projects' `decisions-pending.jsonl` files into the governed memory
/// inbox (`brain.db memory_candidates`). This is the missing bridge between the
/// Stop-hook auto-capture pipeline (writes decisions-pending.jsonl) and the
/// Memory Inbox UI (reads brain.db candidates). Each drained decision becomes a
/// MemoryCandidate that goes through the full redaction + dedup + contradiction
/// pipeline before landing in the inbox for human review.
///
/// Safe to call repeatedly: the drain is atomic (rename + remove) so already-
/// drained lines are never re-imported.
#[tauri::command]
pub async fn decisions_drain_all_to_inbox() -> Result<DrainAllResult, String> {
    tauri::async_runtime::spawn_blocking(drain_all_to_inbox)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}
