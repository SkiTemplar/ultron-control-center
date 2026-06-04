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
use crate::memory::{
    Actor, EventType, MemoryEvent, MemoryService, Scope, Sensitivity, Source, Status,
};

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
    pub dense_score: Option<f32>, // raw E5 cosine similarity (B1: tie-break / quality signal)
    pub reason: String,           // "why this memory" — e.g. "dense#2 + sparse#5"
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
    pub dense_score: Option<f32>, // raw E5 cosine similarity (B1)
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

/// Assemble the compact context pack from fused candidates: load each item and
/// apply the governance filters — result limit, status=active, project scope
/// (global applies everywhere), sensitivity gate (no Secret), token budget. Pure
/// over the given connection so the security invariants are UNIT-TESTABLE without
/// Qdrant/E5. Returns (injected, discarded, total_tokens).
pub(crate) fn assemble_pack(
    conn: &rusqlite::Connection,
    fused: &[FusedHit],
    limit: usize,
    project_id: Option<&str>,
) -> (Vec<RecallEntry>, Vec<DiscardedHit>, i64) {
    let mut injected: Vec<RecallEntry> = Vec::new();
    let mut discarded: Vec<DiscardedHit> = Vec::new();
    let mut total_tokens = 0i64;
    for fh in fused {
        let discard = |reason: &str| DiscardedHit {
            canonical_id: fh.canonical_id.clone(),
            reason: reason.to_string(),
        };
        if injected.len() >= limit {
            discarded.push(discard("below result limit"));
            continue;
        }
        let item = match store::get_item(conn, &fh.canonical_id) {
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
        // Ola 1b: vault = bulk imported historical knowledge (imported_vault,
        // scope=global, ~92% of the corpus). Under a project filter it floods
        // every query, so it is OFF by default here (still reachable via
        // project-less recall). Cuts cross-project noise without a data migration.
        if project_id.is_some() && item.source == Source::ImportedVault {
            discarded.push(discard("vault off-by-default under project filter"));
            continue;
        }
        // Sensitivity gate (Ola 0 / audit top-risk #2): NEVER inject Secret items.
        if item.sensitivity == Sensitivity::Secret {
            discarded.push(discard("sensitivity=secret (excluded from context pack)"));
            continue;
        }
        if total_tokens + item.token_estimate > TOKEN_BUDGET && !injected.is_empty() {
            discarded.push(discard("token budget exceeded"));
            continue;
        }
        // B4: the FIRST item is allowed even if oversized, but its summary is
        // truncated to the budget so a single huge memory can't blow the pack.
        let (summary, entry_tokens) = if injected.is_empty() && item.token_estimate > TOKEN_BUDGET {
            let max_chars = (TOKEN_BUDGET * 4) as usize; // ~4 chars/token; chars() is UTF-8 safe
            let truncated = item.summary.as_ref().map(|s| {
                let mut t: String = s.chars().take(max_chars).collect();
                t.push_str(" …[truncated to budget]");
                t
            });
            (truncated, TOKEN_BUDGET)
        } else {
            (item.summary.clone(), item.token_estimate)
        };
        total_tokens += entry_tokens;
        let reason = match (fh.dense_rank, fh.sparse_rank) {
            (Some(d), Some(s)) => format!("dense#{} + sparse#{}", d + 1, s + 1),
            (Some(d), None) => format!("dense#{}", d + 1),
            (None, Some(s)) => format!("sparse#{}", s + 1),
            (None, None) => "unranked".to_string(),
        };
        injected.push(RecallEntry {
            canonical_id: item.id.clone(),
            title: item.title.clone(),
            summary, // compact; full content lazy via get_item
            scope: item.scope.as_str().to_string(),
            project_id: item.project_id.clone(),
            score: fh.rrf_score,
            dense_rank: fh.dense_rank,
            sparse_rank: fh.sparse_rank,
            dense_score: fh.dense_score,
            reason,
            token_estimate: entry_tokens,
        });
    }
    (injected, discarded, total_tokens)
}

/// Core hybrid recall + full trace (Retrieval Inspector). Synchronous; both the
/// compact `recall` and the verbose `recall_inspect` derive from this so there is
/// ONE retrieval path. Global-scope items bypass the project filter (they apply
/// everywhere). Emits a `Retrieved` audit event.
pub(crate) fn build_trace(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
) -> Result<RecallTrace, String> {
    use std::collections::HashMap;

    // (1) DENSE — E5 query embedding + Qdrant filtered k-NN (empty if offline).
    //     Score-aware (B1): keep the cosine similarity to break RRF ties.
    let dense_scored = qdrant_index::search_dense_scored(query, FANOUT_K as u32, project_id);
    let dense_ids: Vec<String> = dense_scored.iter().map(|(id, _)| id.clone()).collect();
    let dense_score_map: HashMap<&str, f32> = dense_scored
        .iter()
        .map(|(id, s)| (id.as_str(), *s))
        .collect();
    // (2) SPARSE — FTS5/bm25 over ACTIVE items.
    let sparse_items =
        MemoryService::search_active(query, FANOUT_K).map_err(|e| format!("sparse search: {e}"))?;
    let sparse_ids: Vec<String> = sparse_items.iter().map(|it| it.id.clone()).collect();

    let dense_rank: HashMap<&str, usize> = dense_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let sparse_rank: HashMap<&str, usize> = sparse_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    // (3) RRF fusion + dedup by canonical_id; cosine similarity carried for tie-break.
    let mut fused: Vec<FusedHit> = rrf_fuse(&[dense_ids.clone(), sparse_ids.clone()], RRF_K)
        .into_iter()
        .map(|(id, score)| FusedHit {
            dense_rank: dense_rank.get(id.as_str()).copied(),
            sparse_rank: sparse_rank.get(id.as_str()).copied(),
            dense_score: dense_score_map.get(id.as_str()).copied(),
            canonical_id: id,
            rrf_score: score,
        })
        .collect();
    // B1: tie-break equal RRF scores by REAL cosine similarity. Rank-pure RRF
    // produces many ties; the dense cosine restores a continuous quality signal
    // (the full reranker lands in Ola 4).
    fused.sort_by(|a, b| {
        b.rrf_score
            .partial_cmp(&a.rrf_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.dense_score
                    .unwrap_or(0.0)
                    .partial_cmp(&a.dense_score.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.canonical_id.cmp(&b.canonical_id))
    });

    // (4)+(5) load items + apply governance + budget via the pure assemble_pack
    // (unit-tested without Qdrant — see tests::assemble_pack_enforces_governance_invariants).
    let conn = store::open_conn().map_err(|e| format!("open brain.db: {e}"))?;
    let (injected, discarded, total_tokens) = assemble_pack(&conn, &fused, limit, project_id);

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

/// Sync compact recall pack — reused by the CLI sidecar (`ultron-memory recall`).
pub fn recall_pack(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
) -> Result<RecallPack, String> {
    let t = build_trace(query, limit, project_id)?;
    Ok(RecallPack {
        dense_hits: t.dense_ids.len(),
        sparse_hits: t.sparse_ids.len(),
        total_tokens: t.total_tokens,
        entries: t.injected,
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
        recall_pack(&query, final_limit, project_id.as_deref())
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
    tauri::async_runtime::spawn_blocking(move || {
        build_trace(&query, final_limit, project_id.as_deref())
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

    // Governance invariants of the recall pipeline, unit-tested WITHOUT Qdrant/E5
    // (Ola 3 D2): rejected/deprecated/secret/cross-project NEVER reach the pack;
    // active in-project AND global-scope items DO. Protects Ola 0 + Ola 1a in CI.
    #[test]
    fn assemble_pack_enforces_governance_invariants() {
        use crate::memory::model::MemoryItem;
        use crate::memory::sqlite_store::{apply_schema, insert_item};
        use crate::memory::{MemoryType, Sensitivity, Source};

        let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
        apply_schema(&conn).expect("schema");

        let mut mk =
            |status: Status, scope: Scope, sens: Sensitivity, project: Option<&str>, sm: &str| {
                let mut it = MemoryItem::new(MemoryType::Fact, scope, Source::ToolObserved, status);
                it.summary = Some(sm.to_string());
                it.sensitivity = sens;
                it.project_id = project.map(str::to_string);
                it.token_estimate = 20;
                insert_item(&conn, &it).expect("insert");
                it.id
            };

        let ok = mk(
            Status::Active,
            Scope::Project,
            Sensitivity::Internal,
            Some("ultron"),
            "ok item",
        );
        let rejected = mk(
            Status::Rejected,
            Scope::Project,
            Sensitivity::Internal,
            Some("ultron"),
            "rejected",
        );
        let deprecated = mk(
            Status::Deprecated,
            Scope::Project,
            Sensitivity::Internal,
            Some("ultron"),
            "deprecated",
        );
        let secret = mk(
            Status::Active,
            Scope::Project,
            Sensitivity::Secret,
            Some("ultron"),
            "secret key",
        );
        let cross = mk(
            Status::Active,
            Scope::Project,
            Sensitivity::Internal,
            Some("otro"),
            "cross proj",
        );
        let global = mk(
            Status::Active,
            Scope::Global,
            Sensitivity::Internal,
            None,
            "global pref",
        );
        let vault = {
            let mut it = MemoryItem::new(
                MemoryType::Fact,
                Scope::Global,
                Source::ImportedVault,
                Status::Active,
            );
            it.summary = Some("vault bulk note".into());
            it.token_estimate = 20;
            insert_item(&conn, &it).expect("insert");
            it.id
        };

        let ids = [
            &ok,
            &rejected,
            &deprecated,
            &secret,
            &cross,
            &global,
            &vault,
        ];
        let fused: Vec<FusedHit> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| FusedHit {
                canonical_id: (*id).clone(),
                rrf_score: 1.0 - i as f32 * 0.01,
                dense_rank: Some(i),
                sparse_rank: None,
                dense_score: Some(0.5),
            })
            .collect();

        let (injected, discarded, _t) = assemble_pack(&conn, &fused, 8, Some("ultron"));
        let inj: Vec<&String> = injected.iter().map(|e| &e.canonical_id).collect();

        assert!(inj.contains(&&ok), "active in-project item must inject");
        assert!(
            inj.contains(&&global),
            "global-scope item must inject under project filter"
        );
        assert!(!inj.contains(&&rejected), "rejected must NOT inject");
        assert!(!inj.contains(&&deprecated), "deprecated must NOT inject");
        assert!(
            !inj.contains(&&secret),
            "secret must NOT inject (audit top-risk #2)"
        );
        assert!(!inj.contains(&&cross), "cross-project must NOT inject");
        assert!(
            !inj.contains(&&vault),
            "vault must be off-by-default under project filter (Ola 1b)"
        );
        assert!(
            discarded
                .iter()
                .any(|d| d.canonical_id == secret && d.reason.contains("secret")),
            "secret exclusion must be traced in discarded"
        );
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
                eprintln!(
                    "E5 OK: dim={} all_zero={} first3={:?}",
                    v.len(),
                    all_zero,
                    &v[..3.min(v.len())]
                );
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
        assert!(
            indexed > 0,
            "expected >=1 active item indexed into ultron_memory"
        );

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

    // Verifies the `pinned` ALTER migration on the REAL ~/.ultron/brain.db (943
    // rows) + Session Resume slices + pin/unpin roundtrip. Fast (no reindex).
    #[test]
    #[ignore = "e2e: real brain.db; verifies pinned migration + resume + pin/unpin"]
    fn e2e_pinned_migration_and_resume_slices() {
        use crate::memory::{Actor, MemoryService, MemoryType};

        // init() runs apply_schema -> the idempotent ALTER ADD COLUMN pinned on
        // the existing populated DB. Must not fail.
        crate::memory::sqlite_store::SqliteStore::init().expect("init (pinned migration)");

        let decisions =
            MemoryService::list_active_of_type(MemoryType::Decision, 8).expect("decisions");
        let pinned = MemoryService::list_pinned(12).expect("pinned");
        let stats = MemoryService::stats().expect("stats");
        eprintln!(
            "\n=== RESUME SLICES === active={} decisions={} pinned={} pending_candidates={}",
            stats.active,
            decisions.len(),
            pinned.len(),
            stats.candidates_pending
        );
        assert!(stats.active > 0, "real brain.db must have active items");

        // pin -> appears in list_pinned -> unpin.
        if let Some(d) = decisions.first() {
            MemoryService::pin(&d.id, Actor::User).expect("pin");
            let after = MemoryService::list_pinned(50).expect("pinned after");
            assert!(
                after.iter().any(|p| p.id == d.id),
                "pinned item must appear"
            );
            eprintln!("=== pin/unpin OK on {} ===\n", d.id);
            MemoryService::unpin(&d.id, Actor::User).expect("unpin");
        }
    }
}
