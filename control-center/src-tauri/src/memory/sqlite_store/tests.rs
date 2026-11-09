// sqlite_store/tests.rs — Unit tests against an in-memory connection (no HOME dependency).

use rusqlite::Connection;

use crate::memory::model::{Actor, EventType, MemoryItem, MemoryType, Scope, Source, Status};
use crate::memory::MemoryError;

use super::events::{insert_event, list_events_for};
use super::items::{
    delete_item, find_active_by_content_hash, get_item, insert_item, search_items, touch_injected,
};
use super::row_mapping::{sparse_terms, MAX_SPARSE_TERMS};
use super::schema::apply_schema;

pub(super) fn mem_conn() -> Connection {
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
fn sparse_terms_drops_stop_words_and_punctuation() {
    // 2026-10-03: "de"/"por"/"que" unidos con OR casaban con medio corpus.
    assert_eq!(
        sparse_terms("mods de Claude Code"),
        vec!["mods", "Claude", "Code"]
    );
    assert_eq!(
        sparse_terms("¿Por qué se apagó el denso?"),
        vec!["apagó", "denso"]
    );
    // Identificadores intactos; la puntuacion de alrededor fuera.
    assert_eq!(
        sparse_terms("(maxTurns, ultron-memory.exe; recall_pack)"),
        vec!["maxTurns", "ultron-memory.exe", "recall_pack"]
    );
    // Una consulta hecha solo de palabras vacias no produce terminos.
    assert!(sparse_terms("de la que por").is_empty());
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

/// Telemetria de utilidad (2026-08-28): las columnas existian desde el primer
/// esquema y nadie las escribia. Este test es la garantia de que a partir de
/// ahora un item inyectado deja huella, y de que uno no inyectado sigue a cero.
#[test]
fn touch_injected_marks_only_the_injected_items() {
    let conn = mem_conn();
    let mut usada = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    usada.summary = Some("memoria que si entra en el pack".into());
    let mut ignorada = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    ignorada.summary = Some("memoria que nunca sale".into());
    insert_item(&conn, &usada).unwrap();
    insert_item(&conn, &ignorada).unwrap();

    let tocadas = touch_injected(&conn, &[usada.id.clone()]);
    let tocadas_de_nuevo = touch_injected(&conn, &[usada.id.clone()]);

    assert_eq!(tocadas, 1);
    assert_eq!(tocadas_de_nuevo, 1);
    let u = get_item(&conn, &usada.id).unwrap().expect("usada existe");
    assert_eq!(u.access_count, 2, "cada inyeccion suma una");
    assert!(u.last_injected_at.is_some());
    assert!(u.last_accessed_at.is_some());
    let i = get_item(&conn, &ignorada.id)
        .unwrap()
        .expect("ignorada existe");
    assert_eq!(i.access_count, 0, "lo no inyectado no se toca");
    assert!(i.last_injected_at.is_none());
    // Lista vacia e ids inexistentes: cero filas, cero errores.
    assert_eq!(touch_injected(&conn, &[]), 0);
    assert_eq!(touch_injected(&conn, &["no-existe".to_string()]), 0);
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

    backfill_derived_columns(&conn).unwrap();

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
fn brain_db_override_solo_con_ruta_no_vacia() {
    use super::schema::brain_db_override;
    use std::ffi::OsString;
    use std::path::PathBuf;
    // Sin variable o vacia: sin override (la base de produccion de siempre).
    assert_eq!(brain_db_override(None), None);
    assert_eq!(brain_db_override(Some(OsString::new())), None);
    // Con ruta: esa ruta tal cual (el harness pasa una base temporal).
    assert_eq!(
        brain_db_override(Some(OsString::from("C:/tmp/kirkardo-ttl/brain.db"))),
        Some(PathBuf::from("C:/tmp/kirkardo-ttl/brain.db"))
    );
}
