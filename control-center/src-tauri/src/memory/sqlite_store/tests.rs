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
    list_pinned, search_items, touch_injected,
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
fn candidate_prefix_resolves_unique_and_rejects_ambiguous() {
    use super::candidates::find_candidate_ids_by_prefix;
    let conn = mem_conn();
    let mut a = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    a.id = "aabb1111-0000-0000-0000-000000000001".into();
    let mut b = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    b.id = "aabb2222-0000-0000-0000-000000000002".into();
    insert_candidate(&conn, &a).unwrap();
    insert_candidate(&conn, &b).unwrap();

    // Prefijo único -> exactamente 1 match (el UUID completo también resuelve).
    assert_eq!(
        find_candidate_ids_by_prefix(&conn, "aabb1").unwrap(),
        vec![a.id.clone()]
    );
    assert_eq!(
        find_candidate_ids_by_prefix(&conn, &a.id).unwrap(),
        vec![a.id.clone()]
    );
    // Caso negativo 1: prefijo ambiguo -> 2 matches (el caller debe rechazar).
    assert_eq!(
        find_candidate_ids_by_prefix(&conn, "aabb").unwrap().len(),
        2
    );
    // Caso negativo 2: prefijo inexistente -> 0 matches.
    assert!(find_candidate_ids_by_prefix(&conn, "ffff")
        .unwrap()
        .is_empty());
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

#[test]
fn set_candidate_status_if_only_moves_from_the_expected_status() {
    use super::candidates::set_candidate_status_if;
    let conn = mem_conn();
    let c = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    insert_candidate(&conn, &c).unwrap();

    assert!(set_candidate_status_if(
        &conn,
        &c.id,
        CandidateStatus::Pending,
        CandidateStatus::Approved
    )
    .unwrap());
    // Ya aprobado: ninguna transicion desde Pending puede volver a ganar.
    assert!(!set_candidate_status_if(
        &conn,
        &c.id,
        CandidateStatus::Pending,
        CandidateStatus::Approved
    )
    .unwrap());
    assert!(!set_candidate_status_if(
        &conn,
        &c.id,
        CandidateStatus::Pending,
        CandidateStatus::Rejected
    )
    .unwrap());
    assert_eq!(
        get_candidate(&conn, &c.id).unwrap().unwrap().status,
        CandidateStatus::Approved
    );
    // Id inexistente: false, no error.
    assert!(!set_candidate_status_if(
        &conn,
        "nope",
        CandidateStatus::Pending,
        CandidateStatus::Approved
    )
    .unwrap());
}

#[test]
fn active_duplicate_groups_put_the_survivor_first_and_ignore_non_active() {
    use super::items::list_active_duplicate_groups;
    use crate::memory::model::new_id;
    let conn = mem_conn();
    let mut a = MemoryItem::new(
        MemoryType::Fact,
        Scope::Project,
        Source::AssistantInferred,
        Status::Active,
    );
    a.project_id = Some("ultron".to_string());
    a.title = Some("Qdrant nativo".to_string());
    a.summary = Some("qdrant corre nativo en D:".to_string());
    a.created_at = 2_000;
    let mut b = a.clone();
    b.id = new_id();
    b.created_at = 1_000; // mas antiguo: superviviente
    let mut c = a.clone();
    c.id = new_id();
    c.created_at = 3_000;
    c.status = Status::Deprecated; // no cuenta
    let mut otro_proyecto = a.clone();
    otro_proyecto.id = new_id();
    otro_proyecto.project_id = Some("tortunabo".to_string()); // otra clave: no es dup
    let mut distinto = a.clone();
    distinto.id = new_id();
    distinto.summary = Some("otro contenido".to_string());
    for it in [&a, &b, &c, &otro_proyecto, &distinto] {
        insert_item(&conn, it).unwrap();
    }

    let groups = list_active_duplicate_groups(&conn).unwrap();
    assert_eq!(groups.len(), 1, "{groups:?}");
    let ids: Vec<&str> = groups[0].iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec![b.id.as_str(), a.id.as_str()]);
}

