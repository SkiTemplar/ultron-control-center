// sqlite_store/tests.rs — Unit tests against an in-memory connection (no HOME dependency).

use rusqlite::Connection;

use crate::memory::model::{
    Actor, CandidateStatus, EventType, MemoryCandidate, MemoryItem, MemoryType, Scope, Source,
    Status,
};
use crate::memory::MemoryError;

use super::candidates::{get_candidate, insert_candidate, list_candidates, set_candidate_status};
use super::events::{insert_event, list_events_for};
use super::items::{
    delete_item, find_active_by_content_hash, get_item, insert_item, list_by_type_status,
    list_pinned, search_items,
};
use super::row_mapping::{sparse_terms, MAX_SPARSE_TERMS};
use super::schema::apply_schema;

fn mem_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory");
    apply_schema(&conn).expect("schema");
    conn
}

#[test]
fn sparse_terms_caps_and_dedups() {
    // The runtime bug: a long orchestration prompt produced hundreds of terms
    // -> 3N LIKE nodes -> SQLite expression-tree depth overflow. The cap must
    // hold it at <= MAX_SPARSE_TERMS regardless of prompt length.
    let huge = (0..500)
        .map(|i| format!("term{i}"))
        .collect::<Vec<_>>()
        .join(" ");
    assert_eq!(sparse_terms(&huge).len(), MAX_SPARSE_TERMS);

    // <2-char noise dropped; case-insensitive dedup; first-seen order + case.
    let t = sparse_terms("Qdrant qdrant a memoria  memoria E5");
    assert_eq!(t, vec!["Qdrant", "memoria", "E5"]);
}

#[test]
fn insert_then_get_roundtrips_an_item() {
    let conn = mem_conn();
    let mut item = MemoryItem::new(
        MemoryType::Decision,
        Scope::Project,
        Source::UserExplicit,
        Status::Active,
    );
    item.summary = Some("usar bge-m3 para embeddings".into());
    item.project_id = Some("ultron".into());
    item.importance = 0.9;
    insert_item(&conn, &item).unwrap();

    let got = get_item(&conn, &item.id).unwrap().expect("item exists");
    assert_eq!(got.id, item.id);
    assert_eq!(got.kind, MemoryType::Decision);
    assert_eq!(got.status, Status::Active);
    assert_eq!(got.project_id.as_deref(), Some("ultron"));
    assert!((got.importance - 0.9).abs() < 1e-6);
}

#[test]
fn valid_from_valid_to_roundtrip_and_default() {
    let conn = mem_conn();
    // Fresh item: valid_from defaults to created-time, valid_to is None.
    let mut item = MemoryItem::new(
        MemoryType::Decision,
        Scope::Project,
        Source::UserExplicit,
        Status::Active,
    );
    item.summary = Some("usar e5 1024d".into());
    insert_item(&conn, &item).unwrap();
    let got = get_item(&conn, &item.id).unwrap().unwrap();
    assert!(got.valid_from.is_some(), "valid_from defaulted on new()");
    assert!(got.valid_to.is_none(), "valid_to None means still vigente");

    // Setting valid_to (as supersede does) must roundtrip.
    item.valid_to = Some(99_999);
    insert_item(&conn, &item).unwrap();
    let got = get_item(&conn, &item.id).unwrap().unwrap();
    assert_eq!(got.valid_to, Some(99_999), "valid_to persists");
}

#[test]
fn insert_populates_content_hash_and_normalized() {
    let conn = mem_conn();
    let mut item = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    item.summary = Some("  Memoria   Canonica  EN SQLite ".into());
    insert_item(&conn, &item).unwrap();

    let got = get_item(&conn, &item.id).unwrap().expect("item exists");
    assert_eq!(
        got.normalized_text.as_deref(),
        Some("memoria canonica en sqlite")
    );
    assert!(
        got.content_hash.is_some(),
        "content_hash computed on insert"
    );
    assert_eq!(got.schema_version, crate::memory::model::SCHEMA_VERSION);
}

