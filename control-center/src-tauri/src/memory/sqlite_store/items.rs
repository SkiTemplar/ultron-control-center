// sqlite_store/items.rs — CRUD + search on memory_items.

use rusqlite::{named_params, params, Connection};

use crate::memory::model::{MemoryItem, MemoryType, Scope, Source, Status};
use crate::memory::MemoryError;

use super::row_mapping::{item_from_row, sparse_terms, vec_to_json, ITEM_COLS};
use super::schema::fts5_available;

pub fn insert_item(conn: &Connection, item: &MemoryItem) -> Result<(), MemoryError> {
    // OLA B: derive content_hash + normalized_text authoritatively here. Every
    // write path funnels through insert_item, so the dedupe key stays consistent
    // regardless of caller, and is computed AFTER redaction (service.rs).
    let normalized = crate::memory::texthash::normalize_text(&item.searchable_text());
    let content_hash = crate::memory::texthash::content_hash(&normalized);
    conn.execute(
        "INSERT OR REPLACE INTO memory_items (
            id,type,scope,project_id,repo_id,branch,workflow_id,agent_id,skill_id,
            title,summary,content,content_json,tags,status,confidence,importance,stability,
            sensitivity,source,source_session_id,created_at,updated_at,expires_at,supersedes,
            superseded_by,contradicts,derived_from,valid_from,valid_to,qdrant_point_id,
            token_estimate,access_count,
            last_accessed_at,last_injected_at,validated_by_user,validated_at,pinned,
            content_hash,normalized_text,schema_version,
            symbol,file_path,line,signature,capture_source
        ) VALUES (
            :id,:type,:scope,:project_id,:repo_id,:branch,:workflow_id,:agent_id,:skill_id,
            :title,:summary,:content,:content_json,:tags,:status,:confidence,:importance,:stability,
            :sensitivity,:source,:source_session_id,:created_at,:updated_at,:expires_at,:supersedes,
            :superseded_by,:contradicts,:derived_from,:valid_from,:valid_to,:qdrant_point_id,
            :token_estimate,:access_count,
            :last_accessed_at,:last_injected_at,:validated_by_user,:validated_at,:pinned,
            :content_hash,:normalized_text,:schema_version,
            :symbol,:file_path,:line,:signature,:capture_source
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
            ":valid_from": item.valid_from, ":valid_to": item.valid_to,
            ":qdrant_point_id": item.qdrant_point_id, ":token_estimate": item.token_estimate,
            ":access_count": item.access_count, ":last_accessed_at": item.last_accessed_at,
            ":last_injected_at": item.last_injected_at,
            ":validated_by_user": i64::from(item.validated_by_user),
            ":validated_at": item.validated_at,
            ":pinned": i64::from(item.pinned),
            ":content_hash": content_hash,
            ":normalized_text": normalized,
            ":schema_version": crate::memory::model::SCHEMA_VERSION,
            ":symbol": item.symbol,
            ":file_path": item.file_path,
            ":line": item.line,
            ":signature": item.signature,
            ":capture_source": item.capture_source,
        },
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("insert_item: {e}")))?;
    Ok(())
}

pub fn get_item(conn: &Connection, id: &str) -> Result<Option<MemoryItem>, MemoryError> {
    let sql = format!("SELECT {ITEM_COLS} FROM memory_items WHERE id = ?1");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("get_item prepare: {e}")))?;
    let mut rows = stmt
        .query(params![id])
        .map_err(|e| MemoryError::RemoteUnavailable(format!("get_item query: {e}")))?;
    match rows
        .next()
        .map_err(|e| MemoryError::ParseError(e.to_string()))?
    {
        Some(row) => Ok(Some(
            item_from_row(row).map_err(|e| MemoryError::ParseError(e.to_string()))?,
        )),
        None => Ok(None),
    }
}

/// L0 exact dedupe (OLA E): the first ACTIVE item whose `content_hash` matches.
/// Uses `idx_items_content_hash`; complements the FTS near-dupe path.
pub fn find_active_by_content_hash(
    conn: &Connection,
    hash: &str,
    scope: Scope,
    project_id: Option<&str>,
) -> Result<Option<MemoryItem>, MemoryError> {
    let sql = format!(
        "SELECT {ITEM_COLS} FROM memory_items \
         WHERE content_hash = ?1 AND status = ?2 AND scope = ?3 AND project_id IS ?4 LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| {
        MemoryError::RemoteUnavailable(format!("find_by_content_hash prepare: {e}"))
    })?;
    let mut rows = stmt
        .query(params![
            hash,
            Status::Active.as_str(),
            scope.as_str(),
            project_id
        ])
        .map_err(|e| MemoryError::RemoteUnavailable(format!("find_by_content_hash query: {e}")))?;
    match rows
        .next()
        .map_err(|e| MemoryError::ParseError(e.to_string()))?
    {
        Some(row) => Ok(Some(
            item_from_row(row).map_err(|e| MemoryError::ParseError(e.to_string()))?,
        )),
        None => Ok(None),
    }
}

