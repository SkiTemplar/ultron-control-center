//! Archivo de items fuera del retriever (ULTRON 4 F1.7, decisión Q8b del
//! 2026-08-29): una tabla APARTE, `memory_items_archive`, con la fila completa
//! más `archived_at` y `archive_reason`. Un item archivado sale de
//! `memory_items` (y con ello del FTS5 por el trigger `memory_items_ad`, del
//! pack y de reconcile) sin perder el forense: la fila entera queda aquí y el
//! evento queda en `memory_events`.
//!
//! Por qué tabla aparte y no un status: 1.654 `agent_note` (40 % de las filas)
//! que el retriever ya excluía por policy seguían pesando en FTS5, en Qdrant y
//! en cada `SELECT ... WHERE status='active'`. Deprecar las dejaba dentro.
//!
//! Solo SQL. La sincronización con Qdrant y el evento del ledger los pone el
//! servicio (`MemoryService::archive_by_type`), único escritor.

use rusqlite::{params, Connection};

use crate::memory::MemoryError;

pub const ARCHIVE_TABLE: &str = "memory_items_archive";

/// Crea la tabla de archivo si no existe, clonando las columnas actuales de
/// `memory_items` (sin restricciones ni índices: es un almacén forense, no una
/// tabla de trabajo). Idempotente; se llama antes de cada archivado.
pub fn ensure_archive_table(conn: &Connection) -> Result<(), MemoryError> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {ARCHIVE_TABLE} AS \
             SELECT *, CAST(0 AS INTEGER) AS archived_at, CAST('' AS TEXT) AS archive_reason \
             FROM memory_items WHERE 0; \
         CREATE INDEX IF NOT EXISTS idx_{ARCHIVE_TABLE}_type_at ON {ARCHIVE_TABLE}(type, archived_at); \
         CREATE INDEX IF NOT EXISTS idx_{ARCHIVE_TABLE}_id ON {ARCHIVE_TABLE}(id);"
    ))
    .map_err(|e| MemoryError::RemoteUnavailable(format!("ensure_archive_table: {e}")))
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, MemoryError> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| MemoryError::RemoteUnavailable(format!("table_info {table}: {e}")))?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| MemoryError::RemoteUnavailable(format!("table_info {table}: {e}")))?
        .flatten()
        .collect();
    Ok(cols)
}

/// Mueve UNA fila de `memory_items` a `memory_items_archive` en una
/// transacción: copia (solo las columnas que existen en ambas tablas, así una
/// migración futura de `memory_items` no rompe el archivo) y borra el origen.
/// `NotFound` si el id no está en `memory_items`.
pub fn archive_item(
    conn: &Connection,
    id: &str,
    archived_at_ms: i64,
    reason: &str,
) -> Result<(), MemoryError> {
    ensure_archive_table(conn)?;
    let src = table_columns(conn, "memory_items")?;
    let dst = table_columns(conn, ARCHIVE_TABLE)?;
    let cols: Vec<String> = src.into_iter().filter(|c| dst.contains(c)).collect();
    if cols.is_empty() {
        return Err(MemoryError::RemoteUnavailable(
            "archive_item: sin columnas comunes entre memory_items y el archivo".into(),
        ));
    }
    let list = cols.join(", ");
    let sql = format!(
        "INSERT INTO {ARCHIVE_TABLE} ({list}, archived_at, archive_reason) \
         SELECT {list}, ?1, ?2 FROM memory_items WHERE id = ?3"
    );
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| MemoryError::RemoteUnavailable(format!("archive_item begin: {e}")))?;
    let copied = conn
        .execute(&sql, params![archived_at_ms, reason, id])
        .map_err(|e| MemoryError::RemoteUnavailable(format!("archive_item copy: {e}")));
    let outcome = match copied {
        Ok(0) => Err(MemoryError::NotFound(id.to_string())),
        Ok(_) => conn
            .execute("DELETE FROM memory_items WHERE id = ?1", params![id])
            .map(|_| ())
            .map_err(|e| MemoryError::RemoteUnavailable(format!("archive_item delete: {e}"))),
        Err(e) => Err(e),
    };
    match outcome {
        Ok(()) => conn
            .execute_batch("COMMIT;")
            .map_err(|e| MemoryError::RemoteUnavailable(format!("archive_item commit: {e}"))),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

/// Filas archivadas (total, o solo de un tipo).
pub fn count_archived(conn: &Connection, kind: Option<&str>) -> i64 {
    if ensure_archive_table(conn).is_err() {
        return 0;
    }
    let res = match kind {
        Some(k) => conn.query_row(
            &format!("SELECT COUNT(*) FROM {ARCHIVE_TABLE} WHERE type = ?1"),
            params![k],
            |r| r.get::<_, i64>(0),
        ),
        None => conn.query_row(&format!("SELECT COUNT(*) FROM {ARCHIVE_TABLE}"), [], |r| {
            r.get::<_, i64>(0)
        }),
    };
    res.unwrap_or(0)
}
