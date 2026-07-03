// sqlite_store/candidates.rs — memory_candidates inbox operations.

use rusqlite::{named_params, params, Connection};

use crate::memory::model::{CandidateStatus, MemoryCandidate};
use crate::memory::MemoryError;

use super::row_mapping::{candidate_from_row, vec_to_json};

pub fn insert_candidate(conn: &Connection, c: &MemoryCandidate) -> Result<(), MemoryError> {
    conn.execute(
        "INSERT OR REPLACE INTO memory_candidates
            (id,proposed_type,proposed_scope,proposed_title,proposed_summary,proposed_content,
             proposed_content_json,proposed_tags,source_event_ids,source_session_id,confidence,
             importance,risk_level,duplicate_candidates,contradiction_candidates,recommended_action,
             status,created_at,
             proposed_symbol,proposed_file_path,proposed_line,proposed_signature,capture_source)
         VALUES (:id,:pt,:ps,:ptitle,:psummary,:pcontent,:pcjson,:ptags,:seids,:ssid,:conf,:imp,
             :risk,:dups,:contras,:rec,:status,:created,
             :psymbol,:pfile,:pline,:psig,:csource)",
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
            ":psymbol": c.proposed_symbol, ":pfile": c.proposed_file_path,
            ":pline": c.proposed_line, ":psig": c.proposed_signature,
            ":csource": c.capture_source,
        },
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("insert_candidate: {e}")))?;
    Ok(())
}

pub fn get_candidate(conn: &Connection, id: &str) -> Result<Option<MemoryCandidate>, MemoryError> {
    let mut stmt = conn
        .prepare("SELECT * FROM memory_candidates WHERE id = ?1")
        .map_err(|e| MemoryError::RemoteUnavailable(format!("get_candidate prepare: {e}")))?;
    let mut rows = stmt
        .query(params![id])
        .map_err(|e| MemoryError::RemoteUnavailable(format!("get_candidate query: {e}")))?;
    match rows
        .next()
        .map_err(|e| MemoryError::ParseError(e.to_string()))?
    {
        Some(row) => Ok(Some(
            candidate_from_row(row).map_err(|e| MemoryError::ParseError(e.to_string()))?,
        )),
        None => Ok(None),
    }
}

pub fn list_candidates(
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

pub fn set_candidate_status(
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

pub fn count_candidates_pending(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM memory_candidates WHERE status = 'pending'",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// Find all candidate ids that start with `prefix` (any status).
///
/// Mirror of `items::find_ids_by_prefix` for the inbox: lets
/// `inbox approve/reject --id` resolve an unambiguous short prefix instead of
/// demanding the full UUID. The caller enforces the exactly-one-match guard.
pub fn find_candidate_ids_by_prefix(
    conn: &Connection,
    prefix: &str,
) -> Result<Vec<String>, MemoryError> {
    let pattern = format!("{prefix}%");
    let mut stmt = conn
        .prepare("SELECT id FROM memory_candidates WHERE id LIKE ?1")
        .map_err(|e| {
            MemoryError::RemoteUnavailable(format!("find_candidate_ids_by_prefix prepare: {e}"))
        })?;
    let ids: Vec<String> = stmt
        .query_map(params![pattern], |r| r.get(0))
        .map_err(|e| {
            MemoryError::RemoteUnavailable(format!("find_candidate_ids_by_prefix query: {e}"))
        })?
        .flatten()
        .collect();
    Ok(ids)
}
