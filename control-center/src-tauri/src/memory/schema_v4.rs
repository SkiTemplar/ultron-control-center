// ULTRON Control Center — Schema v5: RETIRADA del codegraph interno (2026-07-02)
//
// La v4 (2026-06-06) introdujo un code-graph propio en brain.db (`edges` +
// `unresolved_refs`). Veredicto mandamiento 12 (2026-07-02): NUNCA se justificó —
// 211 edges congeladas desde ~06-08, productor (capture-symbols.js) descableado,
// CERO lectores (ningún traversal; el panel Codegraph lee `.codegraph/codegraph.db`
// del indexador externo, no brain.db). El codegraph MCP externo cubre la necesidad
// real (callers/callees/impact) y sigue vivo — esto NO lo toca.
//
// Esta migración retira ambas tablas y sube `user_version` 4 → 5.
//
// SAFETY CONTRACT:
//   - Solo DROP TABLE IF EXISTS de las DOS tablas del codegraph interno; ninguna
//     otra tabla (memory_items, kg_entities, …) se altera.
//   - `user_version` solo sube (monotónico). Idempotente: re-aplicar es no-op.
//   - Reversible por git (rama retirada-kg-2026-07-02); los 211 edges eran
//     derivables del código fuente, no conocimiento original.

use rusqlite::Connection;

use super::MemoryError;

/// `PRAGMA user_version` que marca la retirada del codegraph interno aplicada.
const USER_VERSION_V5: i64 = 5;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Retira las tablas del codegraph interno (`edges`, `unresolved_refs`) y sube
/// `user_version` a 5. Seguro en cada `open_conn`: DROP IF EXISTS + bump
/// monotónico hacen la llamada idempotente y gratuita cuando ya está aplicada.
pub(crate) fn apply_schema_v5_retire_codegraph(conn: &Connection) -> Result<(), MemoryError> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS edges;
         DROP TABLE IF EXISTS unresolved_refs;",
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("schema v5 retire codegraph: {e}")))?;

    let uv: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if uv < USER_VERSION_V5 {
        let _ = conn.execute_batch(&format!("PRAGMA user_version = {USER_VERSION_V5};"));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |_| Ok(()),
        )
        .is_ok()
    }

    /// DB en memoria simulando el estado v4: las dos tablas del codegraph
    /// existen (con una fila) y user_version=4 — el estado real de brain.db
    /// antes de esta retirada.
    fn v4_conn_with_edges() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE edges (id INTEGER PRIMARY KEY, source TEXT, target TEXT);
             CREATE TABLE unresolved_refs (id INTEGER PRIMARY KEY, symbol TEXT);
             INSERT INTO edges (source, target) VALUES ('a', 'b');
             CREATE TABLE memory_items (id TEXT PRIMARY KEY);
             INSERT INTO memory_items (id) VALUES ('keep-me');
             PRAGMA user_version = 4;",
        )
        .unwrap();
        conn
    }

    #[test]
    fn retire_drops_codegraph_tables_and_bumps_version() {
        let conn = v4_conn_with_edges();
        apply_schema_v5_retire_codegraph(&conn).expect("retirada debe aplicar");

        assert!(!table_exists(&conn, "edges"), "edges debe desaparecer");
        assert!(
            !table_exists(&conn, "unresolved_refs"),
            "unresolved_refs debe desaparecer"
        );
        let uv: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(uv, USER_VERSION_V5);
    }

    #[test]
    fn retire_preserves_other_tables() {
        // Caso negativo del contrato: la retirada NO puede tocar nada más.
        let conn = v4_conn_with_edges();
        apply_schema_v5_retire_codegraph(&conn).unwrap();

        let survivors: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(survivors, 1, "memory_items debe sobrevivir intacta");
    }

    #[test]
    fn retire_is_idempotent_on_clean_db() {
        // Fresh DB sin tablas codegraph (post-retirada o instalación nueva):
        // aplicar debe ser no-op sin error y el version bump único.
        let conn = Connection::open_in_memory().unwrap();
        apply_schema_v5_retire_codegraph(&conn).expect("primera aplicación");
        apply_schema_v5_retire_codegraph(&conn).expect("re-aplicación no-op");
        let uv: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(uv, USER_VERSION_V5);
    }

    #[test]
    fn retire_never_downgrades_user_version() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 9;").unwrap();
        apply_schema_v5_retire_codegraph(&conn).unwrap();
        let uv: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(uv, 9, "el version bump es monotónico, nunca baja");
    }
}