pub fn delete_item(conn: &Connection, id: &str) -> Result<(), MemoryError> {
    let n = conn
        .execute("DELETE FROM memory_items WHERE id = ?1", params![id])
        .map_err(|e| MemoryError::RemoteUnavailable(format!("delete_item: {e}")))?;
    if n == 0 {
        return Err(MemoryError::NotFound(id.to_string()));
    }
    Ok(())
}

pub fn search_items(
    conn: &Connection,
    query: &str,
    status: Status,
    limit: usize,
) -> Result<Vec<MemoryItem>, MemoryError> {
    let mut out: Vec<MemoryItem> = Vec::new();

    if fts5_available(conn) && !query.trim().is_empty() {
        // BM25 ordering (headroom): SQLite FTS5 bm25() returns a NEGATIVE value —
        // more relevant = more negative — so ASC puts the best match first. The
        // row order produced here IS the sparse BM25 rank consumed by build_trace:
        // `sparse_ids = search_active(query, FANOUT_K).map(|it| it.id)` preserves
        // this order, so the sparse_rank HashMap in build_trace reflects true BM25
        // rank. The quality re-ranker multiplier is applied AFTER RRF fusion, not
        // here, so BM25 order feeds into the sparse rank input cleanly.
        let sql = format!(
            "SELECT {ITEM_COLS} FROM memory_items_fts f
             JOIN memory_items m ON m.rowid = f.rowid
             WHERE memory_items_fts MATCH ?1 AND m.status = ?2
             ORDER BY bm25(memory_items_fts) ASC LIMIT ?3"
        );
        // B3: term-OR query instead of whole-string PHRASE match. Quoting the
        // entire query forced an exact-phrase match, so any multi-word query with
        // stopwords returned 0 hits. Tokenise, quote+escape each term (>=2 chars
        // to drop noise), and join with OR to restore sparse recall.
        let terms: Vec<String> = sparse_terms(query)
            .iter()
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect();
        let fts_query = if terms.is_empty() {
            format!("\"{}\"", query.replace('"', "\"\""))
        } else {
            terms.join(" OR ")
        };
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
        // B3 fallback: when FTS5 is unavailable (the release + `qdrant` build can
        // land here), do a TERM-OR LIKE instead of a whole-string substring —
        // otherwise a multi-word query matches only the literal phrase and returns 0.
        let terms: Vec<String> = sparse_terms(query)
            .iter()
            .map(|t| format!("%{t}%"))
            .collect();
        let terms = if terms.is_empty() {
            vec![format!("%{}%", query.trim())]
        } else {
            terms
        };
        let clause = terms
            .iter()
            .map(|_| "(title LIKE ? OR summary LIKE ? OR content LIKE ?)")
            .collect::<Vec<_>>()
            .join(" OR ");
        // status.as_str() and limit are fixed-shape, non-user values -> inlined
        // safely; the user-derived needles are bound parameters (no injection).
        let sql = format!(
            "SELECT {ITEM_COLS} FROM memory_items
             WHERE status = '{}' AND ({clause})
             ORDER BY importance DESC, updated_at DESC LIMIT {}",
            status.as_str(),
            limit as i64
        );
        let binds: Vec<String> = terms
            .iter()
            .flat_map(|n| [n.clone(), n.clone(), n.clone()])
            .collect();
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| MemoryError::RemoteUnavailable(format!("search LIKE prepare: {e}")))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(binds.iter()), item_from_row)
            .map_err(|e| MemoryError::RemoteUnavailable(format!("search LIKE query: {e}")))?;
        for item in rows.flatten() {
            out.push(item);
        }
    }
    Ok(out)
}

/// Plain list by status (for the CLI / inbox), newest first.
pub fn list_items(
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

pub fn count_items_by_status(conn: &Connection, status: Status) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM memory_items WHERE status = ?1",
        params![status.as_str()],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// Count items by provenance — used by the ETL for source-level idempotency.
pub fn count_by_source(conn: &Connection, source: Source) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM memory_items WHERE source = ?1",
        params![source.as_str()],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// True when an item already carries this `qdrant_point_id` (per-point ETL dedup).
pub fn item_exists_by_qdrant_id(conn: &Connection, qid: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM memory_items WHERE qdrant_point_id = ?1 LIMIT 1",
        params![qid],
        |_| Ok(()),
    )
    .is_ok()
}

/// Active items pinned by the user — always surfaced (Session Resume, recall).
pub fn list_pinned(conn: &Connection, limit: usize) -> Result<Vec<MemoryItem>, MemoryError> {
    let sql = format!(
        "SELECT {ITEM_COLS} FROM memory_items WHERE pinned = 1 AND status = 'active'
         ORDER BY importance DESC, updated_at DESC LIMIT ?1"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_pinned prepare: {e}")))?;
    let rows = stmt
        .query_map(params![limit as i64], item_from_row)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_pinned query: {e}")))?;
    Ok(rows.flatten().collect())
}

