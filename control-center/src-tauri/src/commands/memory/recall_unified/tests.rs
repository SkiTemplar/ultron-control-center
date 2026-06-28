// recall_unified/tests.rs

use super::engine::assemble_pack;
use super::types_model::{FusedHit, FANOUT_K, PER_CALL_TOKEN_CAP, RRF_K};
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

// 1.0 (recall cross-project): items con project_id=NULL son AMBIENTE y se inyectan
// bajo un filtro de proyecto (como Global); las memorias de OTRO proyecto IDENTIFICADO
// NO. Sin el fix, el 82% del corpus (NULL) era invisible -> "memoria muerta fuera de
// ULTRON" (en Oryntics: 76 memorias reales devolvian 0).
#[test]
fn assemble_pack_admits_ambient_null_project_items() {
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Sensitivity, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mk = |project: Option<&str>, sm: &str| {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Project,
            Source::ToolObserved,
            Status::Active,
        );
        it.summary = Some(sm.to_string());
        it.sensitivity = Sensitivity::Internal;
        it.project_id = project.map(str::to_string);
        it.token_estimate = 20;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    let ambient = mk(None, "Oryntics es una empresa de IA"); // project_id NULL
    let same = mk(Some("ultron"), "ultron internal"); // otro proyecto
    let foreign = mk(Some("otra-cosa"), "foreign project"); // otro proyecto

    let fused: Vec<FusedHit> = [&ambient, &same, &foreign]
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

    // Recall scoped a "oryntics" (un proyecto SIN memoria propia tagueada).
    let (injected, _d, _t) = assemble_pack(
        &conn,
        &fused,
        8,
        Some("oryntics"),
        false,
        PER_CALL_TOKEN_CAP,
    );
    let inj: Vec<&String> = injected.iter().map(|e| &e.canonical_id).collect();

    assert!(
        inj.contains(&&ambient),
        "item AMBIENTE (project_id=NULL) debe inyectarse bajo filtro de proyecto"
    );
    assert!(
        !inj.contains(&&same) && !inj.contains(&&foreign),
        "memorias de OTRO proyecto IDENTIFICADO NO deben inyectarse"
    );
}

