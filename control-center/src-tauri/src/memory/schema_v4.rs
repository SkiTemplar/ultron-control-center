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
    let _ = conn.execute_batch(
        "ALTER TABLE unresolved_refs ADD COLUMN project_id TEXT;",
    );

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
    insert_edge_versioned(conn, source, target, kind, file, line_from, line_to, provenance, project_id, None, None)
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
            source,
            target,
            kind,
            file,
            line_from,
            line_to,
            provenance,
            project_id,
            version,
            hash_val,
            now_ms,
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
        bytes.iter().fold(h, |acc, &b| {
            acc.wrapping_mul(FNV_PRIME) ^ (b as u64)
        })
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
// compute_transitive_closure — CTE-based multi-hop reachability
// ---------------------------------------------------------------------------

/// A node in the transitive closure result.
///
/// Each row represents one symbol reachable from `start` via directed edges,
/// together with the shortest hop count and the path taken.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ClosureNode {
    /// The reachable symbol.
    pub symbol: String,
    /// Shortest number of hops from `start` to `symbol`.
    pub depth: usize,
    /// Dot-separated path: `"start.intermediate.symbol"`.  Useful for
    /// rendering call chains in the UI.
    pub path: String,
}

/// Compute the transitive closure of `start` in the `edges` call-graph up to
/// `max_hops` directed hops.
///
/// Uses a SQLite **recursive CTE** with explicit cycle detection: a visited
/// set (stored as the accumulated path string) prevents any symbol from being
/// visited twice, so even graphs with cycles converge.
///
/// # Parameters
///
/// * `conn`      — open connection with v4 schema applied.
/// * `start`     — the root symbol (must match `edges.source` exactly).
/// * `direction` — `Callees` = forward (what does `start` call?);
///                 `Callers` = backward (who calls `start`?).
/// * `max_hops`  — maximum traversal depth (≥ 1).  Pass `usize::MAX` for
///                 unbounded (the cycle guard still terminates traversal).
///
/// # Returns
///
/// `Vec<ClosureNode>` sorted by (depth ASC, symbol ASC).  The start node
/// itself is **not** included in the result.
///
/// # Errors
///
/// Returns `MemoryError::RemoteUnavailable` on DB errors.
pub fn compute_transitive_closure(
    conn: &Connection,
    start: &str,
    direction: EdgeDirection,
    max_hops: usize,
) -> Result<Vec<ClosureNode>, MemoryError> {
    use rusqlite::params;

    // The recursive CTE carries:
    //   symbol  — current node
    //   depth   — hops from start
    //   path    — pipe-delimited visited set used for cycle detection
    //
    // Cycle guard: `path NOT LIKE '%|' || next || '|%'` rejects any node
    // already present in the path string.  The leading/trailing `|` delimiters
    // ensure substring matches don't fire across node-name boundaries
    // (e.g. "foo" and "foobar" won't collide because the pattern is `|foo|`).
    //
    // The `?3` parameter is `max_hops`; the CTE stops recursing when
    // `depth >= max_hops`.

    let (join_col, next_col) = match direction {
        EdgeDirection::Callees => ("source", "target"),
        EdgeDirection::Callers => ("target", "source"),
    };

    let sql = format!(
        "WITH RECURSIVE closure(symbol, depth, path) AS (
            -- Seed: direct neighbours of start.
            SELECT e.{next_col}, 1, '|' || ?1 || '|' || e.{next_col} || '|'
            FROM edges e
            WHERE e.{join_col} = ?1
              AND e.{next_col} <> ?1

            UNION ALL

            -- Recurse: one more hop, skipping already-visited nodes.
            SELECT e.{next_col},
                   c.depth + 1,
                   c.path || e.{next_col} || '|'
            FROM edges e
            JOIN closure c ON e.{join_col} = c.symbol
            WHERE c.depth < ?2
              AND e.{next_col} <> ?1
              AND c.path NOT LIKE '%|' || e.{next_col} || '|%'
        )
        SELECT symbol, MIN(depth) AS min_depth, path
        FROM closure
        GROUP BY symbol
        ORDER BY min_depth ASC, symbol ASC"
    );

    let max_hops_i64 = if max_hops >= i64::MAX as usize {
        i64::MAX
    } else {
        max_hops as i64
    };

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("transitive_closure prepare: {e}")))?;

    let rows = stmt
        .query_map(params![start, max_hops_i64], |row| {
            let symbol: String = row.get(0)?;
            let depth: i64     = row.get(1)?;
            let path: String   = row.get(2)?;
            // Convert the internal pipe-delimited path to a dot-separated
            // human-readable form: strip outer `|` delimiters, replace inner
            // `|` with `.`.
            let readable_path = path
                .trim_matches('|')
                .replace('|', ".");
            Ok(ClosureNode {
                symbol,
                depth: depth as usize,
                path: readable_path,
            })
        })
        .map_err(|e| MemoryError::RemoteUnavailable(format!("transitive_closure query: {e}")))?;

    Ok(rows.flatten().collect())
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
    //
    // KIRKARDO P1 fix: the JOIN is scoped to the same project_id so that two
    // different projects that happen to define a symbol with the same name are
    // never conflated.  When ur.project_id IS NULL (rows inserted before the
    // P1 migration), we fall back to the legacy title-only match so that old
    // data is still drained rather than stranded forever.
    //
    // Note: `stmt` must outlive the `MappedRows` iterator, so we collect
    // into a Vec before letting `stmt` drop at the end of the scope.
    let mut stmt = conn
        .prepare(
            "SELECT ur.id, ur.symbol, ur.file, ur.line, ur.kind, ur.project_id
             FROM unresolved_refs ur
             INNER JOIN memory_items mi
                ON mi.title = ur.symbol
               AND (ur.project_id IS NULL OR mi.project_id = ur.project_id)",
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
                project_id: row.get(5)?,
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
        // project_id is propagated from the unresolved_ref so the edge is
        // properly scoped to the originating project (KIRKARDO P1 fix).
        tx.execute(
            "INSERT OR IGNORE INTO edges
                (source, target, kind, file, line_from, line_to, provenance, project_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'drain-unresolved', ?6, ?7)",
            params![ur.symbol, ur.symbol, kind, ur.file, ur.line, ur.project_id, now_ms],
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
    /// Project slug from which this reference was captured.  `None` for rows
    /// inserted before the KIRKARDO P1 migration (treated as wildcard by the
    /// drain JOIN).
    project_id: Option<String>,
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
    ///
    /// Includes `project_id` to match the KIRKARDO P1 drain JOIN which
    /// references `mi.project_id`.  Rows inserted via `insert_memory_item`
    /// leave `project_id` as NULL (legacy / unknown project), which causes the
    /// drain to match them via the `ur.project_id IS NULL` fallback arm.
    fn ensure_memory_items_table(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS memory_items (
                id         TEXT PRIMARY KEY,
                title      TEXT,
                project_id TEXT
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
        insert_unresolved_with_project(conn, symbol, kind, None);
    }

    fn insert_unresolved_with_project(
        conn: &Connection,
        symbol: &str,
        kind: &str,
        project_id: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO unresolved_refs (symbol, file, line, kind, project_id, created_at) \
             VALUES (?1, NULL, NULL, ?2, ?3, 0)",
            rusqlite::params![symbol, kind, project_id],
        )
        .expect("insert unresolved_ref");
    }

    /// Minimal `memory_items` row with a `project_id` column.  The stub
    /// used by drain tests only has `id` and `title`; this variant adds
    /// `project_id` so that the P1 cross-project scoping logic can be tested.
    fn ensure_memory_items_table_with_project(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS memory_items (
                id         TEXT PRIMARY KEY,
                title      TEXT,
                project_id TEXT
            );",
        )
        .expect("create memory_items stub with project_id");
    }

    fn insert_memory_item_with_project(conn: &Connection, id: &str, title: &str, project: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO memory_items (id, title, project_id) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, title, project],
        )
        .expect("insert memory_item with project");
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

    // -----------------------------------------------------------------------
    // KIRKARDO P1 — cross-project symbol isolation
    //
    // Two distinct projects (proj-alpha, proj-beta) each define a symbol
    // named "shared_fn".  An unresolved_ref scoped to proj-alpha must only
    // be promoted when memory_items contains "shared_fn" WITH project_id =
    // "proj-alpha".  The proj-beta entry must NOT trigger promotion of the
    // proj-alpha ref, and vice versa.
    // -----------------------------------------------------------------------

    #[test]
    fn drain_does_not_conflate_same_symbol_across_projects() {
        let conn = v4_conn();
        ensure_memory_items_table_with_project(&conn);

        // Both projects define a symbol with the identical name.
        insert_memory_item_with_project(&conn, "alpha-id", "shared_fn", "proj-alpha");
        insert_memory_item_with_project(&conn, "beta-id", "shared_fn", "proj-beta");

        // Only proj-alpha has an unresolved_ref for "shared_fn".
        insert_unresolved_with_project(&conn, "shared_fn", "calls", Some("proj-alpha"));

        let stats = drain_unresolved_refs(&conn).expect("drain must succeed");

        // Exactly one row promoted — the proj-alpha ref.
        assert_eq!(
            stats.promoted, 1,
            "only the proj-alpha unresolved_ref should be promoted"
        );
        assert_eq!(stats.remaining, 0, "no rows should remain");

        // The promoted edge must carry project_id = "proj-alpha", NOT "proj-beta".
        let edge_project: String = conn
            .query_row(
                "SELECT project_id FROM edges WHERE provenance = 'drain-unresolved'",
                [],
                |r| r.get(0),
            )
            .expect("promoted edge must exist");
        assert_eq!(
            edge_project, "proj-alpha",
            "promoted edge must be scoped to proj-alpha, not proj-beta"
        );
    }

    #[test]
    fn drain_scoped_ref_not_promoted_by_wrong_project_memory_item() {
        let conn = v4_conn();
        ensure_memory_items_table_with_project(&conn);

        // Only proj-beta's memory_items contains "exclusive_fn".
        insert_memory_item_with_project(&conn, "beta-id", "exclusive_fn", "proj-beta");

        // But the unresolved_ref belongs to proj-alpha.
        insert_unresolved_with_project(&conn, "exclusive_fn", "imports", Some("proj-alpha"));

        let stats = drain_unresolved_refs(&conn).expect("drain must succeed");

        // The ref must NOT be promoted — the symbol exists only in another project.
        assert_eq!(
            stats.promoted, 0,
            "cross-project symbol must NOT trigger promotion"
        );
        assert_eq!(
            stats.remaining, 1,
            "proj-alpha ref must remain unresolved because proj-beta's entry does not count"
        );
    }

    #[test]
    fn drain_legacy_null_project_id_still_promotes() {
        // Rows inserted before the P1 migration have project_id = NULL.
        // The drain must still promote them (NULL is treated as wildcard) so
        // that pre-migration data is not stranded forever.
        let conn = v4_conn();
        // Use the simple stub (no project_id column) for the legacy path.
        ensure_memory_items_table(&conn);
        insert_memory_item(&conn, "id-1", "legacy_sym");

        // Insert with NULL project_id (legacy row, no project scope).
        insert_unresolved(&conn, "legacy_sym", "calls"); // project_id = None

        let stats = drain_unresolved_refs(&conn).expect("drain must succeed");
        assert_eq!(
            stats.promoted, 1,
            "legacy NULL-project_id rows must still be promoted"
        );
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
        insert_edge(&conn, "legacy_src", "legacy_dst", "calls", None, None, None, None, None)
            .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "backward-compat insert_edge must work");
    }

    // -----------------------------------------------------------------------
    // compute_transitive_closure — multi-hop + cycle detection
    // -----------------------------------------------------------------------

    // Helper: insert a directed calls edge (no file, no project).
    fn edge(conn: &Connection, src: &str, dst: &str) {
        insert_edge(conn, src, dst, "calls", None, None, None, None, None).unwrap();
    }

    #[test]
    fn transitive_closure_direct_callees() {
        // A -> B, A -> C  (depth 1 only)
        let conn = v4_conn();
        edge(&conn, "A", "B");
        edge(&conn, "A", "C");

        let nodes = compute_transitive_closure(&conn, "A", EdgeDirection::Callees, 1).unwrap();
        let symbols: Vec<&str> = nodes.iter().map(|n| n.symbol.as_str()).collect();
        assert!(symbols.contains(&"B"), "B must be reachable from A");
        assert!(symbols.contains(&"C"), "C must be reachable from A");
        assert_eq!(nodes.len(), 2, "exactly two direct callees");
        assert!(nodes.iter().all(|n| n.depth == 1));
    }

    #[test]
    fn transitive_closure_multi_hop() {
        // A -> B -> C -> D  (chain of 3 hops)
        let conn = v4_conn();
        edge(&conn, "A", "B");
        edge(&conn, "B", "C");
        edge(&conn, "C", "D");

        let nodes = compute_transitive_closure(&conn, "A", EdgeDirection::Callees, 10).unwrap();
        let by_sym: std::collections::HashMap<&str, usize> =
            nodes.iter().map(|n| (n.symbol.as_str(), n.depth)).collect();

        assert_eq!(by_sym.get("B"), Some(&1), "B at depth 1");
        assert_eq!(by_sym.get("C"), Some(&2), "C at depth 2");
        assert_eq!(by_sym.get("D"), Some(&3), "D at depth 3");
        assert_eq!(nodes.len(), 3);
    }

    #[test]
    fn transitive_closure_respects_max_hops() {
        // A -> B -> C -> D  — only ask for 2 hops
        let conn = v4_conn();
        edge(&conn, "A", "B");
        edge(&conn, "B", "C");
        edge(&conn, "C", "D");

        let nodes = compute_transitive_closure(&conn, "A", EdgeDirection::Callees, 2).unwrap();
        let symbols: Vec<&str> = nodes.iter().map(|n| n.symbol.as_str()).collect();
        assert!(symbols.contains(&"B"));
        assert!(symbols.contains(&"C"));
        assert!(!symbols.contains(&"D"), "D is 3 hops away — must not appear with max_hops=2");
    }

    #[test]
    fn transitive_closure_detects_cycle() {
        // A -> B -> C -> A  (cycle)
        // Must terminate and not return A as a reachable node (it's the start).
        let conn = v4_conn();
        edge(&conn, "A", "B");
        edge(&conn, "B", "C");
        edge(&conn, "C", "A"); // cycle back to start

        let nodes = compute_transitive_closure(&conn, "A", EdgeDirection::Callees, 100).unwrap();
        let symbols: Vec<&str> = nodes.iter().map(|n| n.symbol.as_str()).collect();

        // Must have B and C; A is excluded (it's the start node, excluded by
        // `e.{next_col} <> ?1` in the CTE seed and recursive step).
        assert!(symbols.contains(&"B"), "B must be reachable");
        assert!(symbols.contains(&"C"), "C must be reachable");
        assert!(!symbols.contains(&"A"), "start node A must NOT appear (cycle guard)");

        // Crucially: the function must not loop forever or return duplicates.
        let unique: std::collections::HashSet<&str> = symbols.iter().copied().collect();
        assert_eq!(unique.len(), nodes.len(), "no duplicates — cycle guard must fire");
    }

    #[test]
    fn transitive_closure_diamond_deduplicates() {
        // A -> B -> D
        // A -> C -> D
        // D is reachable via two paths; must appear exactly once at depth 2.
        let conn = v4_conn();
        edge(&conn, "A", "B");
        edge(&conn, "A", "C");
        edge(&conn, "B", "D");
        edge(&conn, "C", "D");

        let nodes = compute_transitive_closure(&conn, "A", EdgeDirection::Callees, 10).unwrap();
        let d_nodes: Vec<&ClosureNode> = nodes.iter().filter(|n| n.symbol == "D").collect();
        assert_eq!(d_nodes.len(), 1, "D must appear exactly once despite two paths");
        assert_eq!(d_nodes[0].depth, 2, "D is at depth 2 via either path");
    }

    #[test]
    fn transitive_closure_callers_direction() {
        // A -> C, B -> C  — asking for CALLERS of C must return A and B.
        let conn = v4_conn();
        edge(&conn, "A", "C");
        edge(&conn, "B", "C");
        edge(&conn, "C", "D"); // outgoing from C — must NOT appear

        let nodes = compute_transitive_closure(&conn, "C", EdgeDirection::Callers, 10).unwrap();
        let symbols: Vec<&str> = nodes.iter().map(|n| n.symbol.as_str()).collect();
        assert!(symbols.contains(&"A"), "A calls C — must appear as caller");
        assert!(symbols.contains(&"B"), "B calls C — must appear as caller");
        assert!(!symbols.contains(&"D"), "D is a callee of C — must NOT appear in Callers");
    }

    #[test]
    fn transitive_closure_empty_when_no_edges() {
        let conn = v4_conn();
        let nodes =
            compute_transitive_closure(&conn, "lonely", EdgeDirection::Callees, 10).unwrap();
        assert!(nodes.is_empty(), "no edges => empty closure");
    }

    #[test]
    fn transitive_closure_path_field_is_readable() {
        // A -> B -> C: path for C should be "A.B.C"
        let conn = v4_conn();
        edge(&conn, "A", "B");
        edge(&conn, "B", "C");

        let nodes = compute_transitive_closure(&conn, "A", EdgeDirection::Callees, 10).unwrap();
        let c_node = nodes.iter().find(|n| n.symbol == "C").expect("C must be present");
        assert!(
            c_node.path.contains('A') && c_node.path.contains('B') && c_node.path.contains('C'),
            "path must contain all hops: got '{}'",
            c_node.path
        );
    }
}
