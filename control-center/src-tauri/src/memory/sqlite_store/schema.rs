// sqlite_store/schema.rs — Connection setup, schema creation, and migrations.

use std::path::PathBuf;
use std::sync::OnceLock;

use rusqlite::Connection;

use crate::memory::MemoryError;

use super::schema_columns::add_column_if_missing;
pub(crate) use super::schema_columns::add_column_if_missing_on;
#[cfg(test)]
pub(crate) use super::schema_columns::column_present;
use super::schema_fts::create_fts;

pub(super) static FTS5_AVAILABLE: OnceLock<bool> = OnceLock::new();

/// Espera máxima de un escritor ante la base bloqueada por otro proceso. Las
/// escrituras de memoria son cortas (ms); 5 s cubre un lote de captura entero
/// sin que un hook (timeout 20 s) note la espera.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Variable que redirige `brain.db` a otra ruta (2026-10-23). La usa el
/// harness Kirkardo para medir el TTL del recall (check 21.3) contra una base
/// temporal, por el sidecar real y sin escribir en la de producción. Vacía o
/// ausente = sin efecto. Con ella definida, los one-shot no preguntan al daemon
/// (`daemon_client`), que sirve la base de producción.
pub const BRAIN_DB_ENV: &str = "ULTRON_BRAIN_DB";

/// Ruta de override a partir del valor crudo de [`BRAIN_DB_ENV`]. Pura.
#[must_use]
pub fn brain_db_override(raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    raw.filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// ¿Este proceso trabaja contra una `brain.db` distinta de la de producción?
#[must_use]
pub fn brain_db_overridden() -> bool {
    brain_db_override(std::env::var_os(BRAIN_DB_ENV)).is_some()
}

pub(super) fn brain_db_path() -> Result<PathBuf, MemoryError> {
    if let Some(path) = brain_db_override(std::env::var_os(BRAIN_DB_ENV)) {
        return Ok(path);
    }
    dirs::home_dir()
        .map(|h| h.join(".ultron").join("brain.db"))
        .ok_or_else(|| {
            MemoryError::IoError(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no HOME dir",
            ))
        })
}

/// ¿Tiene este SQLite el módulo FTS5? La sonda crea y borra una tabla en el
/// esquema `temp` de la conexión: no toca `brain.db`, así que no pide el
/// cerrojo de escritura y un escritor concurrente no puede hacerla fallar (un
/// `SQLITE_BUSY` aquí se quedaba cacheado como «sin FTS5» para todo el proceso).
pub(super) fn fts5_available(conn: &Connection) -> bool {
    *FTS5_AVAILABLE.get_or_init(|| {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS temp._fts5_probe USING fts5(x);
             DROP TABLE IF EXISTS temp._fts5_probe;",
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
    // Sin busy_timeout, un segundo escritor recibía "database is locked" al
    // instante (2026-09-03: drains solapados + captura + daemon sobre la misma
    // base, y el gate anti-dup del approve fallaba en abierto por ese error).
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("busy_timeout: {e}")))?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| MemoryError::RemoteUnavailable(format!("WAL pragma: {e}")))?;
    apply_schema(&conn)?;
    Ok(conn)
}

/// `user_version` que deja `apply_schema` en una base al día. Cada migración
/// versionada sube la versión solo si su transacción termina bien:
/// 2 = columnas derivadas (`content_hash`), 3 = tablas v3, 5 = retirada del
/// codegraph interno, 6 = backfill de `valid_from` (2026-10-26).
pub const LATEST_USER_VERSION: i64 = crate::memory::schema_v3::USER_VERSION_TEMPORAL;

