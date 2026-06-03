// ULTRON Control Center — Canonical SQLite store (MEMORY KERNEL · Fase A)
//
// `~/.ultron/brain.db` is THE source of truth for governed memory. This module
// owns the schema and all low-level persistence; `MemoryService` (service.rs)
// layers the audit-event + candidate-lifecycle semantics on top.
//
// Schema (idempotent on open):
//   memory_items      — governed memories (status/confidence/importance/scope/…)
//   memory_items_fts  — FTS5 mirror of title+summary+content (sparse/keyword)
//   memory_events     — append-only audit log of every mutation
//   memory_candidates — proposals awaiting validation (the inbox)
//   kg_entities / kg_relations — KG collapsed in from kg.jsonl
//
// Low-level fns take `&Connection` so they are unit-testable against a temp DB;
// thin public wrappers open `brain.db` per call (WAL = concurrent readers).

use std::path::PathBuf;
use std::sync::OnceLock;

use rusqlite::{Connection, Row, named_params, params};

use super::model::{
    Actor, CandidateAction, CandidateStatus, MemoryCandidate, MemoryEvent, MemoryItem, MemoryType,
    Scope, Sensitivity, Source, Stability, Status, EventType, estimate_tokens, now_millis,
};
use super::{Capabilities, MemoryDoc, MemoryError, MemoryHit, MemoryStore, Query, StoreHealth, StoreKind};

// ---------------------------------------------------------------------------
// Path + connection
// ---------------------------------------------------------------------------

fn brain_db_path() -> Result<PathBuf, MemoryError> {
    dirs::home_dir()
        .map(|h| h.join(".ultron").join("brain.db"))
        .ok_or_else(|| {
            MemoryError::IoError(std::io::Error::new(std::io::ErrorKind::NotFound, "no HOME dir"))
        })
}

static FTS5_AVAILABLE: OnceLock<bool> = OnceLock::new();

fn fts5_available(conn: &Connection) -> bool {
    *FTS5_AVAILABLE.get_or_init(|| {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x);
             DROP TABLE IF EXISTS _fts5_probe;",
        )
        .is_ok()
    })
}

