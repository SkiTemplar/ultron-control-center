// commands/memory/inbox.rs — Memory Inbox + governance commands (MEMORY KERNEL)
//
// Human-in-the-loop control surface over the candidate/governance pipeline.
// Reuses the same Accept/Reject drain pattern as decisions.rs, generalised to
// `memory_candidates`. Every op goes through `MemoryService` (the single writer)
// and appends a `memory_event`. Status changes that retire a memory also remove
// it from the dense index (retire-from-index).

use crate::memory::{
    auto_approve, qdrant_index, Actor, BulkDeprecateResult, MemoryCandidate, MemoryItem,
    MemoryService, MemoryStats, MemoryType, Status,
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

/// One page of governed memories for the Memory Browser (FRENTE 5).
#[derive(serde::Serialize)]
pub struct MemoryItemsPage {
    pub items: Vec<MemoryItem>,
    pub total: i64,
    pub offset: u32,
    pub limit: u32,
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

// ---------------------------------------------------------------------------
// Auto-approve policy (persisted setting + guarded bulk promote)
// ---------------------------------------------------------------------------

/// Read the persisted `auto_approve` flag. Fail-safe: returns `false` on any
/// read error (no HOME / missing / malformed file).
#[tauri::command]
pub async fn memory_auto_approve_get() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(auto_approve::auto_approve_enabled()))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Persist the `auto_approve` flag. When set to `true`, future CLEAN candidates
/// are auto-promoted on creation (see `MemoryService::create_candidate`); secrets
/// and contradictions always stay in the inbox. Returns the stored value.
#[tauri::command]
pub async fn memory_auto_approve_set(enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Preserve any user-tuned `auto_approve_threshold` — toggling the flag must
        // not silently reset the 3-band confidence floor.
        let settings = auto_approve::MemorySettings {
            auto_approve: enabled,
            ..auto_approve::read_settings()
        };
        auto_approve::write_settings(settings).map(|s| s.auto_approve)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Bulk-approve only the CLEAN pending candidates (no secret marker, no
/// contradiction). Mirrors `memory_inbox_approve_all` but applies the same
/// security safeguard as the auto-approve hook, so flagged candidates are left in
/// the inbox for human review. Used when the user turns the toggle ON to clear the
/// existing backlog of clean candidates in one shot.
#[tauri::command]
pub async fn memory_inbox_approve_clean() -> Result<ApproveAllResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let pending =
            MemoryService::list_pending_candidates(usize::MAX).map_err(|e| e.to_string())?;

        let mut approved = 0u32;
        let mut failed: Vec<ApproveFailure> = Vec::new();
        for cand in pending {
            // Safeguard: skip anything that must stay under human review.
            if !auto_approve::candidate_is_clean(&cand) {
                continue;
            }
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

/// Deprecate an item (no longer recall-eligible) + retire from the dense index.
#[tauri::command]
pub async fn memory_item_deprecate(
    id: String,
    reason: Option<String>,
) -> Result<MemoryItem, String> {
    retire(id, Status::Deprecated, reason).await
}

/// Forget an item — PERMANENT, IRREVERSIBLE hard delete (H4: verifiable forget).
///
/// Unlike `memory_item_deprecate` (which keeps the row but holds it out of
/// recall), this purges the row from the SoT (`brain.db`) and the dense index
/// entirely. Intended for right-to-be-forgotten / leaked-secret purge. The
/// append-only audit log retains a `forgotten` event with the erased item's
/// json as the sole surviving provenance.
#[tauri::command]
pub async fn memory_forget(id: String, reason: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        MemoryService::forget(&id, Actor::User, reason).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

// ---------------------------------------------------------------------------
// Memory Browser (FRENTE 5) — paginated read + bulk deprecate by type
// ---------------------------------------------------------------------------

/// Paginated, filterable listing of governed memories for the Memory Browser.
///
/// All filters are optional and AND-combined: `status` + `item_type` are parsed
/// to the controlled vocab (an unknown string is an error, not a silent no-op),
/// `search` is a substring over title/summary, `pinned_only` restricts to pinned.
/// Read-only — no event is appended. Returns `{ items, total, offset, limit }`
/// where `total` is the unpaginated match count for the UI pager.
#[tauri::command]
pub async fn memory_items_list(
    status: Option<String>,
    item_type: Option<String>,
    search: Option<String>,
    pinned_only: Option<bool>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<MemoryItemsPage, String> {
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(50);
    tauri::async_runtime::spawn_blocking(move || {
        let status = match status {
            Some(s) => Some(Status::parse(&s).ok_or_else(|| format!("invalid status: {s}"))?),
            None => None,
        };
        let kind = match item_type {
            Some(t) => Some(MemoryType::parse(&t).ok_or_else(|| format!("invalid type: {t}"))?),
            None => None,
        };
        let (items, total) = MemoryService::query_items(
            status,
            kind,
            search,
            pinned_only.unwrap_or(false),
            offset as usize,
            limit as usize,
        )
        .map_err(|e| e.to_string())?;
        Ok(MemoryItemsPage {
            items,
            total,
            offset,
            limit,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Bulk-deprecate every active item of a given type from the Browser (one shot,
/// not a dry-run). Reuses the shared `deprecate_by_type` governance path so FTS5 +
/// Qdrant stay in sync. Scoped to all projects (`project = None`).
#[tauri::command]
pub async fn memory_items_deprecate_by_type(
    item_type: String,
    reason: Option<String>,
) -> Result<BulkDeprecateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let kind = MemoryType::parse(&item_type)
            .ok_or_else(|| format!("invalid memory type: {item_type}"))?;
        MemoryService::deprecate_by_type(kind, false, None, reason, Actor::User)
            .map_err(|e| e.to_string())
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