/// Create all tables + FTS triggers and run the pending versioned migrations.
///
/// Sobre una base ya migrada no escribe nada: el DDL es `IF NOT EXISTS`, los
/// `ALTER` solo corren si falta la columna y los backfills solo si
/// `user_version` está por debajo de su versión. Cualquier error se propaga:
/// una migración que no se pudo aplicar no se da por aplicada.
pub fn apply_schema(conn: &Connection) -> Result<(), MemoryError> {
    // `recursive_triggers` (2026-09-22): `insert_item` escribe con
    // `INSERT OR REPLACE`, y el DELETE implicito de REPLACE solo dispara el
    // trigger `memory_items_ad` con este pragma activo. Sin el, cada
    // actualizacion de un item dejaba su fila vieja huerfana en
    // `memory_items_fts` (indice de contenido externo) y la nueva con otro
    // rowid: 10.205 filas frente a 4.390 items, MATCH fallando con "missing
    // row" y el recall sparse devolviendo basura. Es por conexion: va aqui
    // porque `apply_schema` es lo que comparten open_conn y los tests.
    exec(
        conn,
        "PRAGMA recursive_triggers = ON;",
        "recursive_triggers pragma",
    )?;
    create_core_tables(conn)?;
    add_additive_columns(conn)?;
    backfill_derived_columns(conn)?;
    if fts5_available(conn) {
        create_fts(conn)?;
    }
    // OLA M/K (2026-06-04): additive v3 tables (trace_events + deprecation
    // registry) + memory_events.trace_id. Idempotent; coordinated single bump.
    crate::memory::schema_v3::apply_schema_v3(conn)?;
    // RETIRADA codegraph interno (2026-07-02, mand.12): drop de `edges` +
    // `unresolved_refs`. Pure DDL, idempotente. user_version 4→5.
    crate::memory::schema_v4::apply_schema_v5_retire_codegraph(conn)?;
    // Backfill de `valid_from` (user_version 5→6): una sola vez, no en cada
    // apertura (auditoría 2026-10-26, M1).
    crate::memory::schema_v3::apply_temporal_backfill_v6(conn)?;
    drop_legacy_tables(conn);
    Ok(())
}

/// `execute_batch` con el error envuelto en `MemoryError` y su contexto.
pub(crate) fn exec(conn: &Connection, sql: &str, ctx: &str) -> Result<(), MemoryError> {
    conn.execute_batch(sql)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("{ctx}: {e}")))
}

/// `PRAGMA user_version` de la base.
pub(crate) fn user_version(conn: &Connection) -> Result<i64, MemoryError> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| MemoryError::RemoteUnavailable(format!("read user_version: {e}")))
}

/// Sube `user_version` a `target` si está por debajo (nunca la baja).
pub(crate) fn raise_user_version(conn: &Connection, target: i64) -> Result<(), MemoryError> {
    if user_version(conn)? >= target {
        return Ok(());
    }
    exec(
        conn,
        &format!("PRAGMA user_version = {target};"),
        "write user_version",
    )
}

/// DDL base: tablas canónicas e índices que no dependen de columnas añadidas
/// después. `IF NOT EXISTS` en todo: sobre una base existente no escribe.
fn create_core_tables(conn: &Connection) -> Result<(), MemoryError> {
    exec(
        conn,
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
        "schema core",
    )
}

/// Columnas aditivas para bases creadas antes de que existieran, más los
/// índices que dependen de ellas (van DESPUÉS del `ADD COLUMN`: en una base
/// antigua sin `content_hash`, crear el índice dentro del DDL base abortaba con
/// "no such column").
fn add_additive_columns(conn: &Connection) -> Result<(), MemoryError> {
    // Pinning (req #17).
    add_column_if_missing(conn, "pinned", "INTEGER NOT NULL DEFAULT 0")?;
    // OLA B (2026-06-04): columnas derivadas; su backfill va versionado en
    // `backfill_derived_columns`.
    add_column_if_missing(conn, "content_hash", "TEXT")?;
    add_column_if_missing(conn, "normalized_text", "TEXT")?;
    add_column_if_missing(conn, "schema_version", "INTEGER NOT NULL DEFAULT 1")?;
    exec(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_items_content_hash ON memory_items(content_hash);",
        "index content_hash",
    )?;
    // Code-location capture (2026-06-05): todas anulables, sin backfill.
    for (col, decl) in CODE_LOCATION_COLUMNS {
        add_column_if_missing(conn, col, decl)?;
    }
    for (col, decl) in CANDIDATE_CODE_LOCATION_COLUMNS {
        add_column_if_missing_on(conn, "memory_candidates", col, decl)?;
    }
    // O(1) symbol lookup for re-capture dedupe (one row per "file_path:symbol").
    exec(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_items_symbol ON memory_items(symbol);",
        "index symbol",
    )
}

