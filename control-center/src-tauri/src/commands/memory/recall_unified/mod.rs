// commands/memory/recall_unified/mod.rs — unified hybrid recall (MEMORY KERNEL Fase B)
//
// The single `recall` command. Fuses TWO sources with Reciprocal Rank Fusion:
//   - DENSE:  MultilingualE5Large vectors in Qdrant `ultron_memory`
//   - SPARSE: FTS5/bm25 over `memory_items` (brain.db), ACTIVE only
// Both sources filter to status=active; the result is a compact context pack of
// summaries (not full content) under a per-call token cap. Degrades to
// sparse-only when E5/Qdrant is unavailable.
//
// Replaces the old `recall_hybrid` (constant-score union, no RRF) and
// `recall_semantic`. Those remain registered (no live frontend caller) but are
// deprecated.

pub(crate) mod engine;
#[cfg(test)]
mod tests;
pub(crate) mod types_model;

pub use engine::{build_trace, recall_pack};
pub use types_model::rrf_fuse;
pub use types_model::{
    DiscardedHit, FusedHit, RecallEntry, RecallPack, RecallTrace, PER_CALL_TOKEN_CAP,
};

/// Retrieval Inspector: the full per-turn trace (query, filters, dense/sparse
/// ranks, RRF scores, discarded+reason, injected+reason, lazy-load, warnings).
#[tauri::command]
pub async fn recall_inspect(
    query: String,
    limit: Option<u32>,
    project_id: Option<String>,
    cross_project: Option<bool>,
) -> Result<RecallTrace, String> {
    let final_limit = limit
        .map(|n| n as usize)
        .unwrap_or(types_model::DEFAULT_LIMIT);
    let cross = cross_project.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        build_trace(
            &query,
            final_limit,
            project_id.as_deref(),
            cross,
            true, // manual recall inspection: full hybrid (dense on)
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Rebuild the dense index (`ultron_memory`) from all ACTIVE items.
#[tauri::command]
pub async fn memory_reindex() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (indexed, errors) =
            crate::memory::qdrant_index::reindex_all().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "indexed": indexed,
            "errors": errors,
            "collection": crate::memory::qdrant_index::COLLECTION,
        }))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}
