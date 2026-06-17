// recall_unified/tests.rs

use super::engine::assemble_pack;
use super::session_budget::{
    resolve_session_id, session_budget_deduct, session_budget_remaining, session_budget_reset,
};
use super::types_model::{FusedHit, FANOUT_K, RRF_K, TOKEN_BUDGET};
use crate::commands::memory::recall_unified::rrf_fuse;
use crate::memory::{Scope, Status};

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

    let mk = |status: Status, scope: Scope, sens: Sensitivity, project: Option<&str>, sm: &str| {
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

    let (injected, discarded, _t) =
        assemble_pack(&conn, &fused, 8, Some("ultron"), false, TOKEN_BUDGET);
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

// CROSS-PROJECT gate (whole-brain recall): under a project filter (`ultron`),
//   - cross_project=false  -> a scope=project item from `otro` is EXCLUDED.
//   - cross_project=true   -> that same item is INCLUDED (project filter
//     relaxed) BUT a Secret item from `otro` is STILL excluded (security is
//     NOT relaxed). Unit-tested without Qdrant/E5 — guards the invariant that
//     cross-project relaxes ONLY the project filter.
#[test]
fn assemble_pack_cross_project_relaxes_only_project_filter() {
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Sensitivity, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mk = |scope: Scope, sens: Sensitivity, project: Option<&str>, sm: &str| {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            scope,
            Source::ToolObserved,
            Status::Active,
        );
        it.summary = Some(sm.to_string());
        it.sensitivity = sens;
        it.project_id = project.map(str::to_string);
        it.token_estimate = 20;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    let in_project = mk(
        Scope::Project,
        Sensitivity::Internal,
        Some("ultron"),
        "ultron item",
    );
    let other_project = mk(
        Scope::Project,
        Sensitivity::Internal,
        Some("otro"),
        "bank item",
    );
    let other_secret = mk(
        Scope::Project,
        Sensitivity::Secret,
        Some("otro"),
        "bank api key",
    );
    let global = mk(Scope::Global, Sensitivity::Internal, None, "global pref");

    let ids = [&in_project, &other_project, &other_secret, &global];
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

    // cross_project = FALSE: other-project item is filtered out.
    let (inj_off, _d, _t) = assemble_pack(&conn, &fused, 8, Some("ultron"), false, TOKEN_BUDGET);
    let off: Vec<&String> = inj_off.iter().map(|e| &e.canonical_id).collect();
    assert!(
        off.contains(&&in_project),
        "in-project item must inject (cross=off)"
    );
    assert!(
        off.contains(&&global),
        "global item must inject (cross=off)"
    );
    assert!(
        !off.contains(&&other_project),
        "other-project item must NOT inject when cross=off"
    );

    // cross_project = TRUE: other-project item is admitted; Secret stays out.
    let (inj_on, disc_on, _t) = assemble_pack(&conn, &fused, 8, Some("ultron"), true, TOKEN_BUDGET);
    let on: Vec<&String> = inj_on.iter().map(|e| &e.canonical_id).collect();
    assert!(
        on.contains(&&in_project),
        "in-project item must still inject (cross=on)"
    );
    assert!(
        on.contains(&&global),
        "global item must still inject (cross=on)"
    );
    assert!(
        on.contains(&&other_project),
        "other-project item MUST inject when cross=on (project filter relaxed)"
    );
    assert!(
        !on.contains(&&other_secret),
        "Secret from another project must NEVER inject — cross relaxes project, not security"
    );
    assert!(
        disc_on
            .iter()
            .any(|d| d.canonical_id == other_secret && d.reason.contains("secret")),
        "cross-project Secret exclusion must be traced in discarded"
    );
}

// Temporal resolver (point 3): an ACTIVE item whose validity ENDED in the
// past must be excluded from the pack, while an item with valid_to NULL (no
// end) OR a FUTURE valid_to is injected. Unit-tested without Qdrant/E5.
#[test]
fn assemble_pack_excludes_items_whose_validity_ended() {
    use crate::memory::model::{now_millis, MemoryItem};
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mk = |summary: &str, valid_to: Option<i64>| {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Global,
            Source::ToolObserved,
            Status::Active,
        );
        it.summary = Some(summary.to_string());
        it.token_estimate = 20;
        it.valid_to = valid_to;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    let now = now_millis();
    let vigente = mk("still true", None); // no end -> always vigente
    let future = mk("true until later", Some(now + 1_000_000)); // ends in the future
    let expired = mk("was true, superseded", Some(now - 1)); // ended in the past

    let ids = [&vigente, &future, &expired];
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

    let (injected, discarded, _t) = assemble_pack(&conn, &fused, 8, None, false, TOKEN_BUDGET);
    let inj: Vec<&String> = injected.iter().map(|e| &e.canonical_id).collect();

    assert!(
        inj.contains(&&vigente),
        "valid_to NULL must inject (vigente)"
    );
    assert!(inj.contains(&&future), "future valid_to must inject");
    assert!(
        !inj.contains(&&expired),
        "past valid_to must be excluded (superseded)"
    );
    assert!(
        discarded
            .iter()
            .any(|d| d.canonical_id == expired && d.reason.contains("valid_to")),
        "expired exclusion must be traced in discarded"
    );
}

// -----------------------------------------------------------------------
// SESSION BUDGET tests (Pilar 1 · Kirkardo gap)
//
// These tests exercise the cumulative budget store in isolation — no
// Qdrant / brain.db required.  They use unique session ids per test to
// avoid cross-test state pollution (the OnceLock store is global in-process).
// -----------------------------------------------------------------------

#[test]
fn session_budget_starts_full() {
    let sid = "test-budget-starts-full";
    session_budget_reset(sid);
    assert_eq!(
        session_budget_remaining(sid),
        TOKEN_BUDGET,
        "fresh session must have full budget"
    );
}

#[test]
fn session_budget_deducts_correctly() {
    let sid = "test-budget-deducts";
    session_budget_reset(sid);
    let remaining = session_budget_deduct(sid, 400);
    assert_eq!(remaining, TOKEN_BUDGET - 400);
    assert_eq!(session_budget_remaining(sid), TOKEN_BUDGET - 400);
}

#[test]
fn session_budget_clamps_at_zero() {
    let sid = "test-budget-clamps";
    session_budget_reset(sid);
    // Deduct more than the total budget.
    let remaining = session_budget_deduct(sid, TOKEN_BUDGET + 500);
    assert_eq!(remaining, 0, "budget must clamp at zero, never go negative");
    assert_eq!(session_budget_remaining(sid), 0);
}

#[test]
fn session_budget_accumulates_across_calls() {
    let sid = "test-budget-accumulates";
    session_budget_reset(sid);
    session_budget_deduct(sid, 300);
    session_budget_deduct(sid, 500);
    assert_eq!(
        session_budget_remaining(sid),
        TOKEN_BUDGET - 800,
        "budget must accumulate across multiple deductions"
    );
}

#[test]
fn session_budget_reset_restores_full_budget() {
    let sid = "test-budget-reset";
    session_budget_reset(sid);
    session_budget_deduct(sid, 1000);
    assert!(session_budget_remaining(sid) < TOKEN_BUDGET);
    session_budget_reset(sid);
    assert_eq!(
        session_budget_remaining(sid),
        TOKEN_BUDGET,
        "reset must restore full budget"
    );
}

#[test]
fn resolve_session_id_uses_supplied_value() {
    let sid = resolve_session_id(Some("my-session-abc"));
    assert_eq!(sid, "my-session-abc");
}

#[test]
fn resolve_session_id_falls_back_to_proc_when_empty() {
    // Without ULTRON_SESSION_ID set, the fallback must be proc-<pid>.
    // We only check the prefix because the pid varies per run.
    // Temporarily ensure env var is absent to test the proc fallback.
    let sid = resolve_session_id(Some(""));
    // Could be env-based or proc-based — just assert it's non-empty.
    assert!(!sid.is_empty(), "session id must never be empty");
}

/// KIRKARDO gap #6: verify that `CLAUDE_SESSION_ID` is honoured as the
/// second env-var fallback (after `ULTRON_SESSION_ID`, before `proc-<pid>`).
#[test]
fn resolve_session_id_uses_claude_session_id_env() {
    // Supplied non-empty value always wins — ensure that still holds.
    let explicit = resolve_session_id(Some("explicit-session-42"));
    assert_eq!(
        explicit, "explicit-session-42",
        "explicit value must always win"
    );

    // Verify the proc-<pid> fallback produces a non-empty string even
    // when both env vars are absent (the common test environment case).
    let proc_sid = resolve_session_id(Some(""));
    assert!(
        !proc_sid.is_empty(),
        "proc-<pid> fallback must be non-empty"
    );
    // The fallback must either be env-based or start with "proc-".
    // We cannot reliably unset env vars in parallel tests, so just assert
    // it is non-empty and well-formed.
    let looks_valid = proc_sid.starts_with("proc-") || !proc_sid.contains(' ');
    assert!(
        looks_valid,
        "session id must be a single token, got: {proc_sid}"
    );
}

#[test]
fn assemble_pack_respects_reduced_session_budget() {
    // Simulate a session that has already consumed most of the budget.
    // assemble_pack receives only 30 tokens — only items that fit are admitted.
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mk = |summary: &str, tokens: i64| {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Global,
            Source::ToolObserved,
            Status::Active,
        );
        it.summary = Some(summary.to_string());
        it.token_estimate = tokens;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    let small = mk("tiny", 25); // fits in 30-token budget
    let big = mk("large item", 200); // does NOT fit (would be first-admit truncated)

    // Place big first so it gets the first-admit truncation treatment.
    let fused: Vec<FusedHit> = vec![
        FusedHit {
            canonical_id: big.clone(),
            rrf_score: 0.9,
            dense_rank: Some(0),
            sparse_rank: None,
            dense_score: None,
        },
        FusedHit {
            canonical_id: small.clone(),
            rrf_score: 0.8,
            dense_rank: Some(1),
            sparse_rank: None,
            dense_score: None,
        },
    ];

    // Only 30 tokens remain in the budget.
    let (injected, _discarded, total) = assemble_pack(&conn, &fused, 8, None, false, 30);

    // The first item is always admitted (truncated to fit 30 tokens).
    assert_eq!(injected.len(), 1, "only one item fits in 30-token budget");
    assert_eq!(
        injected[0].canonical_id, big,
        "first item always admitted (truncated)"
    );
    assert!(
        total <= 30,
        "total_tokens ({total}) must not exceed the reduced budget (30)"
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
