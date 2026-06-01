// ULTRON Control Center — SQLite memory store (MEMORY CORE D3)
//
// Persistent memory backend backed by a local SQLite database at
// `<ultron_root>/brain.db`.  Uses FTS5 for ranked full-text search with a
// graceful fallback to LIKE search when FTS5 is unavailable at runtime.
//
// Schema (idempotent on every open):
//   memories(id, text, namespace, source, tags, created_at)
//   memories_fts  — FTS5 external-content table mirroring memories.text
//   kg_entities(name, entity_type, observations)
//   kg_relations(from_name, to_name, relation_type)
//
// Thread safety: each public method opens a fresh Connection.  SQLite in
// WAL mode supports concurrent readers + one writer; a Mutex is not needed
// when every call is an independent transaction.

use std::path::PathBuf;
use std::sync::OnceLock;

use rusqlite::{Connection, Result as SqlResult, params};

use super::{Capabilities, MemoryDoc, MemoryError, MemoryHit, MemoryStore, Query, StoreHealth, StoreKind};

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

fn brain_db_path() -> Result<PathBuf, MemoryError> {
    dirs::home_dir()
        .map(|h| h.join(".ultron").join("brain.db"))
        .ok_or_else(|| MemoryError::IoError(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no HOME dir",
        )))
}

// ---------------------------------------------------------------------------
// FTS5 availability probe — checked once per process
// ---------------------------------------------------------------------------

static FTS5_AVAILABLE: OnceLock<bool> = OnceLock::new();

fn fts5_available(conn: &Connection) -> bool {
    *FTS5_AVAILABLE.get_or_init(|| {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x);
             DROP TABLE IF EXISTS _fts5_probe;"
        ).is_ok()
    })
}

// ---------------------------------------------------------------------------
// Open + schema bootstrap
// ---------------------------------------------------------------------------

fn open_conn() -> Result<Connection, MemoryError> {
    let path = brain_db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(MemoryError::IoError)?;
    }
    let conn = Connection::open(&path)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("brain.db open: {e}")))?;

    // WAL mode for concurrent read access.
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| MemoryError::RemoteUnavailable(format!("WAL pragma: {e}")))?;

    apply_schema(&conn)?;
    Ok(conn)
}

fn apply_schema(conn: &Connection) -> Result<(), MemoryError> {
    // Core memories table.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memories (
            id         TEXT PRIMARY KEY,
            text       TEXT NOT NULL,
            namespace  TEXT,
            source     TEXT,
            tags       TEXT,
            created_at INTEGER
        );"
    ).map_err(|e| MemoryError::RemoteUnavailable(format!("schema memories: {e}")))?;

    // FTS5 external-content table + triggers — only when FTS5 is available.
    if fts5_available(conn) {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
                USING fts5(text, content='memories', content_rowid='rowid');

             -- keep FTS in sync with the base table
             CREATE TRIGGER IF NOT EXISTS memories_ai
                 AFTER INSERT ON memories BEGIN
                     INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
                 END;

             CREATE TRIGGER IF NOT EXISTS memories_ad
                 AFTER DELETE ON memories BEGIN
                     INSERT INTO memories_fts(memories_fts, rowid, text)
                         VALUES ('delete', old.rowid, old.text);
                 END;

             CREATE TRIGGER IF NOT EXISTS memories_au
                 AFTER UPDATE ON memories BEGIN
                     INSERT INTO memories_fts(memories_fts, rowid, text)
                         VALUES ('delete', old.rowid, old.text);
                     INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
                 END;"
        ).map_err(|e| MemoryError::RemoteUnavailable(format!("schema fts5: {e}")))?;
    }

    // KG tables — mirror of kg.jsonl for indexed lookup.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kg_entities (
            name        TEXT PRIMARY KEY,
            entity_type TEXT,
            observations TEXT
        );
        CREATE TABLE IF NOT EXISTS kg_relations (
            from_name     TEXT,
            to_name       TEXT,
            relation_type TEXT,
            UNIQUE(from_name, to_name, relation_type)
        );"
    ).map_err(|e| MemoryError::RemoteUnavailable(format!("schema kg: {e}")))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// KG jsonl migration
// ---------------------------------------------------------------------------