// 1.5 (codebase_fact estructural): los code-locations por símbolo son datos para
// impact-analysis (codegraph MCP + codegraph_summary), NO memoria conversacional. A
// ~478 items saturaban el pack y expulsaban conocimiento real (Kirkardo R5, bulk-deprecate
// 2026-06-07). Aunque un codebase_fact estuviera ACTIVE, NUNCA debe entrar al pack
// conversacional. Guard de regresión: falla si alguien quita la exclusión por kind.
#[test]
fn assemble_pack_excludes_codebase_fact_even_when_active() {
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Sensitivity, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mk = |kind: MemoryType, sm: &str| {
        let mut it = MemoryItem::new(kind, Scope::Project, Source::CodeObserved, Status::Active);
        it.summary = Some(sm.to_string());
        it.sensitivity = Sensitivity::Internal;
        it.project_id = None; // ambiente: saca el filtro de proyecto de la ecuación
        it.token_estimate = 20;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    // Ambos ACTIVE y ambiente: la ÚNICA diferencia es el kind.
    let structural = mk(MemoryType::CodebaseFact, "fn assemble_pack en engine.rs");
    let conversational = mk(MemoryType::Fact, "el usuario prefiere E5 1024d para recall");

    let fused: Vec<FusedHit> = [&structural, &conversational]
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
        assemble_pack(&conn, &fused, 8, None, false, PER_CALL_TOKEN_CAP);
    let inj: Vec<&String> = injected.iter().map(|e| &e.canonical_id).collect();

    assert!(
        !inj.contains(&&structural),
        "un codebase_fact ACTIVE NUNCA debe entrar al pack conversacional (es estructural; va por el codegraph MCP)"
    );
    assert!(
        inj.contains(&&conversational),
        "control: un Fact conversacional ACTIVE sí se inyecta (el filtro es por kind, no global)"
    );
    assert!(
        discarded
            .iter()
            .any(|d| d.canonical_id == structural && d.reason.contains("codebase_fact")),
        "el descarte del codebase_fact debe atribuirse explícitamente a su exclusión por kind"
    );
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
        assemble_pack(&conn, &fused, 8, Some("ultron"), false, PER_CALL_TOKEN_CAP);
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
    let (inj_off, _d, _t) =
        assemble_pack(&conn, &fused, 8, Some("ultron"), false, PER_CALL_TOKEN_CAP);
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
    let (inj_on, disc_on, _t) =
        assemble_pack(&conn, &fused, 8, Some("ultron"), true, PER_CALL_TOKEN_CAP);
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

    let (injected, discarded, _t) =
        assemble_pack(&conn, &fused, 8, None, false, PER_CALL_TOKEN_CAP);
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
// PER-CALL TOKEN CAP — regression for the REMOVED per-session budget.
//
// The old per-session accumulator silenced the memory mid-session: it starved
// every recall after the first few (`evals.rs` even had to reset it before each
// golden query to avoid a false hits=0). After its removal, `assemble_pack` is
// PURE over its `limit_tokens` argument — repeated identical calls yield
// identical packs, so the recall is never silenced mid-session. This is the
// unit-level guard; the full end-to-end check lives in the #[ignore]d e2e tests
// that hit the real brain.db.
// -----------------------------------------------------------------------

#[test]
fn assemble_pack_has_no_cross_call_state() {
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mut it = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    it.summary = Some("stable item".into());
    it.token_estimate = 20;
    insert_item(&conn, &it).expect("insert");

    let fused = vec![FusedHit {
        canonical_id: it.id.clone(),
        rrf_score: 0.9,
        dense_rank: Some(0),
        sparse_rank: None,
        dense_score: Some(0.5),
    }];

    // Three "recalls" in a row with the full per-call cap. The OLD per-session
    // budget would have starved the later calls; now every call is identical.
    let run = || assemble_pack(&conn, &fused, 8, None, false, PER_CALL_TOKEN_CAP);
    let (a, _, ta) = run();
    let (b, _, tb) = run();
    let (c, _, tc) = run();
    assert_eq!(a.len(), 1, "first recall injects the item");
    assert_eq!(b.len(), a.len(), "second recall is NOT starved");
    assert_eq!(c.len(), a.len(), "third recall is NOT starved");
    assert_eq!(
        (ta, tb, tc),
        (ta, ta, ta),
        "token totals are stable across calls (no cross-call state)"
    );
}

#[test]
fn assemble_pack_respects_per_call_token_cap() {
    // assemble_pack receives only 30 tokens — only items that fit are admitted.
    // The per-call cap bounds a single oversized item; there is no per-session
    // budget anymore.
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

// -----------------------------------------------------------------------
// READ-PATH PII gate (assemble_pack). Verifies that summary text containing
// PII (email, phone, user path) is redacted BEFORE it enters the context
// pack, even when the item is stored without a `Secret` sensitivity tag.
// This is the defence-in-depth guard for items persisted before the
// write-path PII classifier existed. Negative case: a clean summary is
// returned verbatim.
// -----------------------------------------------------------------------
#[test]
fn assemble_pack_redacts_pii_in_summary() {
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Sensitivity, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    // Item with PII in summary but sensitivity=Internal (not yet elevated):
    // simulates a legacy item stored before the write-path PII gate existed.
    let mut pii_item = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    pii_item.summary = Some(
        "contacto test@example.com tel +34 698 123 456 ruta C:/Users/TestUser/secret.txt"
            .to_string(),
    );
    pii_item.sensitivity = Sensitivity::Internal; // NOT escalated — pre-gate row
    pii_item.token_estimate = 40;
    insert_item(&conn, &pii_item).expect("insert pii_item");

    // Clean item: must pass through unchanged.
    let mut clean_item = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    clean_item.summary = Some("arquitectura de memoria ULTRON brain.db".to_string());
    clean_item.sensitivity = Sensitivity::Internal;
    clean_item.token_estimate = 20;
    insert_item(&conn, &clean_item).expect("insert clean_item");

    let fused: Vec<FusedHit> = vec![
        FusedHit {
            canonical_id: pii_item.id.clone(),
            rrf_score: 0.9,
            dense_rank: Some(0),
            sparse_rank: None,
            dense_score: Some(0.9),
        },
        FusedHit {
            canonical_id: clean_item.id.clone(),
            rrf_score: 0.8,
            dense_rank: Some(1),
            sparse_rank: None,
            dense_score: Some(0.8),
        },
    ];

    let (injected, _discarded, _tokens) =
        assemble_pack(&conn, &fused, 8, None, false, PER_CALL_TOKEN_CAP);

    // Both items must be injected (they are Active and within budget).
    assert_eq!(injected.len(), 2, "both active items must be injected");

    let pii_entry = injected
        .iter()
        .find(|e| e.canonical_id == pii_item.id)
        .expect("pii item must be in pack");

    // NEGATIVE CASE: the raw PII must NOT appear in the injected summary.
    let injected_summary = pii_entry.summary.as_deref().unwrap_or("");
    assert!(
        !injected_summary.contains("test@example.com"),
        "raw email must be absent from injected summary; got: {injected_summary}"
    );
    assert!(
        !injected_summary.contains("698 123 456"),
        "raw phone must be absent from injected summary; got: {injected_summary}"
    );
    assert!(
        !injected_summary.contains("TestUser"),
        "raw user path must be absent from injected summary; got: {injected_summary}"
    );
    // Redaction placeholders must be present.
    assert!(
        injected_summary.contains("[REDACTED_EMAIL]"),
        "email placeholder must be present; got: {injected_summary}"
    );
    assert!(
        injected_summary.contains("[REDACTED_PHONE]"),
        "phone placeholder must be present; got: {injected_summary}"
    );
    assert!(
        injected_summary.contains("[REDACTED_PATH]"),
        "path placeholder must be present; got: {injected_summary}"
    );

    // Clean item must NOT be modified.
    let clean_entry = injected
        .iter()
        .find(|e| e.canonical_id == clean_item.id)
        .expect("clean item must be in pack");
    assert_eq!(
        clean_entry.summary.as_deref(),
        Some("arquitectura de memoria ULTRON brain.db"),
        "clean summary must be returned verbatim"
    );
}

// Relevance floor (Pilar #1 — "trae lo correcto y POCO"). A fused hit with NO
// dense backing whose sparse rank is in the BM25 TAIL (>= SPARSE_TAIL_CUTOFF) is
// lexical noise (shares a stray term; E5 did not rank it relevant) and must be
// DROPPED — this is the fix for the "Mundial 2026 / menú de 5 decisiones" class
// of irrelevant memories that flooded the orchestrate pack. dense-backed hits
// (any rank) and sparse-TOP hits (rank < cutoff) must still inject. Unit-tested
// without Qdrant/E5; falls RED if the floor is removed.
#[test]
fn assemble_pack_drops_bm25_tail_without_dense_backing() {
    use super::super::types_model::SPARSE_TAIL_CUTOFF;
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Sensitivity, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mk = |sm: &str| {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Global,
            Source::ToolObserved,
            Status::Active,
        );
        it.summary = Some(sm.to_string());
        it.sensitivity = Sensitivity::Internal;
        it.project_id = None; // ambiente: saca el filtro de proyecto de la ecuación
        it.token_estimate = 20;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    let dense_backed = mk("relevante via semantica E5"); // dense_rank=Some -> pasa
    let sparse_top = mk("relevante via BM25 termino fuerte"); // sparse rank bajo -> pasa
    let bm25_tail = mk("Fuente de datos cambiada a TheSportsDB para el Mundial 2026"); // cola sin dense -> FUERA

    let fused = vec![
        FusedHit {
            canonical_id: dense_backed.clone(),
            rrf_score: 0.030,
            dense_rank: Some(5),
            sparse_rank: None,
            dense_score: Some(0.82),
        },
        FusedHit {
            canonical_id: sparse_top.clone(),
            rrf_score: 0.025,
            dense_rank: None,
            sparse_rank: Some(2), // top BM25 (< cutoff)
            dense_score: None,
        },
        FusedHit {
            canonical_id: bm25_tail.clone(),
            rrf_score: 0.018,
            dense_rank: None,
            sparse_rank: Some(SPARSE_TAIL_CUTOFF + 5), // cola BM25, sin dense
            dense_score: None,
        },
    ];

    let (injected, discarded, _t) =
        assemble_pack(&conn, &fused, 8, None, false, PER_CALL_TOKEN_CAP);
    let inj: Vec<&String> = injected.iter().map(|e| &e.canonical_id).collect();

    assert!(
        inj.contains(&&dense_backed),
        "un hit con respaldo dense (cualquier rango) debe inyectarse"
    );
    assert!(
        inj.contains(&&sparse_top),
        "un hit sparse-TOP (rank < cutoff) debe inyectarse aunque no tenga dense"
    );
    assert!(
        !inj.contains(&&bm25_tail),
        "un hit de cola BM25 sin respaldo dense NO debe inyectarse (relevance floor)"
    );
    assert!(
        discarded
            .iter()
            .any(|d| d.canonical_id == bm25_tail && d.reason.contains("relevance floor")),
        "el descarte de la cola BM25 debe atribuirse al relevance floor"
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
