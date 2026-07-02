// sqlite_store/schema.rs — Connection setup, schema creation, and migrations.

use std::path::PathBuf;
use std::sync::OnceLock;

use rusqlite::Connection;

use crate::memory::MemoryError;

pub(super) static FTS5_AVAILABLE: OnceLock<bool> = OnceLock::new();

pub(super) fn brain_db_path() -> Result<PathBuf, MemoryError> {
    dirs::home_dir()
        .map(|h| h.join(".ultron").join("brain.db"))
        .ok_or_else(|| {
            MemoryError::IoError(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no HOME dir",
            ))
        })
}

pub(super) fn fts5_available(conn: &Connection) -> bool {
    *FTS5_AVAILABLE.get_or_init(|| {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x);
             DROP TABLE IF EXISTS _fts5_probe;",
        )
        .is_ok()
    })
}

/// Open `brain.db` (creating parent dirs) and ensure the schema exists.
pub fn open_conn() -> Result<Connection, MemoryError> {
    let path = brain_db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(MemoryError::IoError)?;
    }
    let conn = Connection::open(&path)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("brain.db open: {e}")))?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| MemoryError::RemoteUnavailable(format!("WAL pragma: {e}")))?;
    apply_schema(&conn)?;
    Ok(conn)
}

/// Create all tables + FTS triggers. Idempotent (`IF NOT EXISTS`).
pub fn apply_schema(conn: &Connection) -> Result<(), MemoryError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_items (
            id              TEXT PRIMARY KEY,
            type            TEXT NOT NULL,
            scope           TEXT NOT NULL,
            project_id      TEXT, repo_id TEXT, branch TEXT,
            workflow_id     TEXT, agent_id TEXT, skill_id TEXT,
            title           TEXT, summary TEXT, content TEXT, content_json TEXT,
            tags            TEXT,
            status          TEXT NOT NULL DEFAULT 'pending',
            confidence      REAL NOT NULL DEFAULT 0.5,
            importance      REAL NOT NULL DEFAULT 0.5,
            stability       TEXT NOT NULL DEFAULT 'durable',
            sensitivity     TEXT NOT NULL DEFAULT 'internal',
            source          TEXT NOT NULL,
            source_session_id TEXT,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL,
            expires_at      INTEGER,
            supersedes      TEXT, superseded_by TEXT, contradicts TEXT, derived_from TEXT,
            valid_from      INTEGER,
            valid_to        INTEGER,
            qdrant_point_id TEXT,
            content_hash    TEXT,
            normalized_text TEXT,
            schema_version  INTEGER NOT NULL DEFAULT 1,
            token_estimate  INTEGER NOT NULL DEFAULT 0,
            access_count    INTEGER NOT NULL DEFAULT 0,
            last_accessed_at INTEGER, last_injected_at INTEGER,
            validated_by_user INTEGER NOT NULL DEFAULT 0,
            validated_at    INTEGER,
            pinned          INTEGER NOT NULL DEFAULT 0,
            symbol          TEXT, file_path TEXT, line INTEGER,
            signature       TEXT, capture_source TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_items_status_scope
            ON memory_items(status, scope, project_id);
        CREATE INDEX IF NOT EXISTS idx_items_updated ON memory_items(updated_at);

        CREATE TABLE IF NOT EXISTS memory_events (
            id              TEXT PRIMARY KEY,
            event_type      TEXT NOT NULL,
            memory_id       TEXT,
            before_json     TEXT, after_json TEXT,
            actor           TEXT NOT NULL,
            source_session_id TEXT, source_turn_id TEXT,
            reason          TEXT, confidence REAL,
            created_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_memory ON memory_events(memory_id, created_at);

        CREATE TABLE IF NOT EXISTS memory_candidates (
            id              TEXT PRIMARY KEY,
            proposed_type   TEXT NOT NULL,
            proposed_scope  TEXT NOT NULL,
            proposed_title  TEXT, proposed_summary TEXT, proposed_content TEXT,
            proposed_content_json TEXT, proposed_tags TEXT,
            source_event_ids TEXT, source_session_id TEXT,
            confidence      REAL NOT NULL DEFAULT 0.5,
            importance      REAL NOT NULL DEFAULT 0.5,
            risk_level      TEXT NOT NULL DEFAULT 'low',
            duplicate_candidates TEXT, contradiction_candidates TEXT,
            recommended_action TEXT NOT NULL DEFAULT 'approve',
            status          TEXT NOT NULL DEFAULT 'pending',
            created_at      INTEGER NOT NULL,
            proposed_symbol TEXT, proposed_file_path TEXT, proposed_line INTEGER,
            proposed_signature TEXT, capture_source TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_candidates_status ON memory_candidates(status, created_at);

        CREATE TABLE IF NOT EXISTS kg_entities (
            name        TEXT PRIMARY KEY,
            entity_type TEXT,
            observations TEXT
        );
        CREATE TABLE IF NOT EXISTS kg_relations (
            from_name     TEXT, to_name TEXT, relation_type TEXT,
            UNIQUE(from_name, to_name, relation_type)
        );",
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("schema core: {e}")))?;

    // Idempotent ADD COLUMN migration for brain.db created before `pinned`
    // existed (Pinning, req #17). SQLite supports ALTER TABLE ADD COLUMN.
    let has_pinned = conn
        .prepare("PRAGMA table_info(memory_items)")
        .ok()
        .map(|mut s| {
            s.query_map([], |r| r.get::<_, String>(1))
                .map(|it| it.flatten().any(|c| c == "pinned"))
                .unwrap_or(true)
        })
        .unwrap_or(true);
    if !has_pinned {
        let _ = conn.execute_batch(
            "ALTER TABLE memory_items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
        );
    }

    // OLA B (2026-06-04): additive content_hash / normalized_text / schema_version
    // columns + one-shot backfill of pre-existing rows. Same idempotent pattern as
    // `pinned` above; backfill is gated by PRAGMA user_version so it runs once, not
    // on every open. ADDITIVE + reversible (snapshot taken in backups/).
    add_column_if_missing(conn, "content_hash", "TEXT");
    add_column_if_missing(conn, "normalized_text", "TEXT");
    add_column_if_missing(conn, "schema_version", "INTEGER NOT NULL DEFAULT 1");
    // Index AFTER the ADD COLUMN: on a pre-existing DB that lacked content_hash,
    // creating this index inside the CREATE TABLE batch above would fail with
    // "no such column" and abort apply_schema. (Fresh DBs already have it.)
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_items_content_hash ON memory_items(content_hash);",
    );
    backfill_derived_columns(conn);

    // Code-location capture (2026-06-05): additive symbol/file_path/line/signature/
    // capture_source columns on BOTH tables. Same idempotent ADD-COLUMN pattern as
    // OLA B above; all nullable, so existing rows read back as NULL (no backfill).
    add_column_if_missing(conn, "symbol", "TEXT");
    add_column_if_missing(conn, "file_path", "TEXT");
    add_column_if_missing(conn, "line", "INTEGER");
    add_column_if_missing(conn, "signature", "TEXT");
    add_column_if_missing(conn, "capture_source", "TEXT");
    add_column_if_missing_on(conn, "memory_candidates", "proposed_symbol", "TEXT");
    add_column_if_missing_on(conn, "memory_candidates", "proposed_file_path", "TEXT");
    add_column_if_missing_on(conn, "memory_candidates", "proposed_line", "INTEGER");
    add_column_if_missing_on(conn, "memory_candidates", "proposed_signature", "TEXT");
    add_column_if_missing_on(conn, "memory_candidates", "capture_source", "TEXT");
    // O(1) symbol lookup for re-capture dedupe (one row per "file_path:symbol").
    let _ =
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_items_symbol ON memory_items(symbol);");

    if fts5_available(conn) {
        conn.execute_batch(
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
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("schema fts5: {e}")))?;
    }

    // OLA M/K (2026-06-04): additive v3 tables (trace_events + deprecation
    // registry) + memory_events.trace_id. Idempotent; coordinated single bump.
    super::super::schema_v3::apply_schema_v3(conn)?;

    // RETIRADA codegraph interno (2026-07-02, mand.12): drop de `edges` +
    // `unresolved_refs` (v4, 2026-06-06 — nunca justificado: 0 lectores, productor
    // descableado; el codegraph real es el indexador externo `.codegraph/`).
    // Pure DDL, idempotente. user_version 4→5.
    super::super::schema_v4::apply_schema_v5_retire_codegraph(conn)?;

    // CLEANUP (2026-06-05): drop the legacy `memories` and `memories_fts`
    // tables that were created by a pre-kernel schema.  They have 0 rows and
    // are schema dead-weight that confuses audits.
    //
    // ORDER IS CRITICAL (fix HIGH #2, 2026-06-05):
    //   1. Drop the FTS5 virtual table FIRST.  SQLite automatically destroys
    //      its shadow tables (_data, _idx, _docsize, _config, _content) when
    //      the virtual table is dropped.  Dropping the shadows manually BEFORE
    //      the virtual table makes `DROP TABLE memories_fts` fail with
    //      "vtable constructor failed: memories_fts", which aborts the whole
    //      execute_batch and leaves `memories` behind.
    //   2. Drop `memories` AFTER `memories_fts`.
    //
    // `DROP TABLE IF EXISTS` is idempotent — safe on every open_conn.
    // The canonical tables (memory_items / memory_items_fts) are not touched.
    if let Err(e) = conn.execute_batch(
        "DROP TABLE IF EXISTS memories_fts;
         DROP TABLE IF EXISTS memories;",
    ) {
        eprintln!("[sqlite_store] legacy-table cleanup failed (non-fatal): {e}");
    }

    Ok(())
}

