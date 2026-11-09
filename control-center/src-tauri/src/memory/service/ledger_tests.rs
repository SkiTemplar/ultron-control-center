// memory/service/ledger_tests.rs — invariante del ledger: mutación y evento
// van juntos (auditoría 2026-10-23). Antes había 23 `let _ = insert_event(..)`
// y la mutación se confirmaba aunque el evento fallara.
//
// Cada caso negativo instala un trigger que hace fallar cualquier INSERT en
// `memory_events` y comprueba que la mutación se revierte entera.

use rusqlite::Connection;

use super::MemoryService;
use crate::memory::model::{
    Actor, CandidateStatus, EventType, MemoryCandidate, MemoryEvent, MemoryItem, MemoryType, Scope,
    Source, Status,
};
use crate::memory::sqlite_store as store;

fn mem_conn() -> Connection {
    let c = Connection::open_in_memory().expect("open");
    store::apply_schema(&c).expect("schema");
    c
}

fn active(c: &Connection, id: &str) -> MemoryItem {
    let mut it = MemoryItem::new(
        MemoryType::Fact,
        Scope::Project,
        Source::AssistantInferred,
        Status::Active,
    );
    it.id = id.to_string();
    it.title = Some(format!("item {id}"));
    store::insert_item(c, &it).expect("insert");
    it
}

fn break_events(c: &Connection) {
    c.execute_batch(
        "CREATE TRIGGER no_events BEFORE INSERT ON memory_events \
         BEGIN SELECT RAISE(ABORT, 'ledger caido'); END;",
    )
    .expect("trigger");
}

fn events_for(c: &Connection, id: &str) -> usize {
    store::list_events_for(c, id, 100).unwrap().len()
}

