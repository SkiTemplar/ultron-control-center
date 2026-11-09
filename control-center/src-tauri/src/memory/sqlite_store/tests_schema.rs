// sqlite_store/tests_schema.rs — migraciones de `apply_schema` y lectura de
// valores no canónicos (auditoría Kirkardo 2026-10-26, ronda 2a: M1, M2 y L3).

use rusqlite::{params, Connection};

use crate::memory::model::{MemoryItem, MemoryType, Scope, Sensitivity, Source, Status};

use super::items::{get_item, insert_item};
use super::schema::apply_schema;

fn user_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .expect("user_version")
}

fn total_changes(conn: &Connection) -> i64 {
    conn.query_row("SELECT total_changes()", [], |r| r.get(0))
        .expect("total_changes")
}

fn valid_from_of(conn: &Connection, id: &str) -> Option<i64> {
    conn.query_row(
        "SELECT valid_from FROM memory_items WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .expect("valid_from")
}

fn item_without_valid_from() -> MemoryItem {
    let mut item = MemoryItem::new(
        MemoryType::Fact,
        Scope::Global,
        Source::ToolObserved,
        Status::Active,
    );
    item.summary = Some("hecho de prueba".into());
    item.valid_from = None;
    item
}

/// M1: abrir una base ya migrada no puede escribir. Antes, cada `open_conn`
/// lanzaba `UPDATE memory_items SET valid_from = created_at WHERE valid_from
/// IS NULL`, que tomaba el cerrojo de escritura en cada apertura (también las
/// de solo lectura) y reescribía filas.
#[test]
fn apply_schema_sobre_una_base_migrada_no_escribe() {
    let conn = Connection::open_in_memory().unwrap();
    apply_schema(&conn).unwrap();
    let item = item_without_valid_from();
    insert_item(&conn, &item).unwrap();
    let cambios_antes = total_changes(&conn);

    apply_schema(&conn).unwrap();

    assert_eq!(
        valid_from_of(&conn, &item.id),
        None,
        "una reapertura no debe rellenar valid_from"
    );
    assert_eq!(
        total_changes(&conn),
        cambios_antes,
        "la reapertura escribió"
    );
}

/// M1: el backfill de `valid_from` corre una vez, en su migración versionada,
/// y rellena las filas antiguas.
#[test]
fn la_migracion_temporal_rellena_valid_from_una_vez() {
    let conn = Connection::open_in_memory().unwrap();
    apply_schema(&conn).unwrap();
    let item = item_without_valid_from();
    insert_item(&conn, &item).unwrap();
    conn.execute_batch("PRAGMA user_version = 5;").unwrap();

    apply_schema(&conn).unwrap();

    assert!(valid_from_of(&conn, &item.id).is_some());
    assert!(user_version(&conn) >= 6);
}

/// M1 + L3: si la migración no puede escribir (otro proceso tiene el cerrojo),
/// `apply_schema` devuelve el error y NO sube `user_version`; antes el error se
/// tragaba y la migración se daba por aplicada.
#[test]
fn una_migracion_bloqueada_falla_y_no_sube_la_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("brain.db");
    let a = Connection::open(&path).unwrap();
    a.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    apply_schema(&a).unwrap();
    let item = item_without_valid_from();
    insert_item(&a, &item).unwrap();
    a.execute_batch("PRAGMA user_version = 5;").unwrap();

    let b = Connection::open(&path).unwrap();
    b.execute_batch("BEGIN IMMEDIATE").unwrap();
    a.busy_timeout(std::time::Duration::from_millis(0)).unwrap();

    assert!(
        apply_schema(&a).is_err(),
        "el error de la migración se tragó"
    );
    assert_eq!(user_version(&a), 5, "versión subida sin migrar");

    b.execute_batch("ROLLBACK").unwrap();
    apply_schema(&a).unwrap();
    assert!(valid_from_of(&a, &item.id).is_some());
}