/// Idempotent `ALTER TABLE memory_items ADD COLUMN` (the common case).
/// SQLite lacks `ADD COLUMN IF NOT EXISTS`, so probe `table_info` first. `decl`
/// is always a constant code literal (never user input) -> no injection surface.
pub(super) fn add_column_if_missing(conn: &Connection, col: &str, decl: &str) {
    add_column_if_missing_on(conn, "memory_items", col, decl);
}

/// Table-parameterised variant of [`add_column_if_missing`]. `table`, `col` and
/// `decl` are ALWAYS constant code literals (never user input) -> no injection
/// surface; the `table_info` probe uses the same trusted literal.
pub(super) fn add_column_if_missing_on(conn: &Connection, table: &str, col: &str, decl: &str) {
    let present = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .ok()
        .map(|mut s| {
            s.query_map([], |r| r.get::<_, String>(1))
                .map(|it| it.flatten().any(|c| c == col))
                .unwrap_or(true) // on error assume present -> never re-ALTER
        })
        .unwrap_or(true);
    if !present {
        let _ = conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl};"));
    }
}

/// One-shot backfill of `content_hash` + `normalized_text` for rows written
/// before those columns existed (the legacy active items). Gated by
/// `PRAGMA user_version`: computes once, then bumps the version so later opens
/// skip it with a single cheap PRAGMA read. Re-entrant-safe (only NULL rows).
/// The joined text mirrors `MemoryItem::searchable_text()` so a backfilled hash
/// equals the hash `insert_item` would later write for the same row.
pub(super) fn backfill_derived_columns(conn: &Connection) {
    const USER_VERSION_DERIVED: i64 = 2;
    let uv: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if uv >= USER_VERSION_DERIVED {
        return;
    }
    let rows: Vec<(String, String)> = match conn
        .prepare("SELECT id, title, summary, content FROM memory_items WHERE content_hash IS NULL")
    {
        Ok(mut stmt) => stmt
            .query_map([], |r| {
                let title: Option<String> = r.get(1)?;
                let summary: Option<String> = r.get(2)?;
                let content: Option<String> = r.get(3)?;
                let joined = [title, summary, content]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok((r.get::<_, String>(0)?, joined))
            })
            .map(|it| it.flatten().collect())
            .unwrap_or_default(),
        Err(_) => return,
    };
    let _ = conn.execute_batch("BEGIN");
    for (id, raw) in &rows {
        let normalized = super::super::texthash::normalize_text(raw);
        let chash = super::super::texthash::content_hash(&normalized);
        let _ = conn.execute(
            "UPDATE memory_items SET normalized_text = ?1, content_hash = ?2, \
             schema_version = ?3 WHERE id = ?4 AND content_hash IS NULL",
            rusqlite::params![normalized, chash, super::super::model::SCHEMA_VERSION, id],
        );
    }
    let _ = conn.execute_batch("COMMIT");
    let _ = conn.execute_batch(&format!("PRAGMA user_version = {USER_VERSION_DERIVED};"));
}