/// Open `brain.db` (creating parent dirs) and ensure the schema exists.
pub(crate) fn open_conn() -> Result<Connection, MemoryError> {
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
pub(crate) fn apply_schema(conn: &Connection) -> Result<(), MemoryError> {
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
            qdrant_point_id TEXT,
            token_estimate  INTEGER NOT NULL DEFAULT 0,
            access_count    INTEGER NOT NULL DEFAULT 0,
            last_accessed_at INTEGER, last_injected_at INTEGER,
            validated_by_user INTEGER NOT NULL DEFAULT 0,
            validated_at    INTEGER
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
            created_at      INTEGER NOT NULL
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
    Ok(())
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

fn json_to_vec(s: Option<String>) -> Vec<String> {
    s.and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
        .unwrap_or_default()
}

fn vec_to_json(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())
}

fn item_from_row(row: &Row) -> rusqlite::Result<MemoryItem> {
    let kind_s: String = row.get("type")?;
    let scope_s: String = row.get("scope")?;
    let status_s: String = row.get("status")?;
    let stability_s: String = row.get("stability")?;
    let sensitivity_s: String = row.get("sensitivity")?;
    let source_s: String = row.get("source")?;
    let validated: i64 = row.get("validated_by_user")?;
    Ok(MemoryItem {
        id: row.get("id")?,
        kind: MemoryType::parse(&kind_s).unwrap_or(MemoryType::Fact),
        scope: Scope::parse(&scope_s).unwrap_or(Scope::Global),
        project_id: row.get("project_id")?,
        repo_id: row.get("repo_id")?,
        branch: row.get("branch")?,
        workflow_id: row.get("workflow_id")?,
        agent_id: row.get("agent_id")?,
        skill_id: row.get("skill_id")?,
        title: row.get("title")?,
        summary: row.get("summary")?,
        content: row.get("content")?,
        content_json: row.get("content_json")?,
        tags: json_to_vec(row.get("tags")?),
        status: Status::parse(&status_s).unwrap_or(Status::Pending),
        confidence: row.get::<_, f64>("confidence")? as f32,
        importance: row.get::<_, f64>("importance")? as f32,
        stability: Stability::parse(&stability_s).unwrap_or(Stability::Durable),
        sensitivity: Sensitivity::parse(&sensitivity_s).unwrap_or(Sensitivity::Internal),
        source: Source::parse(&source_s).unwrap_or(Source::AssistantInferred),
        source_session_id: row.get("source_session_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        expires_at: row.get("expires_at")?,
        supersedes: row.get("supersedes")?,
        superseded_by: row.get("superseded_by")?,
        contradicts: json_to_vec(row.get("contradicts")?),
        derived_from: row.get("derived_from")?,
        qdrant_point_id: row.get("qdrant_point_id")?,
        token_estimate: row.get("token_estimate")?,
        access_count: row.get("access_count")?,
        last_accessed_at: row.get("last_accessed_at")?,
        last_injected_at: row.get("last_injected_at")?,
        validated_by_user: validated != 0,
        validated_at: row.get("validated_at")?,
    })
}

const ITEM_COLS: &str = "id,type,scope,project_id,repo_id,branch,workflow_id,agent_id,skill_id,\
title,summary,content,content_json,tags,status,confidence,importance,stability,sensitivity,\
source,source_session_id,created_at,updated_at,expires_at,supersedes,superseded_by,contradicts,\
derived_from,qdrant_point_id,token_estimate,access_count,last_accessed_at,last_injected_at,\
validated_by_user,validated_at";

// ---------------------------------------------------------------------------
// memory_items CRUD (low-level, &Connection)
// ---------------------------------------------------------------------------

pub(crate) fn insert_item(conn: &Connection, item: &MemoryItem) -> Result<(), MemoryError> {
    conn.execute(
        "INSERT OR REPLACE INTO memory_items (
            id,type,scope,project_id,repo_id,branch,workflow_id,agent_id,skill_id,
            title,summary,content,content_json,tags,status,confidence,importance,stability,
            sensitivity,source,source_session_id,created_at,updated_at,expires_at,supersedes,
            superseded_by,contradicts,derived_from,qdrant_point_id,token_estimate,access_count,
            last_accessed_at,last_injected_at,validated_by_user,validated_at
        ) VALUES (
            :id,:type,:scope,:project_id,:repo_id,:branch,:workflow_id,:agent_id,:skill_id,
            :title,:summary,:content,:content_json,:tags,:status,:confidence,:importance,:stability,
            :sensitivity,:source,:source_session_id,:created_at,:updated_at,:expires_at,:supersedes,
            :superseded_by,:contradicts,:derived_from,:qdrant_point_id,:token_estimate,:access_count,
            :last_accessed_at,:last_injected_at,:validated_by_user,:validated_at
        )",
        named_params! {
            ":id": item.id, ":type": item.kind.as_str(), ":scope": item.scope.as_str(),
            ":project_id": item.project_id, ":repo_id": item.repo_id, ":branch": item.branch,
            ":workflow_id": item.workflow_id, ":agent_id": item.agent_id, ":skill_id": item.skill_id,
            ":title": item.title, ":summary": item.summary, ":content": item.content,
            ":content_json": item.content_json, ":tags": vec_to_json(&item.tags),
            ":status": item.status.as_str(), ":confidence": item.confidence as f64,
            ":importance": item.importance as f64, ":stability": item.stability.as_str(),
            ":sensitivity": item.sensitivity.as_str(), ":source": item.source.as_str(),
            ":source_session_id": item.source_session_id, ":created_at": item.created_at,
            ":updated_at": item.updated_at, ":expires_at": item.expires_at,
            ":supersedes": item.supersedes, ":superseded_by": item.superseded_by,
            ":contradicts": vec_to_json(&item.contradicts), ":derived_from": item.derived_from,
            ":qdrant_point_id": item.qdrant_point_id, ":token_estimate": item.token_estimate,
            ":access_count": item.access_count, ":last_accessed_at": item.last_accessed_at,
            ":last_injected_at": item.last_injected_at,
            ":validated_by_user": i64::from(item.validated_by_user),
            ":validated_at": item.validated_at,
        },
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("insert_item: {e}")))?;
    Ok(())
}

pub(crate) fn get_item(conn: &Connection, id: &str) -> Result<Option<MemoryItem>, MemoryError> {
    let sql = format!("SELECT {ITEM_COLS} FROM memory_items WHERE id = ?1");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("get_item prepare: {e}")))?;
    let mut rows = stmt
        .query(params![id])
        .map_err(|e| MemoryError::RemoteUnavailable(format!("get_item query: {e}")))?;
    match rows.next().map_err(|e| MemoryError::ParseError(e.to_string()))? {
        Some(row) => Ok(Some(item_from_row(row).map_err(|e| MemoryError::ParseError(e.to_string()))?)),
        None => Ok(None),
    }
}

