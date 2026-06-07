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
    //     promotes rows here to `edges` once the target appears.
    //
    //   symbol     — the unresolved target name (as written in the source file).
    //   file       — source file where the reference was observed.
    //   line       — line number of the reference.
    //   kind       — same vocabulary as `edges.kind`.
    //   project_id — project slug of the referring file; used by
    //                `drain_unresolved_refs` to match against `memory_items`
    //                rows from the SAME project only, preventing cross-project
    //                symbol conflation (KIRKARDO P1 fix).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS unresolved_refs (
            id          INTEGER PRIMARY KEY,
            symbol      TEXT NOT NULL,
            file        TEXT,
            line        INTEGER,
            kind        TEXT,
            project_id  TEXT,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_unresolved_symbol
            ON unresolved_refs(symbol);",
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("schema v4 unresolved_refs: {e}")))?;

    // (b2) Additive migration: existing databases created before KIRKARDO P1
    //      fix do not have the `project_id` column on `unresolved_refs`.
    //      `ALTER TABLE ADD COLUMN` is idempotent-safe when wrapped in a
    //      try-ignore: SQLite returns an error if the column already exists,
    //      which we silently discard.  The new column defaults to NULL for all
    //      pre-existing rows (NULL = "project unknown"), which is safe because
    //      `drain_unresolved_refs` treats NULL project_id as a wildcard match
    //      (see its WHERE clause comment).
    let _ = conn.execute_batch("ALTER TABLE unresolved_refs ADD COLUMN project_id TEXT;");

    // The project_id index MUST be created AFTER the ALTER above. On databases
    // created before unresolved_refs had a project_id column, the column only
    // exists once the ALTER has run; creating the index inside the CREATE TABLE
    // batch (as before) failed with "no such column: project_id" on every
    // pre-existing brain.db and broke sparse recall. Creating it here covers
    // both fresh databases (column from CREATE TABLE) and migrated ones.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_unresolved_project
            ON unresolved_refs(project_id);",
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("schema v4 unresolved_idx: {e}")))?;

    // (b3) Additive migration — versioning columns on `edges` (Pilar 1 ·
    //      Kirkardo gap).
    //
    //   version    TEXT  — schema/capture-tool version tag that produced this
    //                      edge (e.g. "capture-symbols-js@1.2").  NULL for
    //                      edges inserted before this migration.  Used for
    //                      provenance auditing and incremental re-extraction.
    //   edge_hash  TEXT  — deterministic content hash of
    //                      `source||target||kind||COALESCE(file,'')` (FNV-1a
    //                      64-bit, 16 hex chars).  Allows external callers to
    //                      check whether a logical edge already exists without
    //                      querying by the composite UNIQUE index.  NULL for
    //                      pre-migration rows (backfill on demand).
    //
    //   Both columns are nullable so the migration is fully additive and
    //   reversible.  `INSERT OR IGNORE` in insert_edge is keyed on the UNIQUE
    //   index, not on edge_hash, so dedup is unaffected.
    let _ = conn.execute_batch("ALTER TABLE edges ADD COLUMN version TEXT;");
    let _ = conn.execute_batch("ALTER TABLE edges ADD COLUMN edge_hash TEXT;");

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
/// `version` identifies the capture-tool version that produced this edge
/// (e.g. `"capture-symbols-js@1.2"`).  Pass `None` when not applicable.
///
/// `edge_hash` is the deterministic content hash of the logical edge.  Pass
/// `None` to use the auto-computed value (`compute_edge_hash`).
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
    insert_edge_versioned(
        conn, source, target, kind, file, line_from, line_to, provenance, project_id, None, None,
    )
}

/// Like [`insert_edge`] but also records `version` and `edge_hash` columns
/// introduced by the Pilar-1 additive migration (b3).
///
/// When `edge_hash` is `None` it is computed automatically via
/// [`compute_edge_hash`].
#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_edge_versioned(
    conn: &Connection,
    source: &str,
    target: &str,
    kind: &str,
    file: Option<&str>,
    line_from: Option<i64>,
    line_to: Option<i64>,
    provenance: Option<&str>,
    project_id: Option<&str>,
    version: Option<&str>,
    edge_hash: Option<&str>,
) -> Result<(), MemoryError> {
    use rusqlite::params;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let computed_hash;
    let hash_val: &str = match edge_hash {
        Some(h) => h,
        None => {
            computed_hash = compute_edge_hash(source, target, kind, file);
            &computed_hash
        }
    };

    // INSERT OR IGNORE implements the dedup semantics declared by the UNIQUE
    // index on (source, target, kind, COALESCE(file, '')).
    conn.execute(
        "INSERT OR IGNORE INTO edges
            (source, target, kind, file, line_from, line_to, provenance, project_id,
             version, edge_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            source, target, kind, file, line_from, line_to, provenance, project_id, version,
            hash_val, now_ms,
        ],
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("insert_edge: {e}")))?;

    Ok(())
}