/// M1: una base ya migrada se abre aunque otro proceso tenga el cerrojo de
/// escritura: la apertura no necesita escribir.
#[test]
fn una_base_migrada_se_abre_con_otro_escritor_activo() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("brain.db");
    let a = Connection::open(&path).unwrap();
    a.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    apply_schema(&a).unwrap();
    drop(a);

    let b = Connection::open(&path).unwrap();
    b.execute_batch("BEGIN IMMEDIATE").unwrap();
    let c = Connection::open(&path).unwrap();
    c.busy_timeout(std::time::Duration::from_millis(0)).unwrap();
    apply_schema(&c).expect("abrir una base migrada no debe pedir el cerrojo");
    b.execute_batch("ROLLBACK").unwrap();
}

/// M2: una sensibilidad que no está en el vocabulario se lee como la más
/// restrictiva (`Secret`), no como `Internal`: los gates de recall y resume
/// comparan por igualdad con `Secret`.
#[test]
fn sensibilidad_desconocida_se_lee_como_secret() {
    let conn = Connection::open_in_memory().unwrap();
    apply_schema(&conn).unwrap();
    let item = item_without_valid_from();
    insert_item(&conn, &item).unwrap();
    conn.execute(
        "UPDATE memory_items SET sensitivity = 'SECRET' WHERE id = ?1",
        params![item.id],
    )
    .unwrap();

    let got = get_item(&conn, &item.id).unwrap().expect("item");
    assert_eq!(got.sensitivity, Sensitivity::Secret);
}

/// M2, caso de control: los valores canónicos se leen tal cual.
#[test]
fn sensibilidad_canonica_se_respeta() {
    let conn = Connection::open_in_memory().unwrap();
    apply_schema(&conn).unwrap();
    let item = item_without_valid_from();
    insert_item(&conn, &item).unwrap();
    let got = get_item(&conn, &item.id).unwrap().expect("item");
    assert_eq!(got.sensitivity, Sensitivity::Internal);
}

/// L4: `split_rows` separa las filas válidas de las que fallan y cuenta estas
/// (antes `flatten()` las perdía sin rastro).
#[test]
fn split_rows_cuenta_las_filas_que_fallan() {
    let rows: Vec<rusqlite::Result<i32>> = vec![
        Ok(1),
        Err(rusqlite::Error::InvalidColumnIndex(9)),
        Ok(2),
        Err(rusqlite::Error::InvalidQuery),
    ];
    let (ok, failed) = super::row_mapping::split_rows(rows);
    assert_eq!(ok, vec![1, 2]);
    let (count, first) = failed.expect("hubo fallos");
    assert_eq!(count, 2);
    assert!(matches!(first, rusqlite::Error::InvalidColumnIndex(9)));

    let (ok, failed) = super::row_mapping::split_rows(vec![Ok::<i32, rusqlite::Error>(3)]);
    assert_eq!(ok, vec![3]);
    assert!(failed.is_none());
}

/// Una base anterior al FTS5 (filas sin indexar) se migra sin «database disk
/// image is malformed»: el índice recién creado se reconstruye antes de que
/// el backfill de `valid_from` actualice esas filas, y la búsqueda las ve.
#[test]
fn una_base_sin_fts_se_indexa_al_crear_el_indice() {
    let conn = Connection::open_in_memory().unwrap();
    apply_schema(&conn).unwrap();
    let mut item = item_without_valid_from();
    item.summary = Some("cerradura antigua".into());
    insert_item(&conn, &item).unwrap();
    // Simula la base previa al FTS5: sin índice ni triggers, versión 0.
    conn.execute_batch(
        "DROP TRIGGER memory_items_ai; DROP TRIGGER memory_items_ad;
         DROP TRIGGER memory_items_au; DROP TABLE memory_items_fts;
         PRAGMA user_version = 0;",
    )
    .unwrap();
    conn.execute(
        "UPDATE memory_items SET valid_from = NULL WHERE id = ?1",
        params![item.id],
    )
    .unwrap();

    apply_schema(&conn).expect("migra sin corromper el índice");

    assert!(valid_from_of(&conn, &item.id).is_some());
    let hits: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_items_fts WHERE memory_items_fts MATCH 'cerradura'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hits, 1);
}

