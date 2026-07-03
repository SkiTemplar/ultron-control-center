// tests/redaction_floor.rs — read-path PII redaction + BM25-tail relevance floor.

use crate::commands::memory::recall_unified::pack::assemble_pack;
use crate::commands::memory::recall_unified::types_model::{FusedHit, PER_CALL_TOKEN_CAP};
use crate::memory::{Scope, Status};

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
    use crate::commands::memory::recall_unified::types_model::SPARSE_TAIL_CUTOFF;
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
