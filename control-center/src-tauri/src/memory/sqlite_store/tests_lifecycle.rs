// sqlite_store/tests_lifecycle.rs — Unit tests for candidate lifecycle, status
// filters, pinning, duplicate groups, typed search and archiving, against an
// in-memory connection (no HOME dependency). Split from `tests.rs` to keep both
// files under 800 lines; `mem_conn` is shared from there.

use crate::memory::model::{
    CandidateStatus, MemoryCandidate, MemoryItem, MemoryType, Scope, Source, Status,
};
use crate::memory::MemoryError;

use super::candidates::{get_candidate, insert_candidate, list_candidates, set_candidate_status};
use super::items::{get_item, insert_item, list_by_type_status, list_pinned, search_items};
use super::tests::mem_conn;

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

    super::archive::archive_item(&conn, &item.id, 1_700_000_000_000, "test", None).unwrap();

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
        super::archive::archive_item(&conn, &item.id, 1, "x", None),
        Err(MemoryError::NotFound(_))
    ));
    assert_eq!(super::archive::count_archived(&conn, None), 1);
}
