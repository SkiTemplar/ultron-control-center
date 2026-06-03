// commands/memory/recall_unified.rs — unified hybrid recall (MEMORY KERNEL Fase B)
//
// The single `recall` command. Fuses TWO sources with Reciprocal Rank Fusion:
//   - DENSE:  MultilingualE5Large vectors in Qdrant `ultron_memory`
//   - SPARSE: FTS5/bm25 over `memory_items` (brain.db), ACTIVE only
// Both sources filter to status=active; the result is a compact context pack of
// summaries (not full content) under a token budget. Degrades to sparse-only
// when E5/Qdrant is unavailable.
//
// Replaces the old `recall_hybrid` (constant-score union, no RRF) and
// `recall_semantic`. Those remain registered (no live frontend caller) but are
// deprecated.

use serde::Serialize;

use crate::memory::qdrant_index;
use crate::memory::sqlite_store as store;
use crate::memory::{MemoryService, Status};

const RRF_K: f32 = 60.0; // standard RRF damping constant
const DEFAULT_LIMIT: usize = 8; // final entries returned
const FANOUT_K: usize = 30; // top-K pulled from each source before fusion
const TOKEN_BUDGET: i64 = 1500; // context-pack budget (summaries only)

#[derive(Debug, Clone, Serialize)]
pub struct RecallEntry {
    pub canonical_id: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub scope: String,
    pub project_id: Option<String>,
    pub score: f32,
    pub token_estimate: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecallPack {
    pub entries: Vec<RecallEntry>,
    pub total_tokens: i64,
    pub dense_hits: usize,
    pub sparse_hits: usize,
}

/// Reciprocal Rank Fusion. Each list is canonical_ids ordered best-first.
/// `score(d) = Σ_sources 1 / (k + rank + 1)`. Returns `(id, score)` desc.
pub fn rrf_fuse(lists: &[Vec<String>], k: f32) -> Vec<(String, f32)> {
    use std::collections::HashMap;
    let mut scores: HashMap<String, f32> = HashMap::new();
    for list in lists {
        for (rank, id) in list.iter().enumerate() {
            *scores.entry(id.clone()).or_insert(0.0) += 1.0 / (k + rank as f32 + 1.0);
        }
    }
    let mut fused: Vec<(String, f32)> = scores.into_iter().collect();
    fused.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0)) // stable tie-break by id
    });
    fused
}

/// Unified hybrid recall. `project_id = None` means no project filter.
#[tauri::command]
pub async fn recall(
    query: String,
    limit: Option<u32>,
    project_id: Option<String>,
) -> Result<RecallPack, String> {
    let final_limit = limit.map(|n| n as usize).unwrap_or(DEFAULT_LIMIT);
    tauri::async_runtime::spawn_blocking(move || {
        // (1) DENSE — E5 query embedding + Qdrant filtered k-NN (empty if offline).
        let dense_ids = qdrant_index::search_dense(&query, FANOUT_K as u32, project_id.as_deref());

        // (2) SPARSE — FTS5/bm25 over ACTIVE items.
        let sparse_items = MemoryService::search_active(&query, FANOUT_K)
            .map_err(|e| format!("sparse search: {e}"))?;
        let sparse_ids: Vec<String> = sparse_items.iter().map(|it| it.id.clone()).collect();

        // (3) RRF fusion + dedup by canonical_id.
        let fused = rrf_fuse(&[dense_ids.clone(), sparse_ids.clone()], RRF_K);

        // (4)+(5) load items + build the compact context pack under budget.
        let conn = store::open_conn().map_err(|e| format!("open brain.db: {e}"))?;
        let mut entries: Vec<RecallEntry> = Vec::new();
        let mut total_tokens = 0i64;
        for (canonical_id, score) in fused {
            if entries.len() >= final_limit {
                break;
            }
            let item = match store::get_item(&conn, &canonical_id) {
                Ok(Some(it)) => it,
                _ => continue, // orphan dense id (no active item) -> skip
            };
            if item.status != Status::Active {
                continue;
            }
            if let Some(pid) = &project_id {
                if item.project_id.as_deref() != Some(pid.as_str()) {
                    continue;
                }
            }
            if total_tokens + item.token_estimate > TOKEN_BUDGET && !entries.is_empty() {
                break;
            }
            total_tokens += item.token_estimate;
            entries.push(RecallEntry {
                canonical_id: item.id,
                title: item.title,
                summary: item.summary, // compact form, never full content
                scope: item.scope.as_str().to_string(),
                project_id: item.project_id,
                score,
                token_estimate: item.token_estimate,
            });
        }
        Ok(RecallPack {
            entries,
            total_tokens,
            dense_hits: dense_ids.len(),
            sparse_hits: sparse_ids.len(),
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rrf_ranks_items_appearing_in_both_sources_highest() {
        // "shared" is rank-1 in dense and rank-2 in sparse -> highest fused score.
        let dense = vec!["shared".to_string(), "only_dense".to_string()];
        let sparse = vec!["only_sparse".to_string(), "shared".to_string()];
        let fused = rrf_fuse(&[dense, sparse], RRF_K);
        assert_eq!(fused[0].0, "shared", "item in both lists must rank first");
        assert_eq!(fused.len(), 3, "dedup leaves 3 unique ids");
    }

    #[test]
    fn rrf_respects_rank_order_within_a_single_source() {
        let only = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let fused = rrf_fuse(&[only], RRF_K);
        assert_eq!(fused[0].0, "a");
        assert_eq!(fused[1].0, "b");
        assert_eq!(fused[2].0, "c");
    }

    #[test]
    fn rrf_empty_input_is_empty() {
        assert!(rrf_fuse(&[], RRF_K).is_empty());
        assert!(rrf_fuse(&[vec![]], RRF_K).is_empty());
    }
}