#[test]
fn find_active_by_content_hash_finds_exact_dupe() {
    let conn = mem_conn();
    let mut item = MemoryItem::new(
        MemoryType::Decision,
        Scope::Project,
        Source::UserExplicit,
        Status::Active,
    );
    item.summary = Some("usar sqlite como source of truth".into());
    insert_item(&conn, &item).unwrap();
    let hash = get_item(&conn, &item.id)
        .unwrap()
        .unwrap()
        .content_hash
        .expect("content_hash computed on insert");

    assert_eq!(
        find_active_by_content_hash(&conn, &hash, Scope::Project, None)
            .unwrap()
            .map(|i| i.id),
        Some(item.id)
    );
    assert!(
        find_active_by_content_hash(&conn, "0000000000000000", Scope::Project, None)
            .unwrap()
            .is_none()
    );
}

#[test]
fn find_active_by_content_hash_respects_project_boundary() {
    let conn = mem_conn();
    let mut item = MemoryItem::new(
        MemoryType::Decision,
        Scope::Project,
        Source::UserExplicit,
        Status::Active,
    );
    item.project_id = Some("bank".into());
    item.summary = Some("texto compartido entre proyectos".into());
    insert_item(&conn, &item).unwrap();
    let hash = get_item(&conn, &item.id)
        .unwrap()
        .unwrap()
        .content_hash
        .unwrap();

    // same hash + scope, DIFFERENT project (None) -> NOT a dupe (no cross-project merge)
    assert!(
        find_active_by_content_hash(&conn, &hash, Scope::Project, None)
            .unwrap()
            .is_none(),
        "identical text in another project must not be a duplicate (CONTRACTS §4)"
    );
    // same hash + scope + SAME project -> match
    assert_eq!(
        find_active_by_content_hash(&conn, &hash, Scope::Project, Some("bank"))
            .unwrap()
            .map(|i| i.id),
        Some(item.id)
    );
}

#[test]
fn find_active_by_content_hash_ignores_non_active() {
    let conn = mem_conn();
    let mut item = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Deprecated,
    );
    item.summary = Some("hecho deprecado".into());
    insert_item(&conn, &item).unwrap();
    let hash = get_item(&conn, &item.id)
        .unwrap()
        .unwrap()
        .content_hash
        .unwrap();
    assert!(
        find_active_by_content_hash(&conn, &hash, Scope::Global, None)
            .unwrap()
            .is_none(),
        "non-active items must not be returned as active dupes"
    );
}

#[test]
fn apply_schema_is_idempotent_for_olab_columns() {
    let conn = mem_conn();
    // Re-applying must not error (ADD COLUMN guarded by table_info probe).
    apply_schema(&conn).expect("re-apply once");
    apply_schema(&conn).expect("re-apply twice");
}

#[test]
fn backfill_refills_rows_with_null_content_hash() {
    use super::schema::backfill_derived_columns;
    use rusqlite::params;

    let conn = mem_conn();
    let mut item = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    item.summary = Some("memoria canonica".into());
    insert_item(&conn, &item).unwrap();
    // Simulate a legacy row (pre-OLA-B) and re-arm the one-shot gate.
    conn.execute(
        "UPDATE memory_items SET content_hash=NULL, normalized_text=NULL WHERE id=?1",
        params![item.id],
    )
    .unwrap();
    conn.execute_batch("PRAGMA user_version = 0;").unwrap();

    backfill_derived_columns(&conn);

    let got = get_item(&conn, &item.id).unwrap().expect("item exists");
    assert_eq!(got.normalized_text.as_deref(), Some("memoria canonica"));
    assert_eq!(
        got.content_hash,
        Some(crate::memory::texthash::content_hash("memoria canonica"))
    );
}