pub(crate) fn delete_item(conn: &Connection, id: &str) -> Result<(), MemoryError> {
    let n = conn
        .execute("DELETE FROM memory_items WHERE id = ?1", params![id])
        .map_err(|e| MemoryError::RemoteUnavailable(format!("delete_item: {e}")))?;
    if n == 0 {
        return Err(MemoryError::NotFound(id.to_string()));
    }
    Ok(())
}

/// FTS5 (bm25) or LIKE fallback over memory_items, filtered to a single status.
pub(crate) fn search_items(
    conn: &Connection,
    query: &str,
    status: Status,
    limit: usize,
) -> Result<Vec<MemoryItem>, MemoryError> {
    let mut out: Vec<MemoryItem> = Vec::new();

    if fts5_available(conn) && !query.trim().is_empty() {
        let sql = format!(
            "SELECT {ITEM_COLS} FROM memory_items_fts f
             JOIN memory_items m ON m.rowid = f.rowid
             WHERE memory_items_fts MATCH ?1 AND m.status = ?2
             ORDER BY bm25(memory_items_fts) ASC LIMIT ?3"
        );
        let fts_query = format!("\"{}\"", query.replace('"', "\"\""));
        if let Ok(mut stmt) = conn.prepare(&sql) {
            let rows = stmt.query_map(
                params![fts_query, status.as_str(), limit as i64],
                item_from_row,
            );
            if let Ok(mapped) = rows {
                for item in mapped.flatten() {
                    out.push(item);
                }
            }
        }
    }

    if out.is_empty() {
        let needle = format!("%{query}%");
        let sql = format!(
            "SELECT {ITEM_COLS} FROM memory_items
             WHERE status = ?1 AND (title LIKE ?2 OR summary LIKE ?2 OR content LIKE ?2)
             ORDER BY importance DESC, updated_at DESC LIMIT ?3"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| MemoryError::RemoteUnavailable(format!("search LIKE prepare: {e}")))?;
        let rows = stmt
            .query_map(params![status.as_str(), needle, limit as i64], item_from_row)
            .map_err(|e| MemoryError::RemoteUnavailable(format!("search LIKE query: {e}")))?;
        for item in rows.flatten() {
            out.push(item);
        }
    }
    Ok(out)
}

/// Plain list by status (for the CLI / inbox), newest first.
pub(crate) fn list_items(
    conn: &Connection,
    status: Status,
    limit: usize,
) -> Result<Vec<MemoryItem>, MemoryError> {
    let sql = format!(
        "SELECT {ITEM_COLS} FROM memory_items WHERE status = ?1
         ORDER BY updated_at DESC LIMIT ?2"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_items prepare: {e}")))?;
    let rows = stmt
        .query_map(params![status.as_str(), limit as i64], item_from_row)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_items query: {e}")))?;
    Ok(rows.flatten().collect())
}

pub(crate) fn count_items_by_status(conn: &Connection, status: Status) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM memory_items WHERE status = ?1",
        params![status.as_str()],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// Count items by provenance — used by the ETL for source-level idempotency.
pub(crate) fn count_by_source(conn: &Connection, source: Source) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM memory_items WHERE source = ?1",
        params![source.as_str()],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// True when an item already carries this `qdrant_point_id` (per-point ETL dedup).
pub(crate) fn item_exists_by_qdrant_id(conn: &Connection, qid: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM memory_items WHERE qdrant_point_id = ?1 LIMIT 1",
        params![qid],
        |_| Ok(()),
    )
    .is_ok()
}

// ---------------------------------------------------------------------------
// memory_events (append-only)
// ---------------------------------------------------------------------------

