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

/// Recoge las filas mapeadas sin perder en silencio las que fallan. Antes se
/// hacía `rows.flatten().collect()`: una fila con un tipo de columna inesperado
/// desaparecía de listados y del recall sin dejar rastro (auditoría
/// 2026-10-26, L4). Las válidas se devuelven igual; las que fallan se cuentan y
/// se registran con el primer error, con `ctx` para saber qué consulta era.
pub(crate) fn collect_rows<T>(
    rows: impl IntoIterator<Item = rusqlite::Result<T>>,
    ctx: &str,
) -> Vec<T> {
    let (ok, failed) = split_rows(rows);
    if let Some((count, first)) = failed {
        tracing::warn!(
            "[sqlite_store] {ctx}: {count} fila(s) descartadas al mapear; primer error: {first}"
        );
    }
    ok
}

/// Parte pura de [`collect_rows`]: las filas válidas y, si alguna falló,
/// `(cuántas, primer error)`.
pub(crate) fn split_rows<T>(
    rows: impl IntoIterator<Item = rusqlite::Result<T>>,
) -> (Vec<T>, Option<(usize, rusqlite::Error)>) {
    let mut ok = Vec::new();
    let mut failed: Option<(usize, rusqlite::Error)> = None;
    for row in rows {
        match row {
            Ok(v) => ok.push(v),
            Err(e) => match failed.as_mut() {
                Some((n, _)) => *n += 1,
                None => failed = Some((1, e)),
            },
        }
    }
    (ok, failed)
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

/// Palabras vacias (espanol e ingles, sin tildes: se comparan tras quitarlas).
/// Unidas con OR casaban con casi todo el corpus y dominaban el BM25: "mods de
/// Claude Code" devolvia memorias de otros proyectos por el "de" (2026-10-03).
const STOP_WORDS: &[&str] = &[
    "a", "al", "algo", "ante", "aqui", "asi", "como", "con", "cual", "cuando", "de", "del",
    "desde", "donde", "el", "ella", "en", "entre", "era", "es", "esa", "ese", "eso", "esta",
    "estan", "este", "esto", "fue", "ha", "han", "hay", "he", "la", "las", "le", "les", "lo",
    "los", "mas", "me", "mi", "muy", "no", "nos", "o", "para", "pero", "por", "porque", "que",
    "se", "sea", "ser", "si", "sin", "sobre", "son", "su", "sus", "te", "tiene", "todo", "tu",
    "un", "una", "uno", "y", "ya", "an", "and", "are", "as", "at", "be", "by", "for", "from",
    "how", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the", "this", "to", "was",
    "what", "when", "where", "which", "why", "with",
];

/// Quita las tildes del espanol para comparar con [`STOP_WORDS`].
fn fold_accents(term: &str) -> String {
    term.chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            other => other,
        })
        .collect()
}

/// Tokenise a free-text query into the bounded, de-duplicated set of terms used
/// by BOTH sparse branches (FTS5 `MATCH` and the `LIKE` fallback). Splits on
/// whitespace and punctuation (keeps `_`, `-` and `.` inside identifiers), drops
/// <2-char noise and stop words, dedups case-insensitively (preserving
/// first-seen order + original case), and caps at `MAX_SPARSE_TERMS`. Pure;
/// unit-tested below.
pub(super) fn sparse_terms(query: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    query
        .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-' || c == '.'))
        .map(|t| t.trim_matches(|c: char| c == '-' || c == '.'))
        .filter(|t| t.chars().count() >= 2)
        .filter(|t| !STOP_WORDS.contains(&fold_accents(&t.to_lowercase()).as_str()))
        .filter(|t| seen.insert(t.to_lowercase()))
        .take(MAX_SPARSE_TERMS)
        .map(String::from)
        .collect()
}

/// Vocabulario de contenido de un texto para comparar dos textos entre sí: la
/// misma tokenización y las mismas palabras vacías que [`sparse_terms`], pero en
/// minúsculas, sin tildes y SIN el tope de términos (un `content` largo no debe
/// perder vocabulario por el orden en que aparece). Lo usa el juez de
/// contradicción para decidir si un vecino de FTS5 habla del mismo tema.
pub(crate) fn content_terms(text: &str) -> std::collections::HashSet<String> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-' || c == '.'))
        .map(|t| t.trim_matches(|c: char| c == '-' || c == '.'))
        .filter(|t| t.chars().count() >= 2)
        .map(|t| fold_accents(&t.to_lowercase()))
        .filter(|t| !STOP_WORDS.contains(&t.as_str()))
        .collect()
}

// ---------------------------------------------------------------------------
// Row deserializers
// ---------------------------------------------------------------------------

/// Sensibilidad leída de la base. Un valor fuera del vocabulario (edición a
/// mano, `"SECRET"`, una importación) se trata como la más restrictiva,
/// `Secret`, y se registra: los gates de recall y resume comparan por igualdad
/// con `Secret`, así que leerlo como `Internal` dejaba pasar el item
/// (fail-open, auditoría 2026-10-26 M2).
pub(super) fn sensitivity_fail_closed(raw: &str, id: &str) -> Sensitivity {
    Sensitivity::parse(raw).unwrap_or_else(|| {
        tracing::warn!(
            "[sqlite_store] item {id}: sensitivity desconocida {raw:?}; se trata como secret"
        );
        Sensitivity::Secret
    })
}

pub(super) fn item_from_row(row: &Row) -> rusqlite::Result<MemoryItem> {
    let kind_s: String = row.get("type")?;
    let scope_s: String = row.get("scope")?;
    let status_s: String = row.get("status")?;
    let stability_s: String = row.get("stability")?;
    let sensitivity_s: String = row.get("sensitivity")?;
    let id: String = row.get("id")?;
    let sensitivity = sensitivity_fail_closed(&sensitivity_s, &id);
    let source_s: String = row.get("source")?;
    let validated: i64 = row.get("validated_by_user")?;
    Ok(MemoryItem {
        id,
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
        sensitivity,
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
