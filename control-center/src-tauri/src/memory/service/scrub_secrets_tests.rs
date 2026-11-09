//! Tests de `scrub-secrets` sobre bases temporales. Solo valores ficticios.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::*;
use crate::memory::model::{
    CandidateStatus, MemoryCandidate, MemoryType, Scope, Sensitivity, Source, Status,
};

/// `github_pat_` + 82 caracteres ficticios, con mayúsculas para que la
/// búsqueda en el fichero cubra también la copia en minúsculas de
/// `normalized_text`.
fn fake_pat() -> String {
    let tail: String = "Ab1Cd2Ef3Gh4".chars().cycle().take(82).collect();
    format!("github_pat_{tail}")
}

/// La parte del valor que no es prefijo público, en minúsculas.
fn needle() -> String {
    fake_pat()["github_pat_".len()..].to_lowercase()
}

fn leak_text() -> String {
    format!("salida de la herramienta: GITHUB_TOKEN={} fin", fake_pat())
}

fn open_wal(path: &Path) -> Connection {
    let c = Connection::open(path).expect("open");
    c.execute_batch("PRAGMA journal_mode=WAL;").expect("wal");
    store::apply_schema(&c).expect("schema");
    c
}

fn item(c: &Connection, id: &str, content: &str) {
    let mut it = MemoryItem::new(
        MemoryType::Decision,
        Scope::Project,
        Source::AssistantInferred,
        Status::Active,
    );
    it.id = id.to_string();
    it.title = Some(format!("titulo {id}"));
    it.content = Some(content.to_string());
    store::insert_item(c, &it).expect("insert item");
}

fn rejected_candidate(c: &Connection, id: &str, content: &str) {
    let mut cand = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    cand.id = id.to_string();
    cand.proposed_content = Some(content.to_string());
    store::insert_candidate(c, &cand).expect("insert candidate");
    store::set_candidate_status(c, id, CandidateStatus::Rejected).expect("reject");
}

fn event(c: &Connection, after: &str) {
    let ev = MemoryEvent::new(EventType::Updated, None, Actor::System)
        .with_after(serde_json::json!({ "proposed_content": after }).to_string());
    store::insert_event(c, &ev).expect("insert event");
}

/// Un item, uno archivado, un candidato rechazado y un evento con `text`.
fn seed(c: &Connection, text: &str) {
    item(c, "item-vivo", text);
    item(c, "item-archivado", text);
    store::archive_item(c, "item-archivado", 1, "test", None).expect("archive");
    rejected_candidate(c, "cand-rechazado", text);
    event(c, text);
}

/// Bytes de la base y de su WAL, en minúsculas.
fn file_bytes_lower(path: &Path) -> Vec<u8> {
    let mut bytes = std::fs::read(path).expect("read db");
    let mut wal = PathBuf::from(path).into_os_string();
    wal.push("-wal");
    if let Ok(extra) = std::fs::read(&wal) {
        bytes.extend(extra);
    }
    bytes.to_ascii_lowercase()
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
}

fn count_with_needle(c: &Connection, table: &str, col: &str) -> i64 {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE lower({col}) LIKE ?1");
    c.query_row(&sql, [format!("%{}%", needle())], |r| r.get(0))
        .expect("count")
}

fn event_count(c: &Connection) -> i64 {
    c.query_row("SELECT COUNT(*) FROM memory_events", [], |r| r.get(0))
        .expect("events")
}

