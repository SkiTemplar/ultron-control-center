// ULTRON Control Center — Schema v4 (CODEGRAPH · Fase 3a)
//
// Additive, idempotent migration `user_version 3 -> 4`.  Introduces a
// lightweight code-graph layer on top of the existing symbol-capture
// infrastructure:
//
//   edges            — directed relationships between code symbols/modules
//                      (callers, callees, imports, re-exports, …).
//   unresolved_refs  — import/call targets whose source symbol is not yet
//                      in brain.db; drained and promoted to `edges` once the
//                      target appears.
//
// SAFETY CONTRACT (same as v3):
//   - All statements are `CREATE TABLE/INDEX IF NOT EXISTS`.  No existing
//     table is altered or dropped.
//   - `user_version` is only bumped forward (monotonic, never decremented).
//   - Reverting = `DROP TABLE edges; DROP TABLE unresolved_refs;` and
//     ignoring the version bump (no row damage).

use rusqlite::Connection;

use super::MemoryError;

/// `PRAGMA user_version` value that marks the v4 codegraph migration as
/// applied.  Must always be > 3 (which was set by `schema_v3`).
const USER_VERSION_V4: i64 = 4;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Apply the additive v4 tables + indexes.  Safe to call on every
/// `open_conn`; all statements are idempotent.
///
/// Only bumps `user_version` from 3 → 4 once.  If the DB is already at
/// version ≥ 4, the DDL still runs (IF NOT EXISTS guards make it free) but
/// the PRAGMA bump is skipped — no double-write.
pub(crate) fn apply_schema_v4(conn: &Connection) -> Result<(), MemoryError> {
    // (a) Directed code-graph edges.
    //
    // Dedup key: (source, target, kind, file).  `INSERT OR IGNORE` in
    // `insert_edge` relies on the UNIQUE index below.
    //
    // Columns:
    //   source      — fully-qualified symbol or module path (emitter).
    //   target      — fully-qualified symbol or module path (callee / import).
    //   kind        — relationship category: 'imports' | 'calls' | 're-exports'
    //                 | 'inherits' | 'implements'.
    //   file        — source file (relative to project root) where the edge
    //                 was observed; NULL for synthetic / cross-file edges.
    //   line_from   — line in `file` where `source` is defined/used.
    //   line_to     — line in `file` where the reference to `target` appears
    //                 (may equal line_from for same-line calls).
    //   provenance  — which tool/hook produced this edge
    //                 (e.g. 'capture-symbols-js', 'manual').
    //   project_id  — project slug for per-project scoping of impact queries.
    //   created_at  — Unix epoch (ms) of first observation.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS edges (
            id          INTEGER PRIMARY KEY,
            source      TEXT NOT NULL,
            target      TEXT NOT NULL,
            kind        TEXT NOT NULL,
            file        TEXT,
            line_from   INTEGER,
            line_to     INTEGER,
            provenance  TEXT,
            project_id  TEXT,
            created_at  INTEGER NOT NULL
        );
        -- Dedup: same directed edge in the same file is never duplicated.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_dedup
            ON edges(source, target, kind, COALESCE(file, ''));
        -- Fast callers/callees lookup (impact analysis direction).
        CREATE INDEX IF NOT EXISTS idx_edges_source  ON edges(source);
        CREATE INDEX IF NOT EXISTS idx_edges_target  ON edges(target);
        -- Filter by relationship kind (e.g. 'imports' only).
        CREATE INDEX IF NOT EXISTS idx_edges_kind    ON edges(kind);
        -- Per-project scoping.
        CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project_id);",
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("schema v4 edges: {e}")))?;

    // (b) Unresolved references — forward declarations whose target symbol
    //     has not yet been captured in `memory_items`.  A separate drain pass
    //     (future work) promotes rows here to `edges` once the target appears.
    //
    //   symbol  — the unresolved target name (as written in the source file).
    //   file    — source file where the reference was observed.
    //   line    — line number of the reference.
    //   kind    — same vocabulary as `edges.kind`.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS unresolved_refs (
            id          INTEGER PRIMARY KEY,
            symbol      TEXT NOT NULL,
            file        TEXT,
            line        INTEGER,
            kind        TEXT,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_unresolved_symbol
            ON unresolved_refs(symbol);",
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("schema v4 unresolved_refs: {e}")))?;

    // (c) Monotonic version bump — only when we are actually upgrading.
    let uv: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if uv < USER_VERSION_V4 {
        let _ = conn.execute_batch(&format!("PRAGMA user_version = {USER_VERSION_V4};"));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// insert_edge — deduplicated upsert
// ---------------------------------------------------------------------------

/// Insert a code-graph edge, silently ignoring exact duplicates.
///
/// Dedup key: `(source, target, kind, COALESCE(file, ''))` — same directed
/// edge in the same file is written once.  When the same relationship is
/// observed in a *different* file (e.g. re-export chain), a new row is
/// inserted because the `file` differs.
///
/// `line_from` / `line_to` are **not** part of the dedup key: a symbol that
/// moves between lines should not create a duplicate edge — the existing row
/// is left as-is (use `update_edge_lines` if tracking line drift matters).
///
/// # Errors
///
/// Returns `MemoryError::RemoteUnavailable` on DB errors other than
/// `SQLITE_CONSTRAINT_UNIQUE` (which is silently ignored).
#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_edge(
    conn: &Connection,
    source: &str,
    target: &str,
    kind: &str,
    file: Option<&str>,
    line_from: Option<i64>,
    line_to: Option<i64>,
    provenance: Option<&str>,
    project_id: Option<&str>,
) -> Result<(), MemoryError> {
    use rusqlite::params;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // INSERT OR IGNORE implements the dedup semantics declared by the UNIQUE
    // index on (source, target, kind, COALESCE(file, '')).
    conn.execute(
        "INSERT OR IGNORE INTO edges
            (source, target, kind, file, line_from, line_to, provenance, project_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            source,
            target,
            kind,
            file,
            line_from,
            line_to,
            provenance,
            project_id,
            now_ms,
        ],
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("insert_edge: {e}")))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// query_edges — impact analysis
// ---------------------------------------------------------------------------

