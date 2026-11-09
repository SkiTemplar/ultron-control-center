// sqlite_store/schema_fts.rs — índice FTS5 de `memory_items` y sus triggers.

use rusqlite::{Connection, OptionalExtension};

use crate::memory::MemoryError;

use super::schema::exec;
use super::tx::in_immediate_tx;

/// Índice FTS5 de contenido externo y sus triggers de sincronía.
///
/// Si el índice se crea en esta llamada sobre una tabla que ya tenía filas
/// (base anterior al FTS5), se reconstruye: sin eso las filas viejas no están
/// indexadas y el primer UPDATE de una de ellas dispara el trigger
/// `memory_items_au`, que intenta borrar del índice una entrada inexistente y
/// SQLite responde "database disk image is malformed".
///
/// Crear el índice y reconstruirlo van en la MISMA transacción (auditoría
/// 2026-10-26, LOW memory): si el `rebuild` falla (`SQLITE_BUSY`, proceso
/// muerto), el ROLLBACK deshace también la tabla virtual y la apertura
/// siguiente vuelve a crearla y reconstruirla. Con los dos pasos separados, la
/// tabla quedaba creada sin indexar y el `rebuild` no volvía a correr nunca.
pub(super) fn create_fts(conn: &Connection) -> Result<(), MemoryError> {
    if fts_table_exists(conn)? {
        // Camino de cada apertura: sin transacción ni escritura (todo es
        // `IF NOT EXISTS`); repone un trigger que faltase.
        return create_fts_objects(conn);
    }
    create_and_rebuild_fts(conn)
}

/// Crea el índice y lo reconstruye de forma atómica. Vuelve a sondear dentro
/// de la transacción: otro proceso pudo crearlo entre el primer sondeo y el
/// `BEGIN IMMEDIATE`, y entonces ya viene reconstruido.
fn create_and_rebuild_fts(conn: &Connection) -> Result<(), MemoryError> {
    in_immediate_tx(conn, || {
        let existed = fts_table_exists(conn)?;
        create_fts_objects(conn)?;
        if existed {
            return Ok(());
        }
        exec(
            conn,
            "INSERT INTO memory_items_fts(memory_items_fts) VALUES('rebuild');",
            "fts5 rebuild tras crear el índice",
        )
    })
}

fn fts_table_exists(conn: &Connection) -> Result<bool, MemoryError> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE name = 'memory_items_fts'",
        [],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|e| MemoryError::RemoteUnavailable(format!("fts5 probe: {e}")))
}

fn create_fts_objects(conn: &Connection) -> Result<(), MemoryError> {
    exec(
        conn,
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts
            USING fts5(title, summary, content,
                       content='memory_items', content_rowid='rowid');

         CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
             INSERT INTO memory_items_fts(rowid, title, summary, content)
                 VALUES (new.rowid, new.title, new.summary, new.content);
         END;
         CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
             INSERT INTO memory_items_fts(memory_items_fts, rowid, title, summary, content)
                 VALUES ('delete', old.rowid, old.title, old.summary, old.content);
         END;
         CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
             INSERT INTO memory_items_fts(memory_items_fts, rowid, title, summary, content)
                 VALUES ('delete', old.rowid, old.title, old.summary, old.content);
             INSERT INTO memory_items_fts(rowid, title, summary, content)
                 VALUES (new.rowid, new.title, new.summary, new.content);
         END;",
        "schema fts5",
    )
}