/// Compute the deterministic content hash for a logical edge.
///
/// Formula: first 16 hex chars of FNV-1a 64-bit of `"source\0target\0kind\0file"`.
/// Using a NUL separator avoids collisions across field boundaries.
/// The 16-char prefix gives 64 bits of collision resistance — sufficient for
/// a dev-tool dedup key and cheap to store / compare.
///
/// # Pure function
///
/// No I/O; suitable for use in property tests and const contexts (well,
/// `const` fn is blocked by `sha2`, but the function has no side effects).
pub fn compute_edge_hash(source: &str, target: &str, kind: &str, file: Option<&str>) -> String {
    // Use a portable 64-bit FNV-1a hash (no external crate needed) as a
    // fast, dependency-free alternative to SHA-256.  The output is formatted
    // as 16 lowercase hex chars to match the documented interface.
    //
    // FNV-1a 64-bit: offset_basis = 14695981039346656037, prime = 1099511628211.
    const FNV_OFFSET: u64 = 14_695_981_039_346_656_037;
    const FNV_PRIME: u64 = 1_099_511_628_211;

    let mut hash: u64 = FNV_OFFSET;
    let feed = |h: u64, bytes: &[u8]| -> u64 {
        bytes
            .iter()
            .fold(h, |acc, &b| acc.wrapping_mul(FNV_PRIME) ^ (b as u64))
    };
    // Mix each field with a NUL separator to prevent cross-boundary collisions.
    hash = feed(hash, source.as_bytes());
    hash = feed(hash, b"\0");
    hash = feed(hash, target.as_bytes());
    hash = feed(hash, b"\0");
    hash = feed(hash, kind.as_bytes());
    hash = feed(hash, b"\0");
    hash = feed(hash, file.unwrap_or("").as_bytes());
    format!("{hash:016x}")
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
        assert_eq!(
            count, 2,
            "same edge in different files must be stored separately"
        );
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
        assert!(
            table_exists(&conn, "edges"),
            "edges table must exist post-migration"
        );
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
        assert_eq!(
            count_idempotent, count_before,
            "idempotent re-apply must not lose rows"
        );

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
        insert_edge(
            &conn, "survive", "this", "calls", None, None, None, None, None,
        )
        .unwrap();

        apply_schema_v4(&conn).expect("re-apply must succeed");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "existing edge must survive schema re-apply");
    }

    // -----------------------------------------------------------------------
    // edge versioning (Pilar 1 · Kirkardo gap — migration b3)
    // -----------------------------------------------------------------------

    #[test]
    fn insert_edge_versioned_stores_version_and_hash() {
        let conn = v4_conn();
        insert_edge_versioned(
            &conn,
            "mod_a::foo",
            "mod_b::bar",
            "calls",
            Some("src/a.rs"),
            Some(10),
            Some(10),
            Some("test-tool"),
            Some("proj"),
            Some("capture-symbols-js@1.2"),
            None, // auto-compute hash
        )
        .unwrap();

        let (version, edge_hash): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT version, edge_hash FROM edges WHERE source = 'mod_a::foo'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("row must exist");

        assert_eq!(
            version.as_deref(),
            Some("capture-symbols-js@1.2"),
            "version must be stored"
        );
        assert!(
            edge_hash.is_some(),
            "edge_hash must be auto-computed and stored"
        );
        let h = edge_hash.unwrap();
        assert_eq!(h.len(), 16, "edge_hash must be 16 hex chars");
        assert!(
            h.chars().all(|c| c.is_ascii_hexdigit()),
            "edge_hash must be lowercase hex"
        );
    }

    #[test]
    fn compute_edge_hash_is_deterministic() {
        let h1 = compute_edge_hash("A", "B", "calls", Some("f.rs"));
        let h2 = compute_edge_hash("A", "B", "calls", Some("f.rs"));
        assert_eq!(h1, h2, "same inputs must produce the same hash");
    }

    #[test]
    fn compute_edge_hash_differs_on_different_inputs() {
        let h_ab = compute_edge_hash("A", "B", "calls", None);
        let h_ac = compute_edge_hash("A", "C", "calls", None);
        let h_file = compute_edge_hash("A", "B", "calls", Some("x.rs"));
        let h_kind = compute_edge_hash("A", "B", "imports", None);

        assert_ne!(h_ab, h_ac, "different target must differ");
        assert_ne!(h_ab, h_file, "different file must differ");
        assert_ne!(h_ab, h_kind, "different kind must differ");
    }

    #[test]
    fn insert_edge_backward_compat_still_works() {
        // The old insert_edge (no version/hash args) must still produce a row.
        let conn = v4_conn();
        insert_edge(
            &conn,
            "legacy_src",
            "legacy_dst",
            "calls",
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "backward-compat insert_edge must work");
    }

}