fn deprecation_entries(c: &Connection) -> i64 {
    c.query_row("SELECT COUNT(*) FROM deprecation_entries", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn set_status_registra_item_ledger_y_evento() {
    let c = mem_conn();
    active(&c, "a");
    let it = MemoryService::set_status_on(&c, "a", Status::Deprecated, Actor::User, None).unwrap();
    assert_eq!(it.status, Status::Deprecated);
    assert_eq!(events_for(&c, "a"), 1);
    assert_eq!(deprecation_entries(&c), 1);
}

#[test]
fn set_status_sin_evento_no_cambia_el_status() {
    let c = mem_conn();
    active(&c, "a");
    break_events(&c);
    let err = MemoryService::set_status_on(&c, "a", Status::Deprecated, Actor::User, None)
        .expect_err("sin evento la transición debe fallar");
    assert!(err.to_string().contains("ledger caido"), "{err}");
    let it = store::get_item(&c, "a").unwrap().unwrap();
    assert_eq!(it.status, Status::Active, "la transición se revierte");
    assert_eq!(
        deprecation_entries(&c),
        0,
        "ni entrada en el ledger de deprecaciones"
    );
}

#[test]
fn supersede_sin_evento_no_toca_ninguno_de_los_dos_items() {
    let c = mem_conn();
    active(&c, "viejo");
    break_events(&c);
    let mut nuevo = MemoryItem::new(
        MemoryType::Fact,
        Scope::Project,
        Source::AssistantInferred,
        Status::Active,
    );
    nuevo.id = "nuevo".into();
    assert!(MemoryService::supersede_on(&c, "viejo", nuevo, Actor::System).is_err());
    assert!(
        store::get_item(&c, "nuevo").unwrap().is_none(),
        "el nuevo no entra"
    );
    let viejo = store::get_item(&c, "viejo").unwrap().unwrap();
    assert_eq!(viejo.status, Status::Active, "el viejo sigue vigente");
    assert_eq!(viejo.superseded_by, None);
}

#[test]
fn supersede_deja_los_dos_eventos_y_la_entrada() {
    let c = mem_conn();
    active(&c, "viejo");
    let mut nuevo = MemoryItem::new(
        MemoryType::Fact,
        Scope::Project,
        Source::AssistantInferred,
        Status::Active,
    );
    nuevo.id = "nuevo".into();
    let (n, v) = MemoryService::supersede_on(&c, "viejo", nuevo, Actor::System).unwrap();
    assert_eq!((n.status, v.status), (Status::Active, Status::Deprecated));
    assert_eq!((events_for(&c, "viejo"), events_for(&c, "nuevo")), (1, 1));
    assert_eq!(deprecation_entries(&c), 1);
}

#[test]
fn forget_sin_evento_no_borra() {
    let c = mem_conn();
    active(&c, "a");
    break_events(&c);
    assert!(MemoryService::forget_on(&c, "a", Actor::User, None).is_err());
    assert!(
        store::get_item(&c, "a").unwrap().is_some(),
        "el borrado se revierte"
    );
}

#[test]
fn insert_item_with_event_es_atomico() {
    let c = mem_conn();
    break_events(&c);
    let it = MemoryItem::new(
        MemoryType::Fact,
        Scope::Project,
        Source::AssistantInferred,
        Status::Active,
    );
    let ev = MemoryEvent::new(EventType::Edited, Some(it.id.clone()), Actor::User);
    assert!(store::insert_item_with_event(&c, &it, &ev).is_err());
    assert!(store::get_item(&c, &it.id).unwrap().is_none());
}

#[test]
fn rechazar_un_candidato_sin_evento_lo_deja_pending() {
    let c = mem_conn();
    let cand = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    store::insert_candidate(&c, &cand).unwrap();
    break_events(&c);
    assert!(MemoryService::reject_candidate_on(&c, &cand.id, Actor::User, None).is_err());
    let fresh = store::get_candidate(&c, &cand.id).unwrap().unwrap();
    assert_eq!(fresh.status, CandidateStatus::Pending);
}

#[test]
fn archivar_sin_evento_no_mueve_la_fila() {
    let c = mem_conn();
    active(&c, "a");
    break_events(&c);
    let ev = MemoryEvent::new(EventType::Updated, Some("a".into()), Actor::System);
    assert!(store::archive_item(&c, "a", 1, "test", Some(&ev)).is_err());
    assert!(store::get_item(&c, "a").unwrap().is_some());
    assert!(!store::archive_contains(&c, "a").unwrap());
}

// Auditoría 2026-10-23: approve_candidate_on no redactaba. Un candidato
// reescrito fuera de create_candidate (sin su redacción) entraba ACTIVE con la
// credencial y la PII en claro y sensibilidad Internal.
#[test]
fn aprobar_redacta_credenciales_y_pii_y_marca_secret() {
    use crate::memory::model::Sensitivity;
    let c = mem_conn();
    let mut cand = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    cand.proposed_summary =
        Some("token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 de persona@correo-ejemplo.com".into());
    store::insert_candidate(&c, &cand).unwrap();
    let item = MemoryService::approve_candidate_on(&c, &cand.id, Actor::User).unwrap();
    let summary = item.summary.clone().unwrap_or_default();
    assert!(!summary.contains("ghp_ABCDEFGH"), "{summary}");
    assert!(!summary.contains("persona@correo-ejemplo.com"), "{summary}");
    assert_eq!(item.sensitivity, Sensitivity::Secret);
}

#[test]
fn aprobar_texto_limpio_no_lo_toca_ni_lo_marca_secret() {
    use crate::memory::model::Sensitivity;
    let c = mem_conn();
    let mut cand = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    cand.proposed_summary = Some("brain.db es la fuente de verdad".into());
    store::insert_candidate(&c, &cand).unwrap();
    let item = MemoryService::approve_candidate_on(&c, &cand.id, Actor::User).unwrap();
    assert_eq!(
        item.summary.as_deref(),
        Some("brain.db es la fuente de verdad")
    );
    assert_ne!(item.sensitivity, Sensitivity::Secret);
}
