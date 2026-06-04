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

use super::MemoryError;

/// `PRAGMA user_version` value that marks the v3 structural migration as applied.
/// Kept in sync with `model::SCHEMA_VERSION`. The bump is monotonic (only raised
/// when `< 3`) and does not interfere with the v2 derived-column backfill, which
/// gates on `>= 2`.
const USER_VERSION_V3: i64 = 3;

/// Apply the additive v3 tables/columns. Idempotent: safe to call on every
/// `open_conn`. Errors only on a genuinely broken DB (the `IF NOT EXISTS`
/// statements never fail on a healthy connection).
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
    if !column_present(conn, "memory_events", "trace_id") {
        let _ = conn.execute_batch("ALTER TABLE memory_events ADD COLUMN trace_id TEXT;");
    }
    let _ = conn
        .execute_batch("CREATE INDEX IF NOT EXISTS idx_memev_trace ON memory_events(trace_id);");

    // (e) Mark the structural migration as applied (monotonic). Does not run any
    // data backfill, so no row scan: pure PRAGMA bump when below v3.
    let uv: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if uv < USER_VERSION_V3 {
        let _ = conn.execute_batch(&format!("PRAGMA user_version = {USER_VERSION_V3};"));
    }
    Ok(())
}

/// Whether `table` already has a column named `col`. On any probe error returns
/// `true` so the caller never re-issues a failing `ALTER`. `table` is always a
/// constant code literal (never user input) -> no injection surface.
fn column_present(conn: &Connection, table: &str, col: &str) -> bool {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .ok()
        .map(|mut s| {
            s.query_map([], |r| r.get::<_, String>(1))
                .map(|it| it.flatten().any(|c| c == col))
                .unwrap_or(true)
        })
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bare connection with just the `memory_events` table, mirroring the
    /// shape `apply_schema` creates, so the guarded ADD COLUMN has a target.
    fn base_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE memory_events (
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

    #[test]
    fn creates_all_v3_tables_and_column() {
        let conn = base_conn();
        apply_schema_v3(&conn).unwrap();

        assert!(table_exists(&conn, "trace_events"));
        assert!(table_exists(&conn, "deprecation_entries"));
        assert!(table_exists(&conn, "deprecation_events"));
        assert!(column_present(&conn, "memory_events", "trace_id"));

        let uv: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(uv, USER_VERSION_V3);
    }

    #[test]
    fn is_idempotent_on_double_apply() {
        let conn = base_conn();
        apply_schema_v3(&conn).unwrap();
        // Second apply must not error (no duplicate table / duplicate column).
        apply_schema_v3(&conn).unwrap();

        // Exactly one trace_id column (no duplicate ALTER).
        let trace_cols: usize = {
            let mut stmt = conn.prepare("PRAGMA table_info(memory_events)").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .flatten()
                .filter(|c| c == "trace_id")
                .count()
        };
        assert_eq!(trace_cols, 1);
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