/// Import entities and relations from `~/.ultron/cockpit/kg.jsonl` into the
/// `kg_entities` / `kg_relations` SQLite tables.  Idempotent — uses
/// `INSERT OR REPLACE` so re-running on startup is safe.
pub fn import_kg_jsonl(conn: &Connection) -> Result<(), MemoryError> {
    let graph = crate::kg::read_graph_inner()
        .map_err(|e| MemoryError::ParseError(format!("kg.jsonl read: {e}")))?;

    for ent in &graph.entities {
        let obs_json = serde_json::to_string(&ent.observations)
            .unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT OR REPLACE INTO kg_entities (name, entity_type, observations)
             VALUES (?1, ?2, ?3)",
            params![ent.name, ent.entity_type, obs_json],
        ).map_err(|e| MemoryError::RemoteUnavailable(format!("kg import entity: {e}")))?;
    }

    for rel in &graph.relations {
        conn.execute(
            "INSERT OR IGNORE INTO kg_relations (from_name, to_name, relation_type)
             VALUES (?1, ?2, ?3)",
            params![rel.from, rel.to, rel.relation_type],
        ).map_err(|e| MemoryError::RemoteUnavailable(format!("kg import relation: {e}")))?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// SqliteStore
// ---------------------------------------------------------------------------

/// `MemoryStore` implementation backed by `~/.ultron/brain.db`.
pub struct SqliteStore;

impl SqliteStore {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Open a connection and ensure the schema is ready.  Returns an error if
    /// the file cannot be created or the schema migration fails.
    pub fn init() -> Result<(), MemoryError> {
        open_conn().map(|_| ())
    }
}

impl Default for SqliteStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStore for SqliteStore {
    fn add(&self, doc: MemoryDoc) -> Result<MemoryHit, MemoryError> {
        let conn = open_conn()?;
        let id = uuid_v4();
        let tags_json = serde_json::to_string(&doc.tags).unwrap_or_else(|_| "[]".to_string());
        let now = unix_secs();
        conn.execute(
            "INSERT INTO memories (id, text, namespace, source, tags, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, doc.text, doc.namespace, "sqlite", tags_json, now],
        ).map_err(|e| MemoryError::RemoteUnavailable(format!("INSERT: {e}")))?;

        Ok(MemoryHit {
            id,
            text: doc.text,
            score: 1.0,
            source: StoreKind::Sqlite,
            namespace: doc.namespace,
        })
    }

    fn search(&self, query: Query) -> Result<Vec<MemoryHit>, MemoryError> {
        let conn = open_conn()?;
        let limit = query.limit.unwrap_or(20) as usize;
        let mut hits: Vec<MemoryHit> = Vec::new();
        let seen_start = hits.len();

        // --- memories: FTS5 or LIKE fallback ---
        if fts5_available(&conn) {
            // bm25() returns negative values — negate for ascending score.
            let mut stmt = conn.prepare(
                "SELECT m.id, m.text, m.namespace, -bm25(memories_fts) as rank
                 FROM memories_fts
                 JOIN memories m ON m.rowid = memories_fts.rowid
                 WHERE memories_fts MATCH ?1
                 ORDER BY rank DESC
                 LIMIT ?2"
            ).map_err(|e| MemoryError::RemoteUnavailable(format!("FTS prepare: {e}")))?;

            let fts_query = format!("\"{}\"", query.text.replace('"', "\"\""));
            let rows = stmt.query_map(params![fts_query, limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            });

            match rows {
                Ok(mapped) => {
                    for row in mapped.flatten() {
                        let (id, text, namespace, rank) = row;
                        // Normalise rank to [0,1] with a soft cap.
                        let score = (rank as f32 / 10.0).min(1.0).max(0.0);
                        hits.push(MemoryHit {
                            id,
                            text,
                            score,
                            source: StoreKind::Sqlite,
                            namespace,
                        });
                    }
                }
                Err(e) => {
                    // FTS error (e.g. bad syntax) — fall through to LIKE below.
                    eprintln!("[sqlite_store] FTS5 query error, falling back to LIKE: {e}");
                }
            }
        }

        // LIKE fallback when FTS5 is off or returned 0 results.
        if hits.len() == seen_start {
            let needle = format!("%{}%", query.text);
            let mut stmt = conn.prepare(
                "SELECT id, text, namespace FROM memories
                 WHERE text LIKE ?1
                 ORDER BY created_at DESC
                 LIMIT ?2"
            ).map_err(|e| MemoryError::RemoteUnavailable(format!("LIKE prepare: {e}")))?;

            let rows = stmt.query_map(params![needle, limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            }).map_err(|e| MemoryError::RemoteUnavailable(format!("LIKE query: {e}")))?;

            for row in rows.flatten() {
                let (id, text, namespace) = row;
                hits.push(MemoryHit {
                    id,
                    text,
                    score: 0.5,
                    source: StoreKind::Sqlite,
                    namespace,
                });
            }
        }

        // --- kg_entities: LIKE over observations ---
        {
            let needle = format!("%{}%", query.text);
            let mut stmt = conn.prepare(
                "SELECT name, entity_type, observations FROM kg_entities
                 WHERE name LIKE ?1 OR entity_type LIKE ?1 OR observations LIKE ?1
                 LIMIT ?2"
            ).map_err(|e| MemoryError::RemoteUnavailable(format!("kg prepare: {e}")))?;

            let rows = stmt.query_map(params![needle, limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            }).map_err(|e| MemoryError::RemoteUnavailable(format!("kg query: {e}")))?;

            for row in rows.flatten() {
                let (name, entity_type, obs_json) = row;
                let obs: Vec<String> = serde_json::from_str(&obs_json).unwrap_or_default();
                let text = if obs.is_empty() {
                    format!("[{entity_type}] {name}")
                } else {
                    format!("[{entity_type}] {name}: {}", obs.join("; "))
                };
                hits.push(MemoryHit {
                    id: format!("kg::{name}"),
                    text,
                    score: 0.6,
                    source: StoreKind::Sqlite,
                    namespace: None,
                });
            }
        }

        // Sort descending by score then stable by id.
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });
        hits.truncate(limit);
        Ok(hits)
    }

    fn delete(&self, id: &str) -> Result<(), MemoryError> {
        let conn = open_conn()?;
        let rows = conn.execute("DELETE FROM memories WHERE id = ?1", params![id])
            .map_err(|e| MemoryError::RemoteUnavailable(format!("DELETE: {e}")))?;
        if rows == 0 {
            return Err(MemoryError::NotFound(id.to_string()));
        }
        Ok(())
    }

    fn health(&self) -> Result<StoreHealth, MemoryError> {
        let conn = open_conn()?;
        let mem_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))
            .unwrap_or(0);
        let kg_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM kg_entities", [], |r| r.get(0))
            .unwrap_or(0);
        Ok(StoreHealth {
            healthy: true,
            message: format!(
                "brain.db OK — {mem_count} memories, {kg_count} kg_entities, fts5={}",
                fts5_available(&conn)
            ),
            latency_ms: None,
        })
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            writable: true,
            semantic_search: false,
            persistent: true,
            kind: StoreKind::Sqlite,
        }
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Minimal UUID-v4 without pulling in the `uuid` crate.
fn uuid_v4() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut h = DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    std::thread::current().id().hash(&mut h);
    let a = h.finish();
    h.write_u64(a);
    let b = h.finish();

    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (a >> 32) as u32,
        (a >> 16) as u16,
        (a & 0xfff) as u16,
        (0x8000u64 | (b >> 48 & 0x3fff)) as u16,
        b & 0x0000_ffff_ffff_ffff_u64
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialize tests to avoid concurrent brain.db writes in the temp env.
    static DB_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_db<F: FnOnce(&SqliteStore)>(f: F) {
        let _g = DB_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("brain.db");
        // Point home to temp so brain_db_path resolves inside the temp dir.
        // We open directly instead of relying on HOME.
        let conn = Connection::open(&db_path).expect("open");
        apply_schema(&conn).expect("schema");
        drop(conn);

        // Patch via env — tests can't easily override HOME on Windows, so we
        // test the schema path directly via a raw Connection.
        let _ = dir; // keep alive
        let store = SqliteStore::new();
        f(&store);
    }

    #[test]
    fn uuid_v4_is_different_each_call() {
        let a = uuid_v4();
        let b = uuid_v4();
        // Not guaranteed but extremely unlikely to collide.
        assert_ne!(a, b);
    }

    #[test]
    fn uuid_v4_format_looks_right() {
        let id = uuid_v4();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 5, "UUID must have 5 dash-separated groups");
    }

    #[test]
    fn import_kg_jsonl_does_not_panic_on_empty_graph() {
        // kg.jsonl may not exist in CI — import_kg_jsonl must not panic.
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("brain.db");
        let conn = Connection::open(&db_path).expect("open");
        apply_schema(&conn).expect("schema");
        // Calling import is best-effort; we just verify it returns without panic.
        let _ = import_kg_jsonl(&conn);
    }
}
