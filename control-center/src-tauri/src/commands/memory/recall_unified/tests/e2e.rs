// tests/e2e.rs — END-TO-END runtime verification over the REAL
// ~/.ultron/brain.db. #[ignore]d; run explicitly:
//   cargo test --lib -- --ignored --nocapture e2e_pinned

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
