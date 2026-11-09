// ULTRON Control Center — Schema v3 (MEMORY KERNEL · OLA M/K)
//
// Additive, idempotent migration `schema_version 2 -> 3`. Two SoT-aligned specs
// land their tables here in ONE coordinated migration so the bump is not split:
//   - Control Plane (SPEC-CONTROL-PLANE §4): `trace_events` + `memory_events.trace_id`
//   - Maintenance   (SPEC-MAINTENANCE-CLI §2): `deprecation_entries` + `deprecation_events`
//
// Nothing destructive: every statement is `CREATE TABLE/INDEX IF NOT EXISTS` or a
// guarded `ALTER TABLE ADD COLUMN`. Historical rows keep `trace_id = NULL`. The
// `memory_*` tables are never altered in shape beyond the one nullable column.
//
// Reverting = `DROP TABLE trace_events, deprecation_entries, deprecation_events`
// and leaving `memory_events.trace_id` inert (nullable column; reads unaffected).

use rusqlite::Connection;

use super::sqlite_store::in_immediate_tx;
use super::sqlite_store::schema::{
    add_column_if_missing_on, exec, raise_user_version, user_version,
};
use super::MemoryError;

/// `PRAGMA user_version` value that marks the v3 structural migration as applied.
/// (Independiente de `model::SCHEMA_VERSION`, que versiona la forma de cada
/// fila.) The bump is monotonic (only raised when `< 3`) and does not interfere
/// with the v2 derived-column backfill, which gates on `>= 2`.
const USER_VERSION_V3: i64 = 3;

/// `PRAGMA user_version` tras el backfill de `valid_from` (la última migración).
pub(crate) const USER_VERSION_TEMPORAL: i64 = 6;

/// Apply the additive v3 tables/columns. Idempotent: safe to call on every
/// `open_conn`, and on an up-to-date DB it writes nothing. Any error (DDL,
/// column probe, `ALTER`, version bump) is returned, never swallowed.
pub(crate) fn apply_schema_v3(conn: &Connection) -> Result<(), MemoryError> {
    // (a) Control Plane: per-turn trace spans (SPEC-CONTROL-PLANE §4.1).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS trace_events (
            span_id     TEXT PRIMARY KEY,
            trace_id    TEXT NOT NULL,
            parent_span TEXT,
            stage       TEXT NOT NULL,
            component   TEXT NOT NULL,
            status      TEXT NOT NULL,
            error_kind  TEXT,
            detail_json TEXT,
            started_at  TEXT NOT NULL,
            duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_trev_trace ON trace_events(trace_id);
        CREATE INDEX IF NOT EXISTS idx_trev_stage ON trace_events(stage);",
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("schema v3 trace_events: {e}")))?;

    // (b) Maintenance: live deprecation registry (SPEC-MAINTENANCE-CLI §2.1).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS deprecation_entries (
            id              TEXT PRIMARY KEY,
            artifact        TEXT NOT NULL,
            domain          TEXT NOT NULL,
            kind            TEXT NOT NULL,
            owner           TEXT,
            path            TEXT NOT NULL,
            reason          TEXT NOT NULL,
            replacement     TEXT,
            state           TEXT NOT NULL,
            risk            TEXT NOT NULL,
            regenerable     INTEGER NOT NULL DEFAULT 0,
            size_bytes      INTEGER,
            cleanup_action  TEXT NOT NULL,
            rollback_action TEXT NOT NULL,
            first_seen      TEXT NOT NULL,
            last_seen       TEXT NOT NULL,
            deadline        TEXT,
            retention_class TEXT,
            evidence_json   TEXT,
            confirmed_by    TEXT,
            schema_version  INTEGER NOT NULL DEFAULT 3
        );
        CREATE INDEX IF NOT EXISTS idx_dep_state  ON deprecation_entries(state);
        CREATE INDEX IF NOT EXISTS idx_dep_domain ON deprecation_entries(domain);
        CREATE INDEX IF NOT EXISTS idx_dep_risk   ON deprecation_entries(risk);",
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("schema v3 deprecation_entries: {e}")))?;

    // (c) Maintenance: append-only audit of every deprecation transition (§2.2).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS deprecation_events (
            event_id     TEXT PRIMARY KEY,
            entry_id     TEXT NOT NULL,
            kind         TEXT NOT NULL,
            from_state   TEXT,
            to_state     TEXT,
            trace_id     TEXT,
            actor        TEXT NOT NULL,
            snapshot_ref TEXT,
            detail_json  TEXT,
            created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_depev_entry ON deprecation_events(entry_id);
        CREATE INDEX IF NOT EXISTS idx_depev_trace ON deprecation_events(trace_id);",
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("schema v3 deprecation_events: {e}")))?;

    // (d) Control Plane: link each memory_event to the turn that produced it.
    // Guarded ADD COLUMN (SQLite has no ADD COLUMN IF NOT EXISTS). The index is
    // created AFTER the column exists, so a pre-v3 DB does not abort here.
    add_column_if_missing_on(conn, "memory_events", "trace_id", "TEXT")?;
    exec(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_memev_trace ON memory_events(trace_id);",
        "schema v3 idx_memev_trace",
    )?;

    // (f) Temporal resolver (additive, reversible): bitemporal-lite validity on
    // memory_items. `valid_from` = when the assertion began (defaults to
    // created_at); `valid_to` = when it stopped being true (NULL = still vigente).
    // Reverting = ignore both columns (recall falls back to "no end" semantics).
    // El backfill de `valid_from` NO va aquí: es la migración versionada
    // `apply_temporal_backfill_v6`, que corre una sola vez.
    add_column_if_missing_on(conn, "memory_items", "valid_from", "INTEGER")?;
    add_column_if_missing_on(conn, "memory_items", "valid_to", "INTEGER")?;
    // Index to keep the recall vigencia filter cheap (valid_to NULL or future).
    exec(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_items_valid_to ON memory_items(valid_to);",
        "schema v3 idx_items_valid_to",
    )?;

    // (e) Mark the structural migration as applied (monotonic). Pure PRAGMA
    // bump when below v3; on an up-to-date DB it only reads.
    raise_user_version(conn, USER_VERSION_V3)
}