/// Active items of a given type (e.g. open tasks, decisions) — newest first.
pub fn list_by_type_status(
    conn: &Connection,
    kind: MemoryType,
    status: Status,
    limit: usize,
) -> Result<Vec<MemoryItem>, MemoryError> {
    let sql = format!(
        "SELECT {ITEM_COLS} FROM memory_items WHERE type = ?1 AND status = ?2
         ORDER BY importance DESC, updated_at DESC LIMIT ?3"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_by_type prepare: {e}")))?;
    let rows = stmt
        .query_map(
            params![kind.as_str(), status.as_str(), limit as i64],
            item_from_row,
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_by_type query: {e}")))?;
    Ok(rows.flatten().collect())
}

/// Memory Browser query — paginated, filterable listing over `memory_items`.
///
/// Every filter is optional and AND-combined. `search` matches a substring on
/// title/summary (LIKE). Ordering mirrors `list_pinned`/recall (importance, then
/// recency). Returns `(page, total)` where `total` is the unpaginated match count
/// so the UI can render pagination. All filters are bound parameters (no
/// injection); only the dynamic WHERE shape is string-built.
#[allow(clippy::too_many_arguments)]
pub fn query_items(
    conn: &Connection,
    status: Option<Status>,
    kind: Option<MemoryType>,
    search: Option<&str>,
    pinned_only: bool,
    offset: usize,
    limit: usize,
) -> Result<(Vec<MemoryItem>, i64), MemoryError> {
    // Build the shared WHERE clause + its bound values. The needle is owned so it
    // outlives the param vec; the enum strings are 'static.
    let mut clauses: Vec<String> = Vec::new();
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(s) = status {
        clauses.push("status = ?".to_string());
        binds.push(Box::new(s.as_str().to_string()));
    }
    if let Some(k) = kind {
        clauses.push("type = ?".to_string());
        binds.push(Box::new(k.as_str().to_string()));
    }
    if pinned_only {
        clauses.push("pinned = 1".to_string());
    }
    if let Some(q) = search {
        let q = q.trim();
        if !q.is_empty() {
            clauses.push("(title LIKE ? OR summary LIKE ?)".to_string());
            let needle = format!("%{q}%");
            binds.push(Box::new(needle.clone()));
            binds.push(Box::new(needle));
        }
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };

    // Total (unpaginated) match count — drives the UI pagination.
    let count_sql = format!("SELECT COUNT(*) FROM memory_items {where_sql}");
    let count_params: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    let total: i64 = conn
        .query_row(&count_sql, count_params.as_slice(), |r| r.get(0))
        .map_err(|e| MemoryError::RemoteUnavailable(format!("query_items count: {e}")))?;

    // Page — same filters + ORDER BY + LIMIT/OFFSET (the last two are bound too).
    let page_sql = format!(
        "SELECT {ITEM_COLS} FROM memory_items {where_sql}
         ORDER BY importance DESC, updated_at DESC LIMIT ? OFFSET ?"
    );
    let mut page_binds = binds;
    page_binds.push(Box::new(limit as i64));
    page_binds.push(Box::new(offset as i64));
    let page_params: Vec<&dyn rusqlite::ToSql> = page_binds.iter().map(|b| b.as_ref()).collect();

    let mut stmt = conn
        .prepare(&page_sql)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("query_items prepare: {e}")))?;
    let rows = stmt
        .query_map(page_params.as_slice(), item_from_row)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("query_items query: {e}")))?;
    let items: Vec<MemoryItem> = rows.flatten().collect();
    Ok((items, total))
}

/// Find all item ids that start with `prefix` (any status, any sensitivity).
///
/// Used by the `forget --id` CLI subcommand to resolve an unambiguous short
/// prefix to a full UUID before delegating to `MemoryService::forget`.
/// The caller validates that exactly one id is returned (ambiguity guard).
pub fn find_ids_by_prefix(conn: &Connection, prefix: &str) -> Result<Vec<String>, MemoryError> {
    // LIKE pattern: prefix% (case-sensitive for UUIDs — all lower-hex).
    let pattern = format!("{prefix}%");
    let mut stmt = conn
        .prepare("SELECT id FROM memory_items WHERE id LIKE ?1")
        .map_err(|e| MemoryError::RemoteUnavailable(format!("find_ids_by_prefix prepare: {e}")))?;
    let ids: Vec<String> = stmt
        .query_map(params![pattern], |r| r.get(0))
        .map_err(|e| MemoryError::RemoteUnavailable(format!("find_ids_by_prefix query: {e}")))?
        .flatten()
        .collect();
    Ok(ids)
}