#[test]
fn apply_schema_migrates_a_pre_olab_table_and_backfills() {
    // Regression: reproduce the REAL brain.db path (a table predating the
    // OLA B columns). The content_hash index MUST be created after the
    // ALTER ADD COLUMN, else apply_schema aborts with "no such column".
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE memory_items (
            id TEXT PRIMARY KEY, type TEXT NOT NULL, scope TEXT NOT NULL,
            project_id TEXT, repo_id TEXT, branch TEXT, workflow_id TEXT,
            agent_id TEXT, skill_id TEXT, title TEXT, summary TEXT, content TEXT,
            content_json TEXT, tags TEXT, status TEXT NOT NULL DEFAULT 'pending',
            confidence REAL NOT NULL DEFAULT 0.5, importance REAL NOT NULL DEFAULT 0.5,
            stability TEXT NOT NULL DEFAULT 'durable', sensitivity TEXT NOT NULL DEFAULT 'internal',
            source TEXT NOT NULL, source_session_id TEXT, created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, expires_at INTEGER, supersedes TEXT, superseded_by TEXT,
            contradicts TEXT, derived_from TEXT, qdrant_point_id TEXT,
            token_estimate INTEGER NOT NULL DEFAULT 0, access_count INTEGER NOT NULL DEFAULT 0,
            last_accessed_at INTEGER, last_injected_at INTEGER,
            validated_by_user INTEGER NOT NULL DEFAULT 0, validated_at INTEGER,
            pinned INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO memory_items (id,type,scope,summary,status,source,created_at,updated_at)
        VALUES ('legacy','fact','global','memoria legacy','active','tool_observed',0,0);",
    )
    .unwrap();

    apply_schema(&conn).expect("migrate pre-OLA-B schema without aborting");

    let got = get_item(&conn, "legacy")
        .unwrap()
        .expect("legacy item survives migration");
    assert!(
        got.content_hash.is_some(),
        "legacy row is backfilled on migrate"
    );
    assert_eq!(got.schema_version, crate::memory::model::SCHEMA_VERSION);
}

#[test]
fn search_only_returns_active_items() {
    let conn = mem_conn();
    let mut active = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    active.summary = Some("oauth refactor decision".into());
    insert_item(&conn, &active).unwrap();

    let mut rejected = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Rejected,
    );
    rejected.summary = Some("oauth refactor decision".into());
    insert_item(&conn, &rejected).unwrap();

    let hits = search_items(&conn, "oauth", Status::Active, 10).unwrap();
    assert_eq!(
        hits.len(),
        1,
        "rejected items must not surface in active search"
    );
    assert_eq!(hits[0].id, active.id);
}

#[test]
fn search_matches_any_term_not_just_exact_phrase() {
    // B3 regression: a multi-word query must match items containing ANY term
    // (OR), not only the literal phrase (which returned 0 for every multi-word
    // query). Covers both the FTS5 path and, structurally, the LIKE fallback.
    let conn = mem_conn();
    let mut a = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    a.summary = Some("memoria canonica en sqlite".into());
    insert_item(&conn, &a).unwrap();
    let mut b = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    b.summary = Some("indice qdrant vectorial".into());
    insert_item(&conn, &b).unwrap();

    let hits = search_items(&conn, "memoria qdrant", Status::Active, 10).unwrap();
    assert_eq!(
        hits.len(),
        2,
        "multi-term query must match either term (OR), not the exact phrase"
    );
}

#[test]
fn deleted_item_is_gone() {
    let conn = mem_conn();
    let item = MemoryItem::new(
        MemoryType::Task,
        Scope::Session,
        Source::AssistantInferred,
        Status::Active,
    );
    insert_item(&conn, &item).unwrap();
    delete_item(&conn, &item.id).unwrap();
    assert!(get_item(&conn, &item.id).unwrap().is_none());
    assert!(matches!(
        delete_item(&conn, &item.id),
        Err(MemoryError::NotFound(_))
    ));
}

#[test]
fn events_are_appended_and_listed() {
    let conn = mem_conn();
    let id = "mem-1".to_string();
    for et in [EventType::Created, EventType::Edited, EventType::Approved] {
        let ev = crate::memory::model::MemoryEvent::new(et, Some(id.clone()), Actor::User);
        insert_event(&conn, &ev).unwrap();
    }
    let events = list_events_for(&conn, &id, 10).unwrap();
    assert_eq!(events.len(), 3);
}