/// Prueba manual contra una COPIA de una base real: `ULTRON_PROBE_DB=<ruta>
/// cargo test --lib apply_schema_sobre_copia_real -- --ignored`. Comprueba que
/// abrirla con el esquema actual no pierde items, deja la base íntegra y que
/// una segunda apertura no escribe nada.
#[test]
#[ignore]
fn apply_schema_sobre_copia_real() {
    let path = std::env::var("ULTRON_PROBE_DB").expect("ULTRON_PROBE_DB");
    let conn = Connection::open(&path).expect("open");
    let count = |c: &Connection| -> i64 {
        c.query_row("SELECT count(*) FROM memory_items", [], |r| r.get(0))
            .expect("count")
    };
    let before = count(&conn);
    apply_schema(&conn).expect("primera apertura");
    assert_eq!(count(&conn), before, "la migración no debe perder items");
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .expect("integrity");
    assert_eq!(integrity, "ok");
    let changes = total_changes(&conn);
    apply_schema(&conn).expect("segunda apertura");
    assert_eq!(total_changes(&conn), changes, "reabrir no debe escribir");
    let fts: i64 = conn
        .query_row(
            "SELECT count(*) FROM memory_items_fts WHERE memory_items_fts MATCH 'ultron'",
            [],
            |r| r.get(0),
        )
        .expect("fts");
    assert!(fts > 0, "el índice FTS debe responder tras la migración");
}

// ── Auditoría 2026-10-26, LOW memory: rebuild del FTS y carrera del ALTER ──

fn fts_indexed_rows(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM memory_items_fts_docsize", [], |r| {
        r.get(0)
    })
    .expect("docsize")
}

fn fts_exists(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE name = 'memory_items_fts'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .expect("sqlite_master")
        > 0
}

/// Si el `rebuild` falla tras crear el índice, la apertura siguiente debe
/// volver a reconstruirlo. Con la creación y el `rebuild` en pasos separados,
/// la tabla quedaba creada y vacía, y el `rebuild` no volvía a correr.
#[test]
fn un_rebuild_fts_fallido_se_reintenta_en_la_siguiente_apertura() {
    let conn = Connection::open_in_memory().unwrap();
    // Sin `summary`: el `rebuild` del índice externo falla con "no such column".
    conn.execute_batch(
        "CREATE TABLE memory_items (id TEXT PRIMARY KEY, title TEXT, content TEXT);
         INSERT INTO memory_items VALUES ('a', 'cerradura', 'puerta');",
    )
    .unwrap();

    let err = super::schema_fts::create_fts(&conn).expect_err("el rebuild debe fallar");
    assert!(err.to_string().contains("rebuild"), "{err}");
    assert!(
        !fts_exists(&conn),
        "el fallo no debe dejar el índice a medias"
    );

    conn.execute_batch("ALTER TABLE memory_items ADD COLUMN summary TEXT;")
        .unwrap();
    super::schema_fts::create_fts(&conn).expect("segunda apertura");
    assert_eq!(
        fts_indexed_rows(&conn),
        1,
        "la fila vieja debe quedar indexada"
    );
}

/// Carrera del primer arranque: el sondeo no vio la columna, pero otro proceso
/// la añadió antes del `ALTER`. "duplicate column name" no es un fallo.
#[test]
fn add_column_tolera_la_columna_anadida_por_otro_proceso() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE memory_events (id TEXT, trace_id TEXT);")
        .unwrap();
    super::schema_columns::add_probed_column(&conn, "memory_events", "trace_id", "TEXT")
        .expect("la columna ya existe: objetivo cumplido");
}

/// Caso negativo: cualquier otro error del `ALTER` se sigue propagando.
#[test]
fn add_column_no_se_traga_otros_errores() {
    let conn = Connection::open_in_memory().unwrap();
    let err = super::schema_columns::add_probed_column(&conn, "no_existe", "trace_id", "TEXT")
        .expect_err("tabla inexistente");
    assert!(err.to_string().contains("no such table"), "{err}");
}
