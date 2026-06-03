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
use crate::memory::{Actor, EventType, MemoryEvent, MemoryService, Scope, Status};

const RRF_K: f32 = 60.0; // standard RRF damping constant
const DEFAULT_LIMIT: usize = 8; // final entries returned
const FANOUT_K: usize = 30; // top-K pulled from each source before fusion
const TOKEN_BUDGET: i64 = 1500; // context-pack budget (summaries only)

#[derive(Debug, Clone, Serialize)]
pub struct RecallEntry {
    pub canonical_id: String,
    pub title: Option<String>,
    pub summary: Option<String>, // compact form injected; full content is lazy-loaded
    pub scope: String,
    pub project_id: Option<String>,
    pub score: f32, // RRF fused score
    pub dense_rank: Option<usize>,
    pub sparse_rank: Option<usize>,
    pub reason: String, // "why this memory" — e.g. "dense#2 + sparse#5"
    pub token_estimate: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecallPack {
    pub entries: Vec<RecallEntry>,
    pub total_tokens: i64,
    pub dense_hits: usize,
    pub sparse_hits: usize,
}

/// One fused candidate with its per-source ranks (Retrieval Inspector).
#[derive(Debug, Clone, Serialize)]
pub struct FusedHit {
    pub canonical_id: String,
    pub rrf_score: f32,
    pub dense_rank: Option<usize>,
    pub sparse_rank: Option<usize>,
}

/// A candidate that was retrieved but NOT injected, with the reason why.
#[derive(Debug, Clone, Serialize)]
pub struct DiscardedHit {
    pub canonical_id: String,
    pub reason: String,
}

/// Full per-turn retrieval trace — the Retrieval Inspector / "why this memory?".
#[derive(Debug, Clone, Serialize)]
pub struct RecallTrace {
    pub query: String,
    pub project_filter: Option<String>,
    pub token_budget: i64,
    pub dense_ids: Vec<String>,  // E5/Qdrant order
    pub sparse_ids: Vec<String>, // FTS5 order
    pub fused: Vec<FusedHit>,    // after RRF
    pub injected: Vec<RecallEntry>,
    pub discarded: Vec<DiscardedHit>,
    pub total_tokens: i64,
    pub lazy_load_ids: Vec<String>, // canonical_ids whose full content can be loaded on demand
    pub warnings: Vec<String>,
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

/// Core hybrid recall + full trace (Retrieval Inspector). Synchronous; both the
/// compact `recall` and the verbose `recall_inspect` derive from this so there is
/// ONE retrieval path. Global-scope items bypass the project filter (they apply
/// everywhere). Emits a `Retrieved` audit event.
fn build_trace(query: &str, limit: usize, project_id: Option<&str>) -> Result<RecallTrace, String> {
    use std::collections::HashMap;

    // (1) DENSE — E5 query embedding + Qdrant filtered k-NN (empty if offline).
    let dense_ids = qdrant_index::search_dense(query, FANOUT_K as u32, project_id);
    // (2) SPARSE — FTS5/bm25 over ACTIVE items.
    let sparse_items =
        MemoryService::search_active(query, FANOUT_K).map_err(|e| format!("sparse search: {e}"))?;
    let sparse_ids: Vec<String> = sparse_items.iter().map(|it| it.id.clone()).collect();

    let dense_rank: HashMap<&str, usize> =
        dense_ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    let sparse_rank: HashMap<&str, usize> =
        sparse_ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();

    // (3) RRF fusion + dedup by canonical_id.
    let fused: Vec<FusedHit> = rrf_fuse(&[dense_ids.clone(), sparse_ids.clone()], RRF_K)
        .into_iter()
        .map(|(id, score)| FusedHit {
            dense_rank: dense_rank.get(id.as_str()).copied(),
            sparse_rank: sparse_rank.get(id.as_str()).copied(),
            canonical_id: id,
            rrf_score: score,
        })
        .collect();

    // (4)+(5) load items + build the compact pack under budget; record discards.
    let conn = store::open_conn().map_err(|e| format!("open brain.db: {e}"))?;
    let mut injected: Vec<RecallEntry> = Vec::new();
    let mut discarded: Vec<DiscardedHit> = Vec::new();
    let mut total_tokens = 0i64;
    for fh in &fused {
        let discard = |reason: &str| DiscardedHit {
            canonical_id: fh.canonical_id.clone(),
            reason: reason.to_string(),
        };
        if injected.len() >= limit {
            discarded.push(discard("below result limit"));
            continue;
        }
        let item = match store::get_item(&conn, &fh.canonical_id) {
            Ok(Some(it)) => it,
            _ => {
                discarded.push(discard("unresolvable (no item)"));
                continue;
            }
        };
        if item.status != Status::Active {
            discarded.push(discard(&format!("status={}", item.status.as_str())));
            continue;
        }
        if let Some(pid) = project_id {
            // Global-scope memories apply everywhere; others must match the project.
            if item.scope != Scope::Global && item.project_id.as_deref() != Some(pid) {
                discarded.push(discard(&format!("project filter ({pid})")));
                continue;
            }
        }
        if total_tokens + item.token_estimate > TOKEN_BUDGET && !injected.is_empty() {
            discarded.push(discard("token budget exceeded"));
            continue;
        }
        total_tokens += item.token_estimate;
        let reason = match (fh.dense_rank, fh.sparse_rank) {
            (Some(d), Some(s)) => format!("dense#{} + sparse#{}", d + 1, s + 1),
            (Some(d), None) => format!("dense#{}", d + 1),
            (None, Some(s)) => format!("sparse#{}", s + 1),
            (None, None) => "unranked".to_string(),
        };
        injected.push(RecallEntry {
            canonical_id: item.id.clone(),
            title: item.title.clone(),
            summary: item.summary.clone(), // compact; full content lazy via get_item
            scope: item.scope.as_str().to_string(),
            project_id: item.project_id.clone(),
            score: fh.rrf_score,
            dense_rank: fh.dense_rank,
            sparse_rank: fh.sparse_rank,
            reason,
            token_estimate: item.token_estimate,
        });
    }

    let mut warnings: Vec<String> = Vec::new();
    if dense_ids.is_empty() {
        warnings.push("dense recall empty — E5/Qdrant unavailable; sparse-only".to_string());
    }
    if let Ok(stats) = MemoryService::stats() {
        if stats.candidates_pending > 0 {
            warnings.push(format!(
                "{} memory candidate(s) await validation in the inbox",
                stats.candidates_pending
            ));
        }
    }
    let lazy_load_ids: Vec<String> = injected.iter().map(|e| e.canonical_id.clone()).collect();

    // Audit: record a compact Retrieved event (best-effort).
    let ev = MemoryEvent::new(EventType::Retrieved, None, Actor::System)
        .with_reason(format!(
            "recall '{query}' -> {} injected / {} fused",
            injected.len(),
            fused.len()
        ))
        .with_after(
            serde_json::json!({
                "query": query,
                "injected_ids": lazy_load_ids,
                "total_tokens": total_tokens,
                "dense_hits": dense_ids.len(),
                "sparse_hits": sparse_ids.len(),
            })
            .to_string(),
        );
    let _ = store::insert_event(&conn, &ev);

    Ok(RecallTrace {
        query: query.to_string(),
        project_filter: project_id.map(str::to_string),
        token_budget: TOKEN_BUDGET,
        dense_ids,
        sparse_ids,
        fused,
        injected,
        discarded,
        total_tokens,
        lazy_load_ids,
        warnings,
    })
}

/// Unified hybrid recall — compact context pack. `project_id = None` = no filter.
#[tauri::command]
pub async fn recall(
    query: String,
    limit: Option<u32>,
    project_id: Option<String>,
) -> Result<RecallPack, String> {
    let final_limit = limit.map(|n| n as usize).unwrap_or(DEFAULT_LIMIT);
    tauri::async_runtime::spawn_blocking(move || {
        let t = build_trace(&query, final_limit, project_id.as_deref())?;
        Ok(RecallPack {
            dense_hits: t.dense_ids.len(),
            sparse_hits: t.sparse_ids.len(),
            total_tokens: t.total_tokens,
            entries: t.injected,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Retrieval Inspector: the full per-turn trace (query, filters, dense/sparse
/// ranks, RRF scores, discarded+reason, injected+reason, lazy-load, warnings).
#[tauri::command]
pub async fn recall_inspect(
    query: String,
    limit: Option<u32>,
    project_id: Option<String>,
) -> Result<RecallTrace, String> {
    let final_limit = limit.map(|n| n as usize).unwrap_or(DEFAULT_LIMIT);
    tauri::async_runtime::spawn_blocking(move || build_trace(&query, final_limit, project_id.as_deref()))
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

    // ---------------------------------------------------------------------
    // END-TO-END runtime verification (Fase A+B). #[ignore]d because it hits
    // the REAL Qdrant (127.0.0.1:6333) + ~/.ultron/brain.db and downloads the
    // MultilingualE5Large ONNX (~1.3 GB) on first run. Run explicitly:
    //   cargo test --lib -- --ignored --nocapture e2e_full_pipeline
    // Requires: Qdrant running + the `qdrant` feature (default ON) + network.
    // ---------------------------------------------------------------------
    #[test]
    #[ignore = "e2e: downloads E5 ONNX; surfaces the exact embed_e5 error"]
    fn e2e_embed_e5_smoke() {
        match crate::qdrant::embed_e5("hola mundo, prueba de embedding", false) {
            Ok(v) => {
                let all_zero = v.iter().all(|&x| x == 0.0);
                eprintln!("E5 OK: dim={} all_zero={} first3={:?}", v.len(), all_zero, &v[..3.min(v.len())]);
                assert_eq!(v.len(), 1024, "E5 must be 1024-d");
                assert!(!all_zero, "E5 returned a zero vector");
            }
            Err(e) => panic!("E5 embed FAILED: {e}"),
        }
    }

    #[test]
    #[ignore = "e2e: real Qdrant + brain.db + downloads E5 ONNX; run explicitly"]
    fn e2e_full_pipeline_migrate_reindex_recall() {
        use crate::memory::sqlite_store::{get_item, open_conn};
        use crate::memory::{qdrant_index, MemoryService};

        // 1) Canonical DB live.
        crate::memory::sqlite_store::SqliteStore::init().expect("brain.db init");

        // 2) ETL one-shot (idempotent; backs up brain.db).
        let report = crate::memory::migrations::run_full_etl();
        eprintln!("\n=== ETL REPORT ===\n{report:#?}");

        // 3) Reindex active items into ultron_memory (E5 1024d). First call
        //    downloads the ONNX model — may take minutes.
        let (indexed, errors) = qdrant_index::reindex_all().expect("reindex_all");
        eprintln!("\n=== REINDEX === indexed={indexed} errors={errors}");
        assert!(indexed > 0, "expected >=1 active item indexed into ultron_memory");

        // 4) Hybrid recall (replicates the `recall` command's sync core).
        let query = "qdrant";
        let dense = qdrant_index::search_dense(query, FANOUT_K as u32, None);
        let sparse = MemoryService::search_active(query, FANOUT_K).expect("sparse search");
        let sparse_ids: Vec<String> = sparse.iter().map(|it| it.id.clone()).collect();
        eprintln!(
            "\n=== RECALL '{query}' === dense_hits={} sparse_hits={}",
            dense.len(),
            sparse_ids.len()
        );
        let fused = rrf_fuse(&[dense.clone(), sparse_ids.clone()], RRF_K);
        let conn = open_conn().expect("open brain.db");
        let mut shown = 0;
        for (id, score) in fused.iter().take(8) {
            if let Ok(Some(it)) = get_item(&conn, id) {
                eprintln!(
                    "  [{score:.4}] {} :: {}",
                    it.kind.as_str(),
                    it.summary.clone().unwrap_or_default()
                );
                shown += 1;
            }
        }
        eprintln!("=== recall returned {shown} resolvable items ===\n");

        // Dense path proves E5 + Qdrant work end-to-end; sparse proves FTS5.
        assert!(!fused.is_empty(), "recall fused list must not be empty");
        assert!(
            !dense.is_empty(),
            "DENSE recall empty — E5/Qdrant ultron_memory not working end-to-end"
        );
    }
}