#[test]
fn borra_el_valor_de_todas_las_columnas_y_del_fichero() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("brain.db");
    let c = open_wal(&path);
    seed(&c, &leak_text());
    store::checkpoint_truncate(&c).expect("checkpoint");
    // Control: antes del barrido el valor está en el fichero.
    assert!(contains(&file_bytes_lower(&path), &needle()));

    store::enable_secure_delete(&c).expect("secure_delete");
    let (res, touched) = MemoryService::scrub_secrets_on(&c, false, Actor::System).unwrap();
    assert!(res.failed.is_empty(), "{:?}", res.failed);
    assert_eq!(touched.len(), 1);
    assert!(res.fts_rebuilt);
    assert_eq!(res.tables["memory_items"].rows, 1);
    assert_eq!(res.tables["memory_items"].columns["content"], 1);
    assert_eq!(
        res.tables["memory_candidates"].columns["proposed_content"],
        1
    );
    assert_eq!(res.tables["memory_events"].columns["after_json"], 1);
    assert_eq!(res.tables["memory_items_archive"].columns["content"], 1);

    for (table, col) in [
        ("memory_items", "content"),
        ("memory_items", "normalized_text"),
        ("memory_candidates", "proposed_content"),
        ("memory_events", "after_json"),
        ("memory_items_archive", "content"),
        ("memory_items_archive", "normalized_text"),
    ] {
        assert_eq!(count_with_needle(&c, table, col), 0, "{table}.{col}");
    }
    let it = store::get_item(&c, "item-vivo").unwrap().unwrap();
    assert!(it.content.unwrap().contains("[REDACTED:"));
    assert_eq!(it.sensitivity, Sensitivity::Secret);

    // El FTS sigue íntegro y encuentra el item por el texto que quedó.
    assert!(store::fts_integrity(&c).unwrap().in_sync());
    let hits = store::search_items(&c, "herramienta", Status::Active, 5).unwrap();
    assert_eq!(hits.len(), 1);

    secure_compact(&c).expect("compact");
    drop(c);
    assert!(
        !contains(&file_bytes_lower(&path), &needle()),
        "el valor sigue en el fichero"
    );

    // Idempotente: una segunda pasada no encuentra nada.
    let c = open_wal(&path);
    let (again, _) = MemoryService::scrub_secrets_on(&c, false, Actor::System).unwrap();
    assert_eq!(again.rows_changed, 0);
}

// Caso negativo: sin secretos no se reescribe nada ni se añaden eventos.
#[test]
fn texto_sin_secretos_no_se_modifica() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("brain.db");
    let c = open_wal(&path);
    let clean = "brain.db es la fuente de verdad; GITHUB_TOKEN se lee del entorno";
    seed(&c, clean);
    let before_events = event_count(&c);
    let before = store::get_item(&c, "item-vivo").unwrap().unwrap();

    let (res, touched) = MemoryService::scrub_secrets_on(&c, false, Actor::System).unwrap();
    assert_eq!(res.rows_changed, 0);
    assert!(res.tables.is_empty(), "{:?}", res.tables);
    assert!(touched.is_empty());
    assert_eq!(event_count(&c), before_events);
    let after = store::get_item(&c, "item-vivo").unwrap().unwrap();
    assert_eq!(after.content, before.content);
    assert_eq!(after.sensitivity, before.sensitivity);
}

// Caso negativo: el dry-run cuenta pero no escribe.
#[test]
fn dry_run_cuenta_sin_escribir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("brain.db");
    let c = open_wal(&path);
    seed(&c, &leak_text());
    let before_events = event_count(&c);

    let (res, touched) = MemoryService::scrub_secrets_on(&c, true, Actor::System).unwrap();
    assert!(res.dry_run);
    assert!(!res.fts_rebuilt, "el dry-run no reconstruye el FTS");
    assert_eq!(res.rows_changed, 4);
    assert!(touched.is_empty());
    assert_eq!(event_count(&c), before_events);
    assert_eq!(count_with_needle(&c, "memory_items", "content"), 1);
    assert_eq!(
        count_with_needle(&c, "memory_candidates", "proposed_content"),
        1
    );
    assert_eq!(count_with_needle(&c, "memory_events", "after_json"), 1);
}

#[test]
fn la_salida_no_lleva_valores() {
    let dir = tempfile::tempdir().expect("tempdir");
    let c = open_wal(&dir.path().join("brain.db"));
    seed(&c, &leak_text());
    let (res, _) = MemoryService::scrub_secrets_on(&c, true, Actor::System).unwrap();
    let json = serde_json::to_string(&res).unwrap().to_lowercase();
    assert!(!json.contains(&needle()), "{json}");
}

// Caso negativo: con otro lector abierto la compactación no se completa y lo
// dice con error, no lo traga.
#[test]
fn compactar_con_la_base_ocupada_devuelve_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("brain.db");
    let c = open_wal(&path);
    seed(&c, &leak_text());
    c.busy_timeout(std::time::Duration::ZERO)
        .expect("busy_timeout");
    let lector = Connection::open(&path).expect("open lector");
    lector
        .execute_batch("BEGIN; SELECT COUNT(*) FROM memory_items;")
        .expect("lectura abierta");
    let err = secure_compact(&c).expect_err("debe fallar con un lector abierto");
    assert!(!err.to_string().is_empty());
    lector.execute_batch("COMMIT;").expect("commit");
    secure_compact(&c).expect("sin lector, compacta");
}