pub(crate) fn insert_event(conn: &Connection, ev: &MemoryEvent) -> Result<(), MemoryError> {
    conn.execute(
        "INSERT INTO memory_events
            (id,event_type,memory_id,before_json,after_json,actor,source_session_id,
             source_turn_id,reason,confidence,created_at)
         VALUES (:id,:event_type,:memory_id,:before_json,:after_json,:actor,:source_session_id,
             :source_turn_id,:reason,:confidence,:created_at)",
        named_params! {
            ":id": ev.id, ":event_type": ev.event_type.as_str(), ":memory_id": ev.memory_id,
            ":before_json": ev.before_json, ":after_json": ev.after_json, ":actor": ev.actor.as_str(),
            ":source_session_id": ev.source_session_id, ":source_turn_id": ev.source_turn_id,
            ":reason": ev.reason, ":confidence": ev.confidence.map(f64::from),
            ":created_at": ev.created_at,
        },
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("insert_event: {e}")))?;
    Ok(())
}

pub(crate) fn list_events_for(
    conn: &Connection,
    memory_id: &str,
    limit: usize,
) -> Result<Vec<MemoryEvent>, MemoryError> {
    let mut stmt = conn
        .prepare(
            "SELECT id,event_type,memory_id,before_json,after_json,actor,source_session_id,
                    source_turn_id,reason,confidence,created_at
             FROM memory_events WHERE memory_id = ?1 ORDER BY created_at DESC LIMIT ?2",
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_events prepare: {e}")))?;
    let rows = stmt
        .query_map(params![memory_id, limit as i64], |row| {
            let et: String = row.get("event_type")?;
            let ac: String = row.get("actor")?;
            Ok(MemoryEvent {
                id: row.get("id")?,
                event_type: EventType::parse(&et).unwrap_or(EventType::Updated),
                memory_id: row.get("memory_id")?,
                before_json: row.get("before_json")?,
                after_json: row.get("after_json")?,
                actor: Actor::parse(&ac).unwrap_or(Actor::System),
                source_session_id: row.get("source_session_id")?,
                source_turn_id: row.get("source_turn_id")?,
                reason: row.get("reason")?,
                confidence: row.get::<_, Option<f64>>("confidence")?.map(|c| c as f32),
                created_at: row.get("created_at")?,
            })
        })
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_events query: {e}")))?;
    Ok(rows.flatten().collect())
}

// ---------------------------------------------------------------------------
// memory_candidates (inbox)
// ---------------------------------------------------------------------------

pub(crate) fn insert_candidate(conn: &Connection, c: &MemoryCandidate) -> Result<(), MemoryError> {
    conn.execute(
        "INSERT OR REPLACE INTO memory_candidates
            (id,proposed_type,proposed_scope,proposed_title,proposed_summary,proposed_content,
             proposed_content_json,proposed_tags,source_event_ids,source_session_id,confidence,
             importance,risk_level,duplicate_candidates,contradiction_candidates,recommended_action,
             status,created_at)
         VALUES (:id,:pt,:ps,:ptitle,:psummary,:pcontent,:pcjson,:ptags,:seids,:ssid,:conf,:imp,
             :risk,:dups,:contras,:rec,:status,:created)",
        named_params! {
            ":id": c.id, ":pt": c.proposed_type.as_str(), ":ps": c.proposed_scope.as_str(),
            ":ptitle": c.proposed_title, ":psummary": c.proposed_summary, ":pcontent": c.proposed_content,
            ":pcjson": c.proposed_content_json, ":ptags": vec_to_json(&c.proposed_tags),
            ":seids": vec_to_json(&c.source_event_ids), ":ssid": c.source_session_id,
            ":conf": c.confidence as f64, ":imp": c.importance as f64, ":risk": c.risk_level,
            ":dups": vec_to_json(&c.duplicate_candidates),
            ":contras": vec_to_json(&c.contradiction_candidates),
            ":rec": c.recommended_action.as_str(), ":status": c.status.as_str(),
            ":created": c.created_at,
        },
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("insert_candidate: {e}")))?;
    Ok(())
}