#[test]
fn candidate_lifecycle_persists() {
    let conn = mem_conn();
    let mut c = MemoryCandidate::new(MemoryType::Decision, Scope::Project);
    c.proposed_summary = Some("rescatar vault historico".into());
    insert_candidate(&conn, &c).unwrap();

    let pending = list_candidates(&conn, CandidateStatus::Pending, 10).unwrap();
    assert_eq!(pending.len(), 1);

    set_candidate_status(&conn, &c.id, CandidateStatus::Approved).unwrap();
    assert_eq!(
        list_candidates(&conn, CandidateStatus::Pending, 10)
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        list_candidates(&conn, CandidateStatus::Approved, 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn rejected_and_quarantined_items_excluded_from_active_search() {
    // "do not use again" (rejected) and quarantine must drop items from recall.
    let conn = mem_conn();
    for status in [Status::Rejected, Status::Quarantined, Status::Deprecated] {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Global,
            Source::ToolObserved,
            status,
        );
        it.summary = Some("oauth token refresh edge case".into());
        insert_item(&conn, &it).unwrap();
    }
    let mut active = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    active.summary = Some("oauth token refresh edge case".into());
    insert_item(&conn, &active).unwrap();

    let hits = search_items(&conn, "oauth", Status::Active, 20).unwrap();
    assert_eq!(hits.len(), 1, "only the ACTIVE item may surface in recall");
    assert_eq!(hits[0].id, active.id);
}

#[test]
fn approving_a_candidate_makes_it_findable_as_active() {
    // Mirrors MemoryService::approve_candidate at the store layer.
    let conn = mem_conn();
    let mut c = MemoryCandidate::new(MemoryType::Decision, Scope::Project);
    c.proposed_summary = Some("usar MultilingualE5Large para recall".into());
    insert_candidate(&conn, &c).unwrap();
    assert!(
        search_items(&conn, "MultilingualE5Large", Status::Active, 10)
            .unwrap()
            .is_empty()
    );

    let item = c.to_item(Status::Active, Source::UserExplicit);
    insert_item(&conn, &item).unwrap();
    set_candidate_status(&conn, &c.id, CandidateStatus::Approved).unwrap();

    let hits = search_items(&conn, "MultilingualE5Large", Status::Active, 10).unwrap();
    assert_eq!(
        hits.len(),
        1,
        "an approved candidate must appear in active recall"
    );
}

#[test]
fn candidate_edit_via_replace_updates_fields() {
    let conn = mem_conn();
    let mut c = MemoryCandidate::new(MemoryType::Fact, Scope::Global);
    c.proposed_summary = Some("original".into());
    insert_candidate(&conn, &c).unwrap();
    c.proposed_summary = Some("editado".into());
    insert_candidate(&conn, &c).unwrap(); // INSERT OR REPLACE
    let got = get_candidate(&conn, &c.id).unwrap().unwrap();
    assert_eq!(got.proposed_summary.as_deref(), Some("editado"));
    assert_eq!(
        list_candidates(&conn, CandidateStatus::Pending, 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn relabel_changes_scope_and_type_persist() {
    let conn = mem_conn();
    let mut it = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::AssistantInferred,
        Status::Active,
    );
    insert_item(&conn, &it).unwrap();
    it.scope = Scope::Project;
    it.kind = MemoryType::Architecture;
    insert_item(&conn, &it).unwrap();
    let got = get_item(&conn, &it.id).unwrap().unwrap();
    assert_eq!(got.scope, Scope::Project);
    assert_eq!(got.kind, MemoryType::Architecture);
}

#[test]
fn pinned_items_listed_unpinned_excluded() {
    let conn = mem_conn();
    let mut pinned = MemoryItem::new(
        MemoryType::Architecture,
        Scope::Project,
        Source::UserExplicit,
        Status::Active,
    );
    pinned.pinned = true;
    pinned.summary = Some("decision fundacional".into());
    insert_item(&conn, &pinned).unwrap();
    let unpinned = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    insert_item(&conn, &unpinned).unwrap();

    let got = list_pinned(&conn, 10).unwrap();
    assert_eq!(got.len(), 1, "only pinned active items are listed");
    assert_eq!(got[0].id, pinned.id);
    assert!(got[0].pinned, "pinned flag must roundtrip");
}

#[test]
fn list_by_type_status_filters_by_type() {
    let conn = mem_conn();
    insert_item(
        &conn,
        &MemoryItem::new(
            MemoryType::Decision,
            Scope::Project,
            Source::UserExplicit,
            Status::Active,
        ),
    )
    .unwrap();
    insert_item(
        &conn,
        &MemoryItem::new(
            MemoryType::Task,
            Scope::Project,
            Source::UserExplicit,
            Status::Active,
        ),
    )
    .unwrap();

    let decisions = list_by_type_status(&conn, MemoryType::Decision, Status::Active, 10).unwrap();
    assert_eq!(decisions.len(), 1);
    assert_eq!(decisions[0].kind, MemoryType::Decision);
    assert_eq!(
        list_by_type_status(&conn, MemoryType::Task, Status::Active, 10)
            .unwrap()
            .len(),
        1
    );
}