/// Direction for edge traversal in `query_edges`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeDirection {
    /// Return edges where `symbol` is the **source** (i.e. what `symbol`
    /// calls or imports — outgoing / callee direction).
    Callees,
    /// Return edges where `symbol` is the **target** (i.e. who calls or
    /// imports `symbol` — incoming / caller direction).
    Callers,
}

/// A single code-graph edge row, returned by `query_edges`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CodeEdge {
    pub id: i64,
    pub source: String,
    pub target: String,
    pub kind: String,
    pub file: Option<String>,
    pub line_from: Option<i64>,
    pub line_to: Option<i64>,
    pub provenance: Option<String>,
    pub project_id: Option<String>,
    pub created_at: i64,
}

/// Return edges involving `symbol`, filtered by direction.
///
/// * `Callees` — what does `symbol` call/import? (fan-out, dependency graph)
/// * `Callers` — who calls/imports `symbol`? (fan-in, impact analysis)
///
/// Results are ordered by `created_at DESC` so the most-recently observed
/// relationships surface first.  Capped at `limit` rows (default 100).
///
/// # Errors
///
/// Returns `MemoryError::RemoteUnavailable` on DB errors.
pub(crate) fn query_edges(
    conn: &Connection,
    symbol: &str,
    direction: EdgeDirection,
    limit: usize,
) -> Result<Vec<CodeEdge>, MemoryError> {
    use rusqlite::params;

    let sql = match direction {
        EdgeDirection::Callees => {
            "SELECT id, source, target, kind, file, line_from, line_to,
                    provenance, project_id, created_at
             FROM edges WHERE source = ?1
             ORDER BY created_at DESC LIMIT ?2"
        }
        EdgeDirection::Callers => {
            "SELECT id, source, target, kind, file, line_from, line_to,
                    provenance, project_id, created_at
             FROM edges WHERE target = ?1
             ORDER BY created_at DESC LIMIT ?2"
        }
    };

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("query_edges prepare: {e}")))?;

    let rows = stmt
        .query_map(params![symbol, limit as i64], |row| {
            Ok(CodeEdge {
                id: row.get(0)?,
                source: row.get(1)?,
                target: row.get(2)?,
                kind: row.get(3)?,
                file: row.get(4)?,
                line_from: row.get(5)?,
                line_to: row.get(6)?,
                provenance: row.get(7)?,
                project_id: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(|e| MemoryError::RemoteUnavailable(format!("query_edges query: {e}")))?;

    Ok(rows.flatten().collect())
}

// ---------------------------------------------------------------------------
// graph_metrics — aggregate diagnostic counters
// ---------------------------------------------------------------------------

/// Aggregate counters for the code-graph layer.
///
/// Intended for diagnostic UIs and the `edge metrics` CLI subcommand.
///
/// # Errors
///
/// Returns `MemoryError::RemoteUnavailable` on DB errors.
pub(crate) fn graph_metrics(conn: &Connection) -> Result<GraphMetricsRow, MemoryError> {
    let total_edges: i64 = conn
        .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
        .map_err(|e| MemoryError::RemoteUnavailable(format!("graph_metrics total_edges: {e}")))?;

    let unresolved_refs: i64 = conn
        .query_row("SELECT COUNT(*) FROM unresolved_refs", [], |r| r.get(0))
        .map_err(|e| {
            MemoryError::RemoteUnavailable(format!("graph_metrics unresolved_refs: {e}"))
        })?;

    let mut stmt = conn
        .prepare("SELECT kind, COUNT(*) FROM edges GROUP BY kind ORDER BY COUNT(*) DESC")
        .map_err(|e| {
            MemoryError::RemoteUnavailable(format!("graph_metrics edges_by_kind prepare: {e}"))
        })?;

    let edges_by_kind: Vec<(String, i64)> = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| {
            MemoryError::RemoteUnavailable(format!("graph_metrics edges_by_kind query: {e}"))
        })?
        .flatten()
        .collect();

    Ok(GraphMetricsRow {
        total_edges,
        edges_by_kind,
        unresolved_refs,
    })
}

/// Raw metric counters returned by `graph_metrics`.
///
/// Converted to the richer `GraphMetrics` DTO in
/// `commands/memory/codegraph.rs` before being serialised to the frontend.
#[derive(Debug, Clone)]
pub(crate) struct GraphMetricsRow {
    /// Total rows in the `edges` table.
    pub total_edges: i64,
    /// Per-kind counts: `[(kind_label, count)]`, descending by count.
    pub edges_by_kind: Vec<(String, i64)>,
    /// Total rows in `unresolved_refs`.
    pub unresolved_refs: i64,
}

// ---------------------------------------------------------------------------
// drain_unresolved_refs — promote resolved references to edges
// ---------------------------------------------------------------------------

/// Promote `unresolved_refs` rows whose `symbol` now exists in
/// `memory_items` to first-class `edges` rows.
///
/// The drain uses a LEFT JOIN to find `unresolved_refs` whose `symbol`
/// matches any `memory_items.title` (the canonical identity field).
/// Promoted rows use `provenance = "drain-unresolved"` and the `source`
/// field is set to the unresolved ref's `symbol` (the caller/importer),
/// targeting itself — i.e. a self-referential edge — since we don't have
/// a separate caller symbol in `unresolved_refs`.  This is the minimal safe
/// promotion: it records that the symbol was referenced and is now known.
///
/// Rows that cannot be promoted (target still absent from `memory_items`)
/// are left in place.
///
/// # Return value
///
/// `(promoted, remaining)` — number of rows promoted and number still
/// unresolved after the drain.
///
/// # Errors
///
/// Returns `MemoryError::RemoteUnavailable` on DB errors.
pub(crate) fn drain_unresolved_refs(conn: &Connection) -> Result<DrainStats, MemoryError> {
    use rusqlite::params;

    // Collect unresolved_refs whose symbol is now in memory_items.title.
    // Note: `stmt` must outlive the `MappedRows` iterator, so we collect
    // into a Vec before letting `stmt` drop at the end of the scope.
    let mut stmt = conn
        .prepare(
            "SELECT ur.id, ur.symbol, ur.file, ur.line, ur.kind
             FROM unresolved_refs ur
             INNER JOIN memory_items mi ON mi.title = ur.symbol",
        )
        .map_err(|e| {
            MemoryError::RemoteUnavailable(format!("drain_unresolved_refs prepare: {e}"))
        })?;

    let promotable: Vec<UnresolvedRef> = stmt
        .query_map([], |row| {
            Ok(UnresolvedRef {
                id: row.get(0)?,
                symbol: row.get(1)?,
                file: row.get(2)?,
                line: row.get(3)?,
                kind: row.get(4)?,
            })
        })
        .map_err(|e| {
            MemoryError::RemoteUnavailable(format!("drain_unresolved_refs query: {e}"))
        })?
        .flatten()
        .collect();

    let promoted_count = promotable.len();
    if promoted_count == 0 {
        // Nothing to drain — count remaining and return early.
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM unresolved_refs", [], |r| r.get(0))
            .unwrap_or(0);
        return Ok(DrainStats {
            promoted: 0,
            remaining: remaining as usize,
        });
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Promote each row within a single transaction for atomicity.
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| MemoryError::RemoteUnavailable(format!("drain_unresolved_refs tx: {e}")))?;

    for ur in &promotable {
        let kind = ur.kind.as_deref().unwrap_or("imports");
        // Insert the edge (source == target == symbol, records that the
        // symbol was seen referenced and is now resolvable).
        tx.execute(
            "INSERT OR IGNORE INTO edges
                (source, target, kind, file, line_from, line_to, provenance, project_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'drain-unresolved', NULL, ?6)",
            params![ur.symbol, ur.symbol, kind, ur.file, ur.line, now_ms],
        )
        .map_err(|e| {
            MemoryError::RemoteUnavailable(format!("drain_unresolved_refs insert: {e}"))
        })?;

        // Remove the promoted ref.
        tx.execute(
            "DELETE FROM unresolved_refs WHERE id = ?1",
            params![ur.id],
        )
        .map_err(|e| {
            MemoryError::RemoteUnavailable(format!("drain_unresolved_refs delete: {e}"))
        })?;
    }

    tx.commit()
        .map_err(|e| MemoryError::RemoteUnavailable(format!("drain_unresolved_refs commit: {e}")))?;

    let remaining: i64 = conn
        .query_row("SELECT COUNT(*) FROM unresolved_refs", [], |r| r.get(0))
        .unwrap_or(0);

    Ok(DrainStats {
        promoted: promoted_count,
        remaining: remaining as usize,
    })
}

/// Statistics returned by [`drain_unresolved_refs`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DrainStats {
    /// Rows promoted from `unresolved_refs` to `edges`.
    pub promoted: usize,
    /// Rows still in `unresolved_refs` after the drain.
    pub remaining: usize,
}

// ---------------------------------------------------------------------------
// Internal helper types
// ---------------------------------------------------------------------------

/// A row from `unresolved_refs`, used internally by [`drain_unresolved_refs`].
struct UnresolvedRef {
    id: i64,
    symbol: String,
    file: Option<String>,
    line: Option<i64>,
    kind: Option<String>,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Minimal in-memory DB with only the v4 tables applied (no full
    /// apply_schema dependency — keeps tests hermetic and fast).
    fn v4_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        apply_schema_v4(&conn).expect("v4 schema");
        conn
    }

    // -----------------------------------------------------------------------
    // Schema structure
    // -----------------------------------------------------------------------

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |_| Ok(()),
        )
        .is_ok()
    }

    #[test]
    fn creates_edges_and_unresolved_refs_tables() {
        let conn = v4_conn();
        assert!(table_exists(&conn, "edges"), "edges table must exist");
        assert!(
            table_exists(&conn, "unresolved_refs"),
            "unresolved_refs table must exist"
        );
    }

    #[test]
    fn user_version_bumped_to_4() {
        let conn = v4_conn();
        let uv: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(uv, USER_VERSION_V4);
    }

    #[test]
    fn apply_is_idempotent() {
        let conn = v4_conn();
        // Second call must not fail (all IF NOT EXISTS).
        apply_schema_v4(&conn).expect("second apply must succeed");
        // Version must still be exactly 4 (no double-bump).
        let uv: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(uv, USER_VERSION_V4);
    }

    // -----------------------------------------------------------------------
    // insert_edge + dedup
    // -----------------------------------------------------------------------

    #[test]
    fn insert_edge_persists_row() {
        let conn = v4_conn();
        insert_edge(
            &conn,
            "mymod::foo",
            "std::vec::Vec",
            "imports",
            Some("src/lib.rs"),
            Some(10),
            Some(10),
            Some("capture-symbols-js"),
            Some("ultron"),
        )
        .unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn insert_edge_deduplicates_same_source_target_kind_file() {
        let conn = v4_conn();
        // Insert the same edge twice — must produce exactly one row.
        for _ in 0..2 {
            insert_edge(
                &conn,
                "parser::parse",
                "lexer::tokenize",
                "calls",
                Some("src/parser.rs"),
                Some(42),
                Some(42),
                Some("test"),
                None,
            )
            .unwrap();
        }

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "duplicate edge must be silently ignored");
    }

    #[test]
    fn insert_edge_same_edge_different_file_creates_two_rows() {
        let conn = v4_conn();
        insert_edge(
            &conn,
            "A",
            "B",
            "calls",
            Some("src/a.rs"),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        insert_edge(
            &conn,
            "A",
            "B",
            "calls",
            Some("src/b.rs"), // different file
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "same edge in different files must be stored separately");
    }

    #[test]
    fn insert_edge_null_file_deduplicates_correctly() {
        let conn = v4_conn();
        // Two inserts with file=None should dedup via COALESCE(file,'').
        for _ in 0..2 {
            insert_edge(&conn, "X", "Y", "imports", None, None, None, None, None).unwrap();
        }
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "null-file edges must also dedup");
    }

    // -----------------------------------------------------------------------
    // query_edges — direction
    // -----------------------------------------------------------------------

    #[test]
    fn query_edges_callees_returns_outgoing() {
        let conn = v4_conn();
        insert_edge(&conn, "foo", "bar", "calls", None, None, None, None, None).unwrap();
        insert_edge(&conn, "foo", "baz", "imports", None, None, None, None, None).unwrap();
        // Edge in the opposite direction — must NOT appear in Callees query for "foo".
        insert_edge(&conn, "qux", "foo", "calls", None, None, None, None, None).unwrap();

        let edges = query_edges(&conn, "foo", EdgeDirection::Callees, 100).unwrap();
        assert_eq!(edges.len(), 2, "two outgoing edges from 'foo'");
        assert!(edges.iter().all(|e| e.source == "foo"));
    }

    #[test]
    fn query_edges_callers_returns_incoming() {
        let conn = v4_conn();
        insert_edge(&conn, "a", "target_fn", "calls", None, None, None, None, None).unwrap();
        insert_edge(&conn, "b", "target_fn", "calls", None, None, None, None, None).unwrap();
        // Outgoing from target_fn — must NOT appear in Callers query.
        insert_edge(&conn, "target_fn", "c", "calls", None, None, None, None, None).unwrap();

        let edges = query_edges(&conn, "target_fn", EdgeDirection::Callers, 100).unwrap();
        assert_eq!(edges.len(), 2, "two callers of 'target_fn'");
        assert!(edges.iter().all(|e| e.target == "target_fn"));
    }

    #[test]
    fn query_edges_empty_when_no_matching_symbol() {
        let conn = v4_conn();
        insert_edge(&conn, "a", "b", "calls", None, None, None, None, None).unwrap();

        let callers = query_edges(&conn, "nonexistent", EdgeDirection::Callers, 100).unwrap();
        assert!(callers.is_empty());

        let callees = query_edges(&conn, "nonexistent", EdgeDirection::Callees, 100).unwrap();
        assert!(callees.is_empty());
    }

    #[test]
    fn query_edges_respects_limit() {
        let conn = v4_conn();
        for i in 0..10 {
            insert_edge(
                &conn,
                "hub",
                &format!("dep_{i}"),
                "imports",
                Some(&format!("src/f{i}.rs")), // different file per edge -> no dedup
                None,
                None,
                None,
                None,
            )
            .unwrap();
        }
        let edges = query_edges(&conn, "hub", EdgeDirection::Callees, 3).unwrap();
        assert_eq!(edges.len(), 3, "limit must be respected");
    }

    // -----------------------------------------------------------------------
    // Migration proof on the pre-codegraph brain.db backup
    // -----------------------------------------------------------------------

    /// Open the quarantine backup of `brain.db` (created before this migration
    /// was applied), run `apply_schema_v4`, and assert:
    ///   1. `edges` and `unresolved_refs` tables now exist.
    ///   2. `user_version` == 4.
    ///   3. `memory_items` row count is unchanged (== 1425 or whatever it was).
    ///   4. `PRAGMA integrity_check` returns "ok".
    ///   5. The original tables (`memory_items`, `memory_events`, `memory_candidates`,
    ///      `kg_entities`, `kg_relations`) still exist.
    ///
    /// This test is `#[ignore]` because it requires the backup file on disk.
    /// Run explicitly with: `cargo test --lib migrate_real_brain_db -- --include-ignored`
    #[test]
    #[ignore]
    fn migrate_real_brain_db_copy() {
        let backup = std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
            .join(".ultron")
            .join("_cleanup_quarantine_2026-06-06")
            .join("brain.db.pre-codegraph");

        assert!(
            backup.exists(),
            "backup not found at {}: run the session backup step first",
            backup.display()
        );

        // Work on a fresh copy so re-runs are idempotent.
        let test_copy = backup.with_extension("test-migration");
        std::fs::copy(&backup, &test_copy).expect("copy backup");

        let conn = Connection::open(&test_copy).expect("open test copy");
        conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();

        // 1. user_version before migration must be < 4.
        let uv_before: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert!(uv_before < 4, "expected user_version < 4, got {uv_before}");

        // 2. Count memory_items before migration.
        let count_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0))
            .unwrap();

        // 3. Apply the v4 migration.
        apply_schema_v4(&conn).expect("v4 migration must succeed");

        // 4. Tables created.
        assert!(table_exists(&conn, "edges"), "edges table must exist post-migration");
        assert!(
            table_exists(&conn, "unresolved_refs"),
            "unresolved_refs table must exist post-migration"
        );

        // 5. user_version == 4.
        let uv_after: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(uv_after, 4, "user_version must be 4 after migration");

        // 6. memory_items row count unchanged (additive migration must not lose rows).
        let count_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count_after, count_before,
            "memory_items count must not change: was {count_before}, now {count_after}"
        );

        // 7. Existing tables all still present.
        for tbl in &[
            "memory_items",
            "memory_events",
            "memory_candidates",
            "kg_entities",
            "kg_relations",
        ] {
            assert!(
                table_exists(&conn, tbl),
                "existing table '{tbl}' must survive migration"
            );
        }

        // 8. integrity_check == "ok".
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .expect("integrity_check failed");
        assert_eq!(integrity, "ok", "PRAGMA integrity_check must return 'ok'");

        // 9. Idempotency: second apply must not error and must not change count.
        apply_schema_v4(&conn).expect("second apply must be idempotent");
        let count_idempotent: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_idempotent, count_before, "idempotent re-apply must not lose rows");

        // Clean up test copy.
        let _ = std::fs::remove_file(&test_copy);
    }

    // -----------------------------------------------------------------------
    // Existing tables not touched
    // -----------------------------------------------------------------------

    /// Verify that applying v4 on a DB that already has edges/unresolved_refs
    /// does not delete existing rows (i.e., truly additive).
    #[test]
    fn existing_rows_survive_re_apply() {
        let conn = v4_conn();
        insert_edge(&conn, "survive", "this", "calls", None, None, None, None, None).unwrap();

        apply_schema_v4(&conn).expect("re-apply must succeed");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "existing edge must survive schema re-apply");
    }

    // -----------------------------------------------------------------------
    // graph_metrics
    // -----------------------------------------------------------------------

    #[test]
    fn graph_metrics_empty_db() {
        let conn = v4_conn();
        let m = graph_metrics(&conn).expect("graph_metrics must succeed on empty db");
        assert_eq!(m.total_edges, 0);
        assert_eq!(m.unresolved_refs, 0);
        assert!(m.edges_by_kind.is_empty());
    }

    #[test]
    fn graph_metrics_counts_edges_and_kinds() {
        let conn = v4_conn();
        // 2 calls edges in different files (so no dedup).
        insert_edge(&conn, "a", "b", "calls", Some("f1.rs"), None, None, None, None).unwrap();
        insert_edge(&conn, "c", "d", "calls", Some("f2.rs"), None, None, None, None).unwrap();
        // 1 imports edge.
        insert_edge(&conn, "e", "f", "imports", None, None, None, None, None).unwrap();

        // 1 unresolved_ref.
        conn.execute(
            "INSERT INTO unresolved_refs (symbol, file, line, kind, created_at) VALUES ('unknown', NULL, NULL, 'calls', 0)",
            [],
        )
        .unwrap();

        let m = graph_metrics(&conn).expect("graph_metrics must succeed");
        assert_eq!(m.total_edges, 3);
        assert_eq!(m.unresolved_refs, 1);

        // edges_by_kind should have "calls"=2 first (descending), then "imports"=1.
        assert_eq!(m.edges_by_kind.len(), 2);
        assert_eq!(m.edges_by_kind[0].0, "calls");
        assert_eq!(m.edges_by_kind[0].1, 2);
        assert_eq!(m.edges_by_kind[1].0, "imports");
        assert_eq!(m.edges_by_kind[1].1, 1);
    }

    // -----------------------------------------------------------------------
    // drain_unresolved_refs
    // -----------------------------------------------------------------------

    /// Create a minimal `memory_items` table (subset of real schema) so that
    /// the drain's INNER JOIN can find matching titles.
    fn ensure_memory_items_table(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS memory_items (
                id TEXT PRIMARY KEY,
                title TEXT
            );",
        )
        .expect("create memory_items stub");
    }

    fn insert_memory_item(conn: &Connection, id: &str, title: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO memory_items (id, title) VALUES (?1, ?2)",
            rusqlite::params![id, title],
        )
        .expect("insert memory_item stub");
    }

    fn insert_unresolved(conn: &Connection, symbol: &str, kind: &str) {
        conn.execute(
            "INSERT INTO unresolved_refs (symbol, file, line, kind, created_at) VALUES (?1, NULL, NULL, ?2, 0)",
            rusqlite::params![symbol, kind],
        )
        .expect("insert unresolved_ref");
    }

    #[test]
    fn drain_noop_when_no_unresolved() {
        let conn = v4_conn();
        ensure_memory_items_table(&conn);
        let stats = drain_unresolved_refs(&conn).expect("drain must succeed");
        assert_eq!(stats.promoted, 0);
        assert_eq!(stats.remaining, 0);
    }

    #[test]
    fn drain_noop_when_target_not_in_memory_items() {
        let conn = v4_conn();
        ensure_memory_items_table(&conn);
        insert_unresolved(&conn, "still_unknown", "calls");

        let stats = drain_unresolved_refs(&conn).expect("drain must succeed");
        assert_eq!(stats.promoted, 0, "nothing promotable — target absent");
        assert_eq!(stats.remaining, 1, "row must remain in unresolved_refs");
    }

    #[test]
    fn drain_promotes_when_target_appears_in_memory_items() {
        let conn = v4_conn();
        ensure_memory_items_table(&conn);
        insert_memory_item(&conn, "id-1", "my_func");
        insert_unresolved(&conn, "my_func", "calls");

        let stats = drain_unresolved_refs(&conn).expect("drain must succeed");
        assert_eq!(stats.promoted, 1, "one row must be promoted");
        assert_eq!(stats.remaining, 0, "no rows left in unresolved_refs");

        // The promoted row must now be in edges.
        let edge_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges WHERE provenance='drain-unresolved'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(edge_count, 1, "promoted edge must exist in edges table");

        // unresolved_refs must be empty.
        let unresolved_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM unresolved_refs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(unresolved_count, 0, "unresolved_refs must be empty after drain");
    }

    #[test]
    fn drain_is_idempotent() {
        let conn = v4_conn();
        ensure_memory_items_table(&conn);
        insert_memory_item(&conn, "id-1", "known_symbol");
        insert_unresolved(&conn, "known_symbol", "imports");

        // First drain.
        let s1 = drain_unresolved_refs(&conn).expect("first drain");
        assert_eq!(s1.promoted, 1);
        assert_eq!(s1.remaining, 0);

        // Second drain — nothing left to drain.
        let s2 = drain_unresolved_refs(&conn).expect("second drain");
        assert_eq!(s2.promoted, 0, "second drain must be a no-op");
        assert_eq!(s2.remaining, 0);

        // Edges table must still have exactly 1 row (no double-insert).
        let edge_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(edge_count, 1, "idempotent drain must not duplicate edges");
    }

    #[test]
    fn drain_partial_when_only_some_targets_known() {
        let conn = v4_conn();
        ensure_memory_items_table(&conn);
        insert_memory_item(&conn, "id-1", "known");
        insert_unresolved(&conn, "known", "calls");
        insert_unresolved(&conn, "still_unknown", "imports");

        let stats = drain_unresolved_refs(&conn).expect("drain must succeed");
        assert_eq!(stats.promoted, 1, "one symbol promoted");
        assert_eq!(stats.remaining, 1, "one symbol still unresolved");
    }
}