fn candidate_from_row(row: &Row) -> rusqlite::Result<MemoryCandidate> {
    let pt: String = row.get("proposed_type")?;
    let ps: String = row.get("proposed_scope")?;
    let rec: String = row.get("recommended_action")?;
    let st: String = row.get("status")?;
    Ok(MemoryCandidate {
        id: row.get("id")?,
        proposed_type: MemoryType::parse(&pt).unwrap_or(MemoryType::Fact),
        proposed_scope: Scope::parse(&ps).unwrap_or(Scope::Global),
        proposed_title: row.get("proposed_title")?,
        proposed_summary: row.get("proposed_summary")?,
        proposed_content: row.get("proposed_content")?,
        proposed_content_json: row.get("proposed_content_json")?,
        proposed_tags: json_to_vec(row.get("proposed_tags")?),
        source_event_ids: json_to_vec(row.get("source_event_ids")?),
        source_session_id: row.get("source_session_id")?,
        confidence: row.get::<_, f64>("confidence")? as f32,
        importance: row.get::<_, f64>("importance")? as f32,
        risk_level: row.get("risk_level")?,
        duplicate_candidates: json_to_vec(row.get("duplicate_candidates")?),
        contradiction_candidates: json_to_vec(row.get("contradiction_candidates")?),
        recommended_action: CandidateAction::parse(&rec).unwrap_or(CandidateAction::Approve),
        status: CandidateStatus::parse(&st).unwrap_or(CandidateStatus::Pending),
        created_at: row.get("created_at")?,
    })
}

pub(crate) fn get_candidate(conn: &Connection, id: &str) -> Result<Option<MemoryCandidate>, MemoryError> {
    let mut stmt = conn
        .prepare("SELECT * FROM memory_candidates WHERE id = ?1")
        .map_err(|e| MemoryError::RemoteUnavailable(format!("get_candidate prepare: {e}")))?;
    let mut rows = stmt
        .query(params![id])
        .map_err(|e| MemoryError::RemoteUnavailable(format!("get_candidate query: {e}")))?;
    match rows.next().map_err(|e| MemoryError::ParseError(e.to_string()))? {
        Some(row) => Ok(Some(
            candidate_from_row(row).map_err(|e| MemoryError::ParseError(e.to_string()))?,
        )),
        None => Ok(None),
    }
}

pub(crate) fn list_candidates(
    conn: &Connection,
    status: CandidateStatus,
    limit: usize,
) -> Result<Vec<MemoryCandidate>, MemoryError> {
    let mut stmt = conn
        .prepare(
            "SELECT * FROM memory_candidates WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2",
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_candidates prepare: {e}")))?;
    let rows = stmt
        .query_map(params![status.as_str(), limit as i64], candidate_from_row)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_candidates query: {e}")))?;
    Ok(rows.flatten().collect())
}

pub(crate) fn set_candidate_status(
    conn: &Connection,
    id: &str,
    status: CandidateStatus,
) -> Result<(), MemoryError> {
    let n = conn
        .execute(
            "UPDATE memory_candidates SET status = ?1 WHERE id = ?2",
            params![status.as_str(), id],
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("set_candidate_status: {e}")))?;
    if n == 0 {
        return Err(MemoryError::NotFound(id.to_string()));
    }
    Ok(())
}

pub(crate) fn count_candidates_pending(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM memory_candidates WHERE status = 'pending'",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// KG jsonl import (collapsed into brain.db)
// ---------------------------------------------------------------------------

/// Import entities + relations from `~/.ultron/cockpit/kg.jsonl`. Idempotent.
pub fn import_kg_jsonl(conn: &Connection) -> Result<(), MemoryError> {
    let graph = crate::kg::read_graph_inner()
        .map_err(|e| MemoryError::ParseError(format!("kg.jsonl read: {e}")))?;
    for ent in &graph.entities {
        let obs_json = serde_json::to_string(&ent.observations).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT OR REPLACE INTO kg_entities (name, entity_type, observations) VALUES (?1,?2,?3)",
            params![ent.name, ent.entity_type, obs_json],
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("kg import entity: {e}")))?;
    }
    for rel in &graph.relations {
        conn.execute(
            "INSERT OR IGNORE INTO kg_relations (from_name, to_name, relation_type) VALUES (?1,?2,?3)",
            params![rel.from, rel.to, rel.relation_type],
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("kg import relation: {e}")))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// SqliteStore — MemoryStore trait impl (back-compat for recall_hybrid/health)
// ---------------------------------------------------------------------------

/// `MemoryStore` adapter over the canonical `memory_items` table.
pub struct SqliteStore;

