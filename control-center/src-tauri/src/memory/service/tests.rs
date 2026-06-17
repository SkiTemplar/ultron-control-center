// memory/service/tests.rs — governance behaviour tests for MemoryService
//
// Tests drive the low-level store directly through an in-memory conn to assert
// the *governance* behaviour the service guarantees, without depending on the
// real ~/.ultron/brain.db path.

use super::raised_sensitivity;
use crate::memory::model::{
    CandidateStatus, MemoryCandidate, MemoryItem, MemoryType, Scope, Sensitivity, Source, Status,
};
use crate::memory::sqlite_store as store;
use rusqlite::Connection;

fn mem_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    store::apply_schema(&conn).expect("schema");
    conn
}

#[test]
fn rejected_candidate_never_becomes_active_memory() {
    let conn = mem_conn();
    let c = MemoryCandidate::new(MemoryType::Preference, Scope::User);
    store::insert_candidate(&conn, &c).unwrap();
    store::set_candidate_status(&conn, &c.id, CandidateStatus::Rejected).unwrap();

    // No active item should exist for a rejected candidate.
    let active = store::list_items(&conn, Status::Active, 100).unwrap();
    assert!(
        active.is_empty(),
        "rejecting a candidate must not create memory"
    );
}

#[test]
fn pending_item_is_not_recall_eligible() {
    let conn = mem_conn();
    let mut pending = MemoryItem::new(
        MemoryType::Fact,
        Scope::Project,
        Source::AssistantInferred,
        Status::Pending,
    );
    pending.summary = Some("tentative fact about routing".into());
    store::insert_item(&conn, &pending).unwrap();

    let hits = store::search_items(&conn, "routing", Status::Active, 10).unwrap();
    assert!(
        hits.is_empty(),
        "pending memory must not be treated as truth"
    );
}

#[test]
fn deprecated_item_drops_out_of_active_recall() {
    let conn = mem_conn();
    let mut item = MemoryItem::new(
        MemoryType::Decision,
        Scope::Project,
        Source::UserExplicit,
        Status::Active,
    );
    item.summary = Some("use sqlite as canonical store".into());
    store::insert_item(&conn, &item).unwrap();
    assert_eq!(
        store::search_items(&conn, "canonical", Status::Active, 10)
            .unwrap()
            .len(),
        1
    );

    // deprecate
    item.status = Status::Deprecated;
    store::insert_item(&conn, &item).unwrap();
    assert!(store::search_items(&conn, "canonical", Status::Active, 10)
        .unwrap()
        .is_empty());
}

#[test]
fn sensitivity_is_raised_on_secret_and_never_downgraded() {
    // a detected credential raises to Secret regardless of prior class
    assert_eq!(
        raised_sensitivity(Sensitivity::Internal, true),
        Sensitivity::Secret
    );
    assert_eq!(
        raised_sensitivity(Sensitivity::Public, true),
        Sensitivity::Secret
    );
    // no secret -> preserve current; monotonic, never downgrades
    assert_eq!(
        raised_sensitivity(Sensitivity::Internal, false),
        Sensitivity::Internal
    );
    assert_eq!(
        raised_sensitivity(Sensitivity::Secret, false),
        Sensitivity::Secret
    );
}