/// Backfill de `valid_from` (user_version 5 → 6, 2026-10-26).
///
/// Hasta esta versión el `UPDATE ... WHERE valid_from IS NULL` corría en CADA
/// `open_conn`, incluidas las aperturas de solo lectura: tomaba el cerrojo de
/// escritura de la base en WAL y, si chocaba con otro escritor, el error se
/// tragaba. Ahora corre una vez, en una transacción `BEGIN IMMEDIATE` que
/// también sube la versión: si el UPDATE falla, la versión no sube y el error
/// llega al llamante. Las filas nuevas ya traen `valid_from` desde
/// `MemoryItem::new`.
pub(crate) fn apply_temporal_backfill_v6(conn: &Connection) -> Result<(), MemoryError> {
    if user_version(conn)? >= USER_VERSION_TEMPORAL {
        return Ok(());
    }
    in_immediate_tx(conn, || {
        exec(
            conn,
            "UPDATE memory_items SET valid_from = created_at WHERE valid_from IS NULL;",
            "schema v6 backfill valid_from",
        )?;
        raise_user_version(conn, USER_VERSION_TEMPORAL)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::sqlite_store::schema::column_present;

    /// Minimal `memory_items` + `memory_events` shapes (the tables
    /// `apply_schema` creates before v3), so every guarded ADD COLUMN has a
    /// real target. Sin `memory_items`, el `ALTER` falla y desde 2026-10-26 ese
    /// error ya no se traga.
    fn base_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE memory_items (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE memory_events (
                id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                memory_id TEXT,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |_| Ok(()),
        )
        .is_ok()
    }

    fn count_columns(conn: &Connection, table: &str, col: &str) -> usize {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .filter(|c| c == col)
            .count()
    }

    #[test]
    fn creates_all_v3_tables_and_column() {
        let conn = base_conn();
        apply_schema_v3(&conn).unwrap();

        assert!(table_exists(&conn, "trace_events"));
        assert!(table_exists(&conn, "deprecation_entries"));
        assert!(table_exists(&conn, "deprecation_events"));
        assert!(column_present(&conn, "memory_events", "trace_id").unwrap());
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION_V3);
    }

    #[test]
    fn is_idempotent_on_double_apply() {
        let conn = base_conn();
        apply_schema_v3(&conn).unwrap();
        // Second apply must not error (no duplicate table / duplicate column).
        apply_schema_v3(&conn).unwrap();
        assert_eq!(count_columns(&conn, "memory_events", "trace_id"), 1);
        assert_eq!(count_columns(&conn, "memory_items", "valid_to"), 1);
    }

    #[test]
    fn adds_valid_from_valid_to_and_backfills_valid_from_once() {
        let conn = base_conn();
        conn.execute(
            "INSERT INTO memory_items (id, created_at) VALUES ('m1', 12345)",
            [],
        )
        .unwrap();
        apply_schema_v3(&conn).unwrap();
        assert!(column_present(&conn, "memory_items", "valid_from").unwrap());
        assert!(column_present(&conn, "memory_items", "valid_to").unwrap());

        apply_temporal_backfill_v6(&conn).unwrap();
        let (vf, vt): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT valid_from, valid_to FROM memory_items WHERE id='m1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(vf, Some(12345), "valid_from backfilled from created_at");
        assert!(vt.is_none(), "valid_to NULL means still vigente");
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION_TEMPORAL);

        // Caso negativo: ya en v6, una fila sin valid_from no se toca.
        conn.execute(
            "INSERT INTO memory_items (id, created_at) VALUES ('m2', 999)",
            [],
        )
        .unwrap();
        apply_temporal_backfill_v6(&conn).unwrap();
        let vf2: Option<i64> = conn
            .query_row(
                "SELECT valid_from FROM memory_items WHERE id='m2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(vf2.is_none(), "el backfill corrió fuera de su migración");
    }

    #[test]
    fn a_missing_target_table_is_an_error_not_a_silent_skip() {
        // Antes el ALTER fallido se tragaba y user_version subía igual.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE memory_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);",
        )
        .unwrap();
        assert!(apply_schema_v3(&conn).is_err());
        assert_eq!(user_version(&conn).unwrap(), 0);
    }

    #[test]
    fn historical_rows_keep_null_trace_id() {
        let conn = base_conn();
        conn.execute(
            "INSERT INTO memory_events (id, event_type, created_at) VALUES ('e1', 'created', 1)",
            [],
        )
        .unwrap();
        apply_schema_v3(&conn).unwrap();
        let trace: Option<String> = conn
            .query_row(
                "SELECT trace_id FROM memory_events WHERE id='e1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(trace.is_none());
    }
}
