// tests/budget.rs — per-call token cap + statelessness across calls.
//
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

use crate::commands::memory::recall_unified::engine::assemble_pack;
use crate::commands::memory::recall_unified::types_model::{FusedHit, PER_CALL_TOKEN_CAP};
use crate::memory::{Scope, Status};

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

// (cat1, 2026-07-02) — clamp por entrada: un item GORDO no desaloja a los que
// vienen detras. Antes, resumenes de subagente de ~565 tokens comian el cap de
// 1500 y un relevante en fused#3 caia por "token budget exceeded" (diagnostico
// `trace` del golden set: 6 expect_ids desalojados asi, uno en rank 3).
#[test]
fn fat_entries_are_clamped_not_evicting_later_items() {
    use crate::commands::memory::recall_unified::types_model::ENTRY_TOKEN_CLAMP;
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mut fused = Vec::new();
    for i in 0..3 {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Global,
            Source::ToolObserved,
            Status::Active,
        );
        // Resumen de subagente tipico: ~2400 chars ≈ 600 tokens.
        it.summary = Some(format!("resumen gordo {i} ").repeat(150));
        it.token_estimate = 600;
        insert_item(&conn, &it).expect("insert");
        fused.push(FusedHit {
            canonical_id: it.id.clone(),
            rrf_score: 0.9 - (i as f32) * 0.1,
            dense_rank: Some(i),
            sparse_rank: None,
            dense_score: Some(0.85),
        });
    }

    let (injected, discarded, total) =
        assemble_pack(&conn, &fused, 8, None, false, PER_CALL_TOKEN_CAP);

    assert_eq!(
        injected.len(),
        3,
        "los 3 caben: el clamp trunca al gordo, no desaloja al siguiente"
    );
    assert!(
        discarded.iter().all(|d| !d.reason.contains("token budget")),
        "nadie desalojado por presupuesto: {discarded:?}"
    );
    assert!(
        injected
            .iter()
            .all(|e| e.token_estimate <= ENTRY_TOKEN_CLAMP),
        "cada entrada aporta <= ENTRY_TOKEN_CLAMP"
    );
    assert!(total <= PER_CALL_TOKEN_CAP, "el total respeta el cap");
    // El truncado se declara en el texto inyectado (caso negativo: no silencioso).
    assert!(
        injected[0]
            .summary
            .as_deref()
            .unwrap_or("")
            .contains("truncated"),
        "el resumen truncado lo declara"
    );
}