impl SqliteStore {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Open `brain.db`, apply the schema, and best-effort import kg.jsonl.
    /// Wired into `lib.rs` setup so the canonical DB is live at startup.
    pub fn init() -> Result<(), MemoryError> {
        let conn = open_conn()?;
        if let Err(e) = import_kg_jsonl(&conn) {
            eprintln!("[sqlite_store] kg.jsonl import skipped: {e}");
        }
        Ok(())
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
        let mut item = MemoryItem::new(
            MemoryType::Fact,
            Scope::Global,
            Source::ManualUi,
            Status::Active,
        );
        item.summary = Some(doc.text.clone());
        item.content = Some(doc.text.clone());
        item.project_id = doc.namespace.clone();
        item.token_estimate = estimate_tokens(&doc.text);
        insert_item(&conn, &item)?;
        let ev = MemoryEvent::new(EventType::Created, Some(item.id.clone()), Actor::System);
        let _ = insert_event(&conn, &ev);
        Ok(MemoryHit {
            id: item.id,
            text: doc.text,
            score: 1.0,
            source: StoreKind::Sqlite,
            namespace: doc.namespace,
        })
    }

    fn search(&self, query: Query) -> Result<Vec<MemoryHit>, MemoryError> {
        let conn = open_conn()?;
        let limit = query.limit.unwrap_or(20) as usize;
        // Only ACTIVE items are recall-eligible (governance invariant).
        let items = search_items(&conn, &query.text, Status::Active, limit)?;
        Ok(items
            .into_iter()
            .map(|it| MemoryHit {
                text: it.summary.clone().or(it.content.clone()).unwrap_or_default(),
                id: it.id,
                // Importance as a coarse score until Fase B real ranking lands.
                score: it.importance.clamp(0.0, 1.0),
                source: StoreKind::Sqlite,
                namespace: it.project_id,
            })
            .collect())
    }

    fn delete(&self, id: &str) -> Result<(), MemoryError> {
        let conn = open_conn()?;
        delete_item(&conn, id)?;
        let ev = MemoryEvent::new(EventType::Deprecated, Some(id.to_string()), Actor::System)
            .with_reason("hard delete via MemoryStore::delete");
        let _ = insert_event(&conn, &ev);
        Ok(())
    }