const CODE_LOCATION_COLUMNS: [(&str, &str); 5] = [
    ("symbol", "TEXT"),
    ("file_path", "TEXT"),
    ("line", "INTEGER"),
    ("signature", "TEXT"),
    ("capture_source", "TEXT"),
];

const CANDIDATE_CODE_LOCATION_COLUMNS: [(&str, &str); 5] = [
    ("proposed_symbol", "TEXT"),
    ("proposed_file_path", "TEXT"),
    ("proposed_line", "INTEGER"),
    ("proposed_signature", "TEXT"),
    ("capture_source", "TEXT"),
];

/// CLEANUP (2026-06-05): drop the legacy `memories` and `memories_fts` tables
/// created by a pre-kernel schema (0 rows, dead weight).
///
/// ORDER IS CRITICAL (fix HIGH #2, 2026-06-05): the FTS5 virtual table goes
/// FIRST (SQLite destroys its shadow tables with it); dropping the shadows
/// manually before makes `DROP TABLE memories_fts` fail with "vtable
/// constructor failed". `DROP TABLE IF EXISTS` is idempotent and, with the
/// tables already gone, writes nothing. Non-fatal: the canonical tables are not
/// touched, so a failure here is logged and the open continues.
fn drop_legacy_tables(conn: &Connection) {
    if let Err(e) = exec(
        conn,
        "DROP TABLE IF EXISTS memories_fts;
         DROP TABLE IF EXISTS memories;",
        "legacy-table cleanup",
    ) {
        tracing::warn!("[sqlite_store] {e} (non-fatal)");
    }
}

/// One-shot backfill of `content_hash` + `normalized_text` for rows written
/// before those columns existed (the legacy active items). Gated by
/// `PRAGMA user_version`: runs once, in one `BEGIN IMMEDIATE` transaction that
/// also bumps the version, so the bump only lands if every UPDATE did. Later
/// opens skip it with a single cheap PRAGMA read. Re-entrant-safe (only NULL
/// rows). The joined text mirrors `MemoryItem::searchable_text()` so a
/// backfilled hash equals the hash `insert_item` would later write.
pub(super) fn backfill_derived_columns(conn: &Connection) -> Result<(), MemoryError> {
    const USER_VERSION_DERIVED: i64 = 2;
    if user_version(conn)? >= USER_VERSION_DERIVED {
        return Ok(());
    }
    super::tx::in_immediate_tx(conn, || {
        for (id, raw) in rows_missing_hash(conn)? {
            let normalized = crate::memory::texthash::normalize_text(&raw);
            let chash = crate::memory::texthash::content_hash(&normalized);
            conn.execute(
                "UPDATE memory_items SET normalized_text = ?1, content_hash = ?2, \
                 schema_version = ?3 WHERE id = ?4 AND content_hash IS NULL",
                rusqlite::params![normalized, chash, crate::memory::model::SCHEMA_VERSION, id],
            )
            .map_err(|e| MemoryError::RemoteUnavailable(format!("backfill content_hash: {e}")))?;
        }
        raise_user_version(conn, USER_VERSION_DERIVED)
    })
}

/// `(id, texto unido)` de las filas sin `content_hash`.
fn rows_missing_hash(conn: &Connection) -> Result<Vec<(String, String)>, MemoryError> {
    let err = |e: rusqlite::Error| MemoryError::RemoteUnavailable(format!("backfill select: {e}"));
    let mut stmt = conn
        .prepare("SELECT id, title, summary, content FROM memory_items WHERE content_hash IS NULL")
        .map_err(err)?;
    let rows = stmt
        .query_map([], |r| {
            let joined = [
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
            Ok((r.get::<_, String>(0)?, joined))
        })
        .map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}