#[test]
fn active_duplicate_groups_prefer_pinned_and_validated_survivors() {
    use super::items::list_active_duplicate_groups;
    use crate::memory::model::new_id;
    let conn = mem_conn();
    let mut viejo = MemoryItem::new(
        MemoryType::Decision,
        Scope::Global,
        Source::AssistantInferred,
        Status::Active,
    );
    viejo.summary = Some("decision repetida".to_string());
    viejo.created_at = 1_000;
    let mut validado = viejo.clone();
    validado.id = new_id();
    validado.created_at = 2_000;
    validado.validated_by_user = true;
    let mut pinned = viejo.clone();
    pinned.id = new_id();
    pinned.created_at = 3_000;
    pinned.pinned = true;
    for it in [&viejo, &validado, &pinned] {
        insert_item(&conn, it).unwrap();
    }
    let groups = list_active_duplicate_groups(&conn).unwrap();
    assert_eq!(groups.len(), 1);
    let ids: Vec<&str> = groups[0].iter().map(|i| i.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![pinned.id.as_str(), validado.id.as_str(), viejo.id.as_str()]
    );
}

#[test]
fn search_items_typed_only_returns_the_requested_type() {
    use super::items::search_items_typed;
    let conn = mem_conn();
    let mut leccion = MemoryItem::new(
        MemoryType::Lesson,
        Scope::Project,
        Source::AssistantInferred,
        Status::Active,
    );
    leccion.title = Some("[lesson] Quita los doc-comments de las variantes del enum".to_string());
    leccion.summary = Some("la macro del enum no admite doc-comments en variantes".to_string());
    let mut hecho = MemoryItem::new(
        MemoryType::Fact,
        Scope::Project,
        Source::AssistantInferred,
        Status::Active,
    );
    hecho.title = Some("El enum de tipos usa una macro".to_string());
    hecho.summary = Some("la macro del enum genera las variantes y el parse".to_string());
    let mut leccion_deprecada = leccion.clone();
    leccion_deprecada.id = crate::memory::model::new_id();
    leccion_deprecada.status = Status::Deprecated;
    for it in [&leccion, &hecho, &leccion_deprecada] {
        insert_item(&conn, it).unwrap();
    }

    let todos = search_items(&conn, "macro enum variantes", Status::Active, 10).unwrap();
    assert_eq!(todos.len(), 2, "sin filtro entran ambos tipos: {todos:?}");

    let solo_lecciones = search_items_typed(
        &conn,
        "macro enum variantes",
        Status::Active,
        Some("lesson"),
        10,
    )
    .unwrap();
    let ids: Vec<&str> = solo_lecciones.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec![leccion.id.as_str()], "solo la leccion ACTIVE");

    // Un tipo que no existe en el corpus: lista vacia, no error.
    assert!(
        search_items_typed(&conn, "macro enum", Status::Active, Some("constraint"), 10)
            .unwrap()
            .is_empty()
    );
    // El valor del tipo se sanea: nada de romper el SQL.
    assert!(search_items_typed(
        &conn,
        "macro enum",
        Status::Active,
        Some("x\' OR 1=1 --"),
        10
    )
    .unwrap()
    .is_empty());
}

#[test]
fn archive_item_moves_row_out_of_memory_items_and_fts() {
    let conn = mem_conn();
    let mut item = MemoryItem::new(
        MemoryType::AgentNote,
        Scope::Agent,
        Source::UserExplicit,
        Status::Active,
    );
    item.summary = Some("salida cruda del subagente sobre qdrant".into());
    insert_item(&conn, &item).unwrap();
    let mut keep = MemoryItem::new(
        MemoryType::Decision,
        Scope::Project,
        Source::UserExplicit,
        Status::Active,
    );
    keep.summary = Some("decision que se queda".into());
    insert_item(&conn, &keep).unwrap();

    super::archive::archive_item(&conn, &item.id, 1_700_000_000_000, "test").unwrap();

    assert!(
        get_item(&conn, &item.id).unwrap().is_none(),
        "archived row must leave memory_items"
    );
    assert!(get_item(&conn, &keep.id).unwrap().is_some());
    assert_eq!(super::archive::count_archived(&conn, Some("agent_note")), 1);
    assert_eq!(super::archive::count_archived(&conn, Some("decision")), 0);
    assert_eq!(super::archive::count_archived(&conn, None), 1);
    let (reason, at): (String, i64) = conn
        .query_row(
            "SELECT archive_reason, archived_at FROM memory_items_archive WHERE id = ?1",
            rusqlite::params![item.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(reason, "test");
    assert_eq!(at, 1_700_000_000_000);
    // FTS5: el trigger memory_items_ad quita la fila del índice.
    let hits = search_items(&conn, "subagente", Status::Active, 10).unwrap();
    assert!(hits.is_empty(), "archived row must not be searchable");
    // Negativo: archivar de nuevo (ya no existe) -> NotFound, y el archivo no crece.
    assert!(matches!(
        super::archive::archive_item(&conn, &item.id, 1, "x"),
        Err(MemoryError::NotFound(_))
    ));
    assert_eq!(super::archive::count_archived(&conn, None), 1);
}
