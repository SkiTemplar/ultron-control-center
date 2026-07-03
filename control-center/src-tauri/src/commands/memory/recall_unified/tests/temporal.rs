// tests/temporal.rs — temporal resolver (valid_to) + TTL (expires_at) gates.

use crate::commands::memory::recall_unified::pack::assemble_pack;
use crate::commands::memory::recall_unified::types_model::{FusedHit, PER_CALL_TOKEN_CAP};
use crate::memory::{Scope, Status};

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

// TTL (cat21.3): an ACTIVE item whose `expires_at` is in the PAST must be
// excluded from the pack; `expires_at` NULL (no TTL) or a FUTURE expiry inject
// normally. Negative case: without the engine TTL filter the expired item leaks
// into recall (mandamiento 12 — expired data polluting context). Same millis
// basis as valid_to/now_millis(). Unit-tested without Qdrant/E5.
#[test]
fn assemble_pack_excludes_expired_ttl_items() {
    use crate::memory::model::{now_millis, MemoryItem};
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mk = |summary: &str, expires_at: Option<i64>| {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Global,
            Source::ToolObserved,
            Status::Active,
        );
        it.summary = Some(summary.to_string());
        it.token_estimate = 20;
        it.expires_at = expires_at;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    let now = now_millis();
    let no_ttl = mk("no expiry", None); // never expires -> always vigente
    let future = mk("expires later", Some(now + 1_000_000)); // future TTL
    let expired = mk("ttl elapsed", Some(now - 1)); // past TTL -> dead

    let ids = [&no_ttl, &future, &expired];
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

    assert!(inj.contains(&&no_ttl), "expires_at NULL must inject");
    assert!(inj.contains(&&future), "future expires_at must inject");
    assert!(
        !inj.contains(&&expired),
        "past expires_at must be excluded (TTL elapsed)"
    );
    assert!(
        discarded
            .iter()
            .any(|d| d.canonical_id == expired && d.reason.contains("expires_at")),
        "TTL exclusion must be traced in discarded"
    );
}
