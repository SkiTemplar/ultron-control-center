// commands/memory/inbox.rs — Memory Inbox + governance commands (MEMORY KERNEL)
//
// Human-in-the-loop control surface over the candidate/governance pipeline.
// Reuses the same Accept/Reject drain pattern as decisions.rs, generalised to
// `memory_candidates`. Every op goes through `MemoryService` (the single writer)
// and appends a `memory_event`. Status changes that retire a memory also remove
// it from the dense index (retire-from-index).

use crate::memory::{
    qdrant_index, Actor, MemoryCandidate, MemoryEvent, MemoryItem, MemoryService, MemoryStats,
    MemoryType, Scope, Status,
};

// ---------------------------------------------------------------------------
// Bulk-approve result types
// ---------------------------------------------------------------------------

/// A single candidate that could not be approved during a bulk operation.
#[derive(Debug, serde::Serialize)]
pub struct ApproveFailure {
    pub id: String,
    pub error: String,
}

/// Outcome of `memory_inbox_approve_all`: count approved + per-id failures.
#[derive(Debug, serde::Serialize)]
pub struct ApproveAllResult {
    pub approved: u32,
    pub failed: Vec<ApproveFailure>,
}

// ---------------------------------------------------------------------------
// Candidate inbox
// ---------------------------------------------------------------------------

/// List memory candidates awaiting validation (the inbox).
#[tauri::command]
pub async fn memory_inbox_list(limit: Option<u32>) -> Result<Vec<MemoryCandidate>, String> {
    let n = limit.map(|n| n as usize).unwrap_or(200);
    tauri::async_runtime::spawn_blocking(move || {
        MemoryService::list_pending_candidates(n).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Approve a candidate -> promote to an ACTIVE memory (validated by the user).
#[tauri::command]
pub async fn memory_candidate_approve(id: String) -> Result<MemoryItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        MemoryService::approve_candidate(&id, Actor::User).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Bulk-approve every pending candidate in the inbox.
///
/// Reuses the exact same path as `memory_candidate_approve`
/// (`MemoryService::approve_candidate`, Actor::User) per candidate — no
/// duplicated promotion logic. One candidate failing does not abort the batch;
/// its id + error are collected into `failed`. Returns `{ approved, failed }`.
#[tauri::command]
pub async fn memory_inbox_approve_all() -> Result<ApproveAllResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // High cap: drain the whole pending queue, not just the UI page.
        let pending =
            MemoryService::list_pending_candidates(usize::MAX).map_err(|e| e.to_string())?;

        let mut approved = 0u32;
        let mut failed: Vec<ApproveFailure> = Vec::new();
        for cand in pending {
            match MemoryService::approve_candidate(&cand.id, Actor::User) {
                Ok(_) => approved += 1,
                Err(e) => failed.push(ApproveFailure {
                    id: cand.id,
                    error: e.to_string(),
                }),
            }
        }
        Ok(ApproveAllResult { approved, failed })
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Reject a candidate -> it never becomes a memory.
#[tauri::command]
pub async fn memory_candidate_reject(id: String, reason: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        MemoryService::reject_candidate(&id, Actor::User, reason).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Edit a candidate's proposed fields before approval.
#[tauri::command]
pub async fn memory_candidate_edit(
    id: String,
    summary: Option<String>,
    content: Option<String>,
    importance: Option<f32>,
    confidence: Option<f32>,
) -> Result<MemoryCandidate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        MemoryService::edit_candidate(&id, summary, content, importance, confidence)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

// ---------------------------------------------------------------------------
// Item governance (post-active)
// ---------------------------------------------------------------------------

/// Edit an active item's editable fields.
#[tauri::command]
pub async fn memory_item_edit(
    id: String,
    title: Option<String>,
    summary: Option<String>,
    content: Option<String>,
    importance: Option<f32>,
    confidence: Option<f32>,
) -> Result<MemoryItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        MemoryService::edit(
            &id,
            title,
            summary,
            content,
            importance,
            confidence,
            Actor::User,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Change an item's scope and/or type (strings parsed to the controlled vocab).
#[tauri::command]
pub async fn memory_item_relabel(
    id: String,
    scope: Option<String>,
    item_type: Option<String>,
) -> Result<MemoryItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let scope = match scope {
            Some(s) => Some(Scope::parse(&s).ok_or_else(|| format!("invalid scope: {s}"))?),
            None => None,
        };
        let kind = match item_type {
            Some(t) => Some(MemoryType::parse(&t).ok_or_else(|| format!("invalid type: {t}"))?),
            None => None,
        };
        MemoryService::relabel(&id, scope, kind, Actor::User).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Deprecate an item (no longer recall-eligible) + retire from the dense index.
#[tauri::command]
pub async fn memory_item_deprecate(
    id: String,
    reason: Option<String>,
) -> Result<MemoryItem, String> {
    retire(id, Status::Deprecated, reason).await
}

/// Quarantine an item (suspect; held out of recall) + retire from the index.
#[tauri::command]
pub async fn memory_item_quarantine(
    id: String,
    reason: Option<String>,
) -> Result<MemoryItem, String> {
    retire(id, Status::Quarantined, reason).await
}

/// "Do not use this again" — mark rejected + retire from the index + log event.
/// The recall path also rechecks status on load, so injection is doubly blocked.
#[tauri::command]
pub async fn memory_do_not_use(id: String, reason: Option<String>) -> Result<MemoryItem, String> {
    retire(
        id,
        Status::Rejected,
        reason.or_else(|| Some("user: do not use again".to_string())),
    )
    .await
}

/// Forget an item — PERMANENT, IRREVERSIBLE hard delete (H4: verifiable forget).
///
/// Unlike `memory_item_deprecate` / `memory_do_not_use` (which keep the row but
/// hold it out of recall), this purges the row from the SoT (`brain.db`) and the
/// dense index entirely. Intended for right-to-be-forgotten / leaked-secret purge.
/// The append-only audit log retains a `forgotten` event with the erased item's
/// json as the sole surviving provenance.
#[tauri::command]
pub async fn memory_forget(id: String, reason: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        MemoryService::forget(&id, Actor::User, reason).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Pin an item — always surfaced in recall + Session Resume (req #17).
#[tauri::command]
pub async fn memory_item_pin(id: String) -> Result<MemoryItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        MemoryService::pin(&id, Actor::User).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Unpin an item.
#[tauri::command]
pub async fn memory_item_unpin(id: String) -> Result<MemoryItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        MemoryService::unpin(&id, Actor::User).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Full audit history (events) for one memory.
#[tauri::command]
pub async fn memory_item_history(
    id: String,
    limit: Option<u32>,
) -> Result<Vec<MemoryEvent>, String> {
    let n = limit.map(|n| n as usize).unwrap_or(50);
    tauri::async_runtime::spawn_blocking(move || {
        MemoryService::history(&id, n).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Aggregate health counts (active/pending/rejected/deprecated/stale + candidates).
#[tauri::command]
pub async fn memory_stats() -> Result<MemoryStats, String> {
    tauri::async_runtime::spawn_blocking(|| MemoryService::stats().map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

// ---------------------------------------------------------------------------
// Helper: set a retiring status + remove from the dense index.
// ---------------------------------------------------------------------------

async fn retire(id: String, status: Status, reason: Option<String>) -> Result<MemoryItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let item = MemoryService::set_status(&id, status, Actor::User, reason)
            .map_err(|e| e.to_string())?;
        // Best-effort: drop the point from ultron_memory so dense search won't
        // surface a stale-active payload (the recall also rechecks status on load).
        let _ = qdrant_index::remove_item(&id);
        Ok(item)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}
