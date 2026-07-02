// tests/e2e.rs — END-TO-END runtime verification (Fase A+B). #[ignore]d because
// it hits the REAL Qdrant (127.0.0.1:6333) + ~/.ultron/brain.db and downloads
// the MultilingualE5Large ONNX (~1.3 GB) on first run. Run explicitly:
//   cargo test --lib -- --ignored --nocapture e2e_full_pipeline
// Requires: Qdrant running + the `qdrant` feature (default ON) + network.

use crate::commands::memory::recall_unified::rrf_fuse;
use crate::commands::memory::recall_unified::types_model::{FANOUT_K, RRF_K};

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

    let decisions = MemoryService::list_active_of_type(MemoryType::Decision, 8).expect("decisions");
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