    fn health(&self) -> Result<StoreHealth, MemoryError> {
        let conn = open_conn()?;
        let active = count_items_by_status(&conn, Status::Active);
        let pending = count_candidates_pending(&conn);
        let kg: i64 = conn
            .query_row("SELECT COUNT(*) FROM kg_entities", [], |r| r.get(0))
            .unwrap_or(0);
        Ok(StoreHealth {
            healthy: true,
            message: format!(
                "brain.db OK — {active} active, {pending} pending candidates, {kg} kg_entities, fts5={}",
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
// Tests — against an in-memory connection (no HOME dependency)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory");
        apply_schema(&conn).expect("schema");
        conn
    }

    #[test]
    fn insert_then_get_roundtrips_an_item() {
        let conn = mem_conn();
        let mut item = MemoryItem::new(MemoryType::Decision, Scope::Project, Source::UserExplicit, Status::Active);
        item.summary = Some("usar bge-m3 para embeddings".into());
        item.project_id = Some("ultron".into());
        item.importance = 0.9;
        insert_item(&conn, &item).unwrap();

        let got = get_item(&conn, &item.id).unwrap().expect("item exists");
        assert_eq!(got.id, item.id);
        assert_eq!(got.kind, MemoryType::Decision);
        assert_eq!(got.status, Status::Active);
        assert_eq!(got.project_id.as_deref(), Some("ultron"));
        assert!((got.importance - 0.9).abs() < 1e-6);
    }

    #[test]
    fn search_only_returns_active_items() {
        let conn = mem_conn();
        let mut active = MemoryItem::new(MemoryType::Fact, Scope::Global, Source::ToolObserved, Status::Active);
        active.summary = Some("oauth refactor decision".into());
        insert_item(&conn, &active).unwrap();

        let mut rejected = MemoryItem::new(MemoryType::Fact, Scope::Global, Source::ToolObserved, Status::Rejected);
        rejected.summary = Some("oauth refactor decision".into());
        insert_item(&conn, &rejected).unwrap();

        let hits = search_items(&conn, "oauth", Status::Active, 10).unwrap();
        assert_eq!(hits.len(), 1, "rejected items must not surface in active search");
        assert_eq!(hits[0].id, active.id);
    }

    #[test]
    fn deleted_item_is_gone() {
        let conn = mem_conn();
        let item = MemoryItem::new(MemoryType::Task, Scope::Session, Source::AssistantInferred, Status::Active);
        insert_item(&conn, &item).unwrap();
        delete_item(&conn, &item.id).unwrap();
        assert!(get_item(&conn, &item.id).unwrap().is_none());
        assert!(matches!(delete_item(&conn, &item.id), Err(MemoryError::NotFound(_))));
    }

    #[test]
    fn events_are_appended_and_listed() {
        let conn = mem_conn();
        let id = "mem-1".to_string();
        for et in [EventType::Created, EventType::Edited, EventType::Approved] {
            let ev = MemoryEvent::new(et, Some(id.clone()), Actor::User);
            insert_event(&conn, &ev).unwrap();
        }
        let events = list_events_for(&conn, &id, 10).unwrap();
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn candidate_lifecycle_persists() {
        let conn = mem_conn();
        let mut c = MemoryCandidate::new(MemoryType::Decision, Scope::Project);
        c.proposed_summary = Some("rescatar vault histórico".into());
        insert_candidate(&conn, &c).unwrap();

        let pending = list_candidates(&conn, CandidateStatus::Pending, 10).unwrap();
        assert_eq!(pending.len(), 1);

        set_candidate_status(&conn, &c.id, CandidateStatus::Approved).unwrap();
        assert_eq!(list_candidates(&conn, CandidateStatus::Pending, 10).unwrap().len(), 0);
        assert_eq!(list_candidates(&conn, CandidateStatus::Approved, 10).unwrap().len(), 1);
    }

    #[test]
    fn rejected_and_quarantined_items_excluded_from_active_search() {
        // "do not use again" (rejected) and quarantine must drop items from recall.
        let conn = mem_conn();
        for status in [Status::Rejected, Status::Quarantined, Status::Deprecated] {
            let mut it = MemoryItem::new(MemoryType::Fact, Scope::Global, Source::ToolObserved, status);
            it.summary = Some("oauth token refresh edge case".into());
            insert_item(&conn, &it).unwrap();
        }
        let mut active = MemoryItem::new(MemoryType::Fact, Scope::Global, Source::ToolObserved, Status::Active);
        active.summary = Some("oauth token refresh edge case".into());
        insert_item(&conn, &active).unwrap();

        let hits = search_items(&conn, "oauth", Status::Active, 20).unwrap();
        assert_eq!(hits.len(), 1, "only the ACTIVE item may surface in recall");
        assert_eq!(hits[0].id, active.id);
    }

    #[test]
    fn approving_a_candidate_makes_it_findable_as_active() {
        // Mirrors MemoryService::approve_candidate at the store layer.
        let conn = mem_conn();
        let mut c = MemoryCandidate::new(MemoryType::Decision, Scope::Project);
        c.proposed_summary = Some("usar MultilingualE5Large para recall".into());
        insert_candidate(&conn, &c).unwrap();
        assert!(search_items(&conn, "MultilingualE5Large", Status::Active, 10).unwrap().is_empty());

        let item = c.to_item(Status::Active, Source::UserExplicit);
        insert_item(&conn, &item).unwrap();
        set_candidate_status(&conn, &c.id, CandidateStatus::Approved).unwrap();

        let hits = search_items(&conn, "MultilingualE5Large", Status::Active, 10).unwrap();
        assert_eq!(hits.len(), 1, "an approved candidate must appear in active recall");
    }

    #[test]
    fn candidate_edit_via_replace_updates_fields() {
        let conn = mem_conn();
        let mut c = MemoryCandidate::new(MemoryType::Fact, Scope::Global);
        c.proposed_summary = Some("original".into());
        insert_candidate(&conn, &c).unwrap();
        c.proposed_summary = Some("editado".into());
        insert_candidate(&conn, &c).unwrap(); // INSERT OR REPLACE
        let got = get_candidate(&conn, &c.id).unwrap().unwrap();
        assert_eq!(got.proposed_summary.as_deref(), Some("editado"));
        assert_eq!(list_candidates(&conn, CandidateStatus::Pending, 10).unwrap().len(), 1);
    }

    #[test]
    fn relabel_changes_scope_and_type_persist() {
        let conn = mem_conn();
        let mut it = MemoryItem::new(MemoryType::Fact, Scope::Global, Source::AssistantInferred, Status::Active);
        insert_item(&conn, &it).unwrap();
        it.scope = Scope::Project;
        it.kind = MemoryType::Architecture;
        insert_item(&conn, &it).unwrap();
        let got = get_item(&conn, &it.id).unwrap().unwrap();
        assert_eq!(got.scope, Scope::Project);
        assert_eq!(got.kind, MemoryType::Architecture);
    }
}
