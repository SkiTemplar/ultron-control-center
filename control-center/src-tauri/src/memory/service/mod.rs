// ULTRON Control Center — MemoryService: the single persistent writer (Fase A)
//
// GOVERNANCE INVARIANT: every persistent memory mutation goes through this
// service, and every mutation appends a `MemoryEvent`. Hooks and agents NEVER
// write `memory_items` directly — they propose `MemoryCandidate`s and the human
// (or an auto-approval policy) promotes them here.
//
// The service is stateless: each method opens `brain.db` (WAL) for its unit of
// work. Tauri commands / the CLL / the candidate-extraction hook all call here.
//
// Module layout:
//   mod.rs       — types, shared helpers (raised_sensitivity, sync_index, …)
//   candidates   — candidate intake (create, edit, list, approve, reject)
//   mutations    — direct writes, mutations, reads, stats

use serde::Serialize;

use super::model::{Sensitivity, Status};
use super::qdrant_index;
use super::redaction;
use super::MemoryItem;

mod candidates;
mod mutations;

#[cfg(test)]
mod tests;

/// Stateless facade over the canonical memory store.
pub struct MemoryService;

/// Aggregate counts for dashboards / `memory stats`.
#[derive(Debug, Clone, Serialize)]
pub struct MemoryStats {
    pub active: i64,
    pub pending: i64,
    pub rejected: i64,
    pub deprecated: i64,
    pub stale: i64,
    pub candidates_pending: i64,
}

/// Outcome of [`MemoryService::deprecate_by_type`]: how many ACTIVE items of a
/// given type matched and how many were deprecated, plus per-id failures. Used
/// by the `deprecate` sidecar subcommand and the `memory_bulk_deprecate` Tauri
/// command to purge bloat (e.g. ~478 `codebase_fact`) without leaving FTS5 /
/// Qdrant out of sync — each item still goes through the proven `set_status` path.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BulkDeprecateResult {
    pub kind: String,
    pub matched: usize,
    pub deprecated: usize,
    pub dry_run: bool,
    pub project: Option<String>,
    /// (id, error) for each item whose deprecation failed; a single failure does
    /// NOT abort the batch (same tolerance as `memory_inbox_approve_all`).
    pub failed: Vec<(String, String)>,
}

/// Resultado de [`MemoryService::backfill_deprecations`]: cuántos eventos de
/// deprecación históricos se escanearon y cuántos se insertaron en el ledger.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackfillDeprecationsResult {
    /// Filas de `memory_events` con `event_type='deprecated'` escaneadas.
    pub scanned: usize,
    /// Entradas nuevas insertadas en `deprecation_entries`.
    pub inserted: usize,
    /// Entradas que ya existían (INSERT OR IGNORE fue no-op).
    pub skipped: usize,
}

/// Result of [`MemoryService::mark_stale_aged`]: how many ACTIVE items matched
/// the age cutoff and how many were transitioned to `Status::Stale`. Honest
/// scope (mand. 13): "stale" = "not MODIFIED in N days" (`updated_at`), NOT
/// "unused / no recall-hit" — `last_accessed_at` is not written on the read path
/// today. Each transition goes through the proven `set_status` path (FTS5 +
/// Qdrant + event log stay consistent) and is reversible (`Restored`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct StaleSweepResult {
    pub older_than_days: i64,
    pub matched: usize,
    pub staled: usize,
    pub dry_run: bool,
    pub failed: Vec<(String, String)>,
}

/// Result of [`MemoryService::sweep_low_confidence`] (audit 2026-08-09): the
/// confidence-noise sweep. `matched` = ACTIVE bajo el umbral; los `protected_*`
/// NO se tocan (golden positives / pinned / user-validated) y se reportan para
/// que el operador vea el alcance real (mand. 13).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConfidenceSweepResult {
    pub below: f32,
    pub examined: usize,
    pub matched: usize,
    pub deprecated: usize,
    pub protected_golden: usize,
    pub protected_pinned: usize,
    pub protected_validated: usize,
    pub dry_run: bool,
    pub failed: Vec<(String, String)>,
}

/// Raise sensitivity to [`Sensitivity::Secret`] when the write-path detected a
/// credential. Monotonic: it never lowers an already-higher classification (H2 /
/// OLA A — see CONTRACTS-2026-06-04.md write-path security + recall Secret-gate).
fn raised_sensitivity(current: Sensitivity, secret_detected: bool) -> Sensitivity {
    if secret_detected {
        Sensitivity::Secret
    } else {
        current
    }
}

/// Best-effort: keep the derived dense index (Qdrant `ultron_memory`) in step
/// with a write to the SoT. ACTIVE items are (re)indexed; non-active items are
/// removed. Errors are swallowed — `brain.db` is the source of truth and any
/// drift is detectable/repairable via `reconcile`. (W4: closes the gap where a
/// newly approved/edited/restored item never reached Qdrant until a manual
/// `reindex_all`, so `in_sync` would drift on the first approval.)
fn sync_index(item: &MemoryItem) {
    if matches!(item.status, Status::Active) {
        let _ = qdrant_index::index_item(item);
    } else {
        let _ = qdrant_index::remove_item(&item.id);
    }
}

/// Candidate `risk_level` marker set when the write-path detected a credential;
/// read on approve to raise the item to `Sensitivity::Secret` (H2). Single source
/// of the literal so a typo can't silently disable the Secret-gate.
const SECRET_RISK_MARKER: &str = "secret";

/// Redact any credential material found in `tags` (write-path helper, review-fix).
/// Returns `true` if anything was redacted. Tags are short labels but are still
/// user/tool text and are part of `searchable_text()` (hence embedded).
fn redact_tags(tags: &mut [String]) -> bool {
    let mut hit = false;
    for tag in tags.iter_mut() {
        if redaction::contains_secret(tag) {
            *tag = redaction::redact(tag);
            hit = true;
        }
    }
    hit
}
