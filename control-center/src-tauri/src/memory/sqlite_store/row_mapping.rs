// sqlite_store/row_mapping.rs — Row deserialization helpers and shared constants.

use rusqlite::Row;

use crate::memory::model::{
    CandidateAction, CandidateStatus, MemoryCandidate, MemoryItem, MemoryType, Scope, Sensitivity,
    Source, Stability, Status,
};

// ---------------------------------------------------------------------------
// JSON helpers for Vec<String> columns
// ---------------------------------------------------------------------------

pub(super) fn json_to_vec(s: Option<String>) -> Vec<String> {
    s.and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
        .unwrap_or_default()
}

pub(super) fn vec_to_json(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())
}

// ---------------------------------------------------------------------------
// Column list — shared by all SELECT queries on memory_items
// ---------------------------------------------------------------------------

pub(super) const ITEM_COLS: &str =
    "id,type,scope,project_id,repo_id,branch,workflow_id,agent_id,skill_id,\
title,summary,content,content_json,tags,status,confidence,importance,stability,sensitivity,\
source,source_session_id,created_at,updated_at,expires_at,supersedes,superseded_by,contradicts,\
derived_from,valid_from,valid_to,qdrant_point_id,token_estimate,access_count,last_accessed_at,\
last_injected_at,validated_by_user,validated_at,pinned,content_hash,normalized_text,schema_version,\
symbol,file_path,line,signature,capture_source";

// ---------------------------------------------------------------------------
// Sparse search helpers
// ---------------------------------------------------------------------------

/// Max distinct query terms fed into the sparse OR-expansion. Each term becomes
/// 3 `LIKE` nodes (title/summary/content) in the fallback branch, so SQLite's
/// expression-tree depth limit (`SQLITE_LIMIT_EXPR_DEPTH = 1000`) is reached at
/// ~334 terms — a long orchestration prompt would otherwise abort `prepare()`
/// with "Expression tree is too large". 24 terms -> 72 nodes, far below the cap,
/// and the most informative tokens of a prompt come first. Dedup avoids wasting
/// the budget on repeats.
pub(super) const MAX_SPARSE_TERMS: usize = 24;

/// Tokenise a free-text query into the bounded, de-duplicated set of terms used
/// by BOTH sparse branches (FTS5 `MATCH` and the `LIKE` fallback). Drops <2-char
/// noise, dedups case-insensitively (preserving first-seen order + original
/// case), and caps at `MAX_SPARSE_TERMS`. Pure; unit-tested below.
pub(super) fn sparse_terms(query: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    query
        .split_whitespace()
        .filter(|t| t.chars().count() >= 2)
        .filter(|t| seen.insert(t.to_lowercase()))
        .take(MAX_SPARSE_TERMS)
        .map(String::from)
        .collect()
}

// ---------------------------------------------------------------------------
// Row deserializers
// ---------------------------------------------------------------------------

pub(super) fn item_from_row(row: &Row) -> rusqlite::Result<MemoryItem> {
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
        valid_from: row.get("valid_from")?,
        valid_to: row.get("valid_to")?,
        qdrant_point_id: row.get("qdrant_point_id")?,
        token_estimate: row.get("token_estimate")?,
        access_count: row.get("access_count")?,
        last_accessed_at: row.get("last_accessed_at")?,
        last_injected_at: row.get("last_injected_at")?,
        validated_by_user: validated != 0,
        validated_at: row.get("validated_at")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        content_hash: row.get("content_hash")?,
        normalized_text: row.get("normalized_text")?,
        schema_version: row.get::<_, Option<i64>>("schema_version")?.unwrap_or(1),
        symbol: row.get("symbol")?,
        file_path: row.get("file_path")?,
        line: row.get("line")?,
        signature: row.get("signature")?,
        capture_source: row.get("capture_source")?,
    })
}

pub(super) fn candidate_from_row(row: &Row) -> rusqlite::Result<MemoryCandidate> {
    let pt: String = row.get("proposed_type")?;
    let ps: String = row.get("proposed_scope")?;
    let rec: String = row.get("recommended_action")?;
    let st: String = row.get("status")?;
    Ok(MemoryCandidate {
        id: row.get("id")?,
        proposed_type: MemoryType::parse(&pt).unwrap_or(MemoryType::Fact),
        proposed_scope: Scope::parse(&ps).unwrap_or(Scope::Global),
        // No dedicated column: the project survives the round-trip as a
        // `project:<id>` entry inside proposed_tags, which to_item recovers.
        proposed_project_id: None,
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
        proposed_symbol: row.get("proposed_symbol")?,
        proposed_file_path: row.get("proposed_file_path")?,
        proposed_line: row.get("proposed_line")?,
        proposed_signature: row.get("proposed_signature")?,
        capture_source: row.get("capture_source")?,
    })
}
