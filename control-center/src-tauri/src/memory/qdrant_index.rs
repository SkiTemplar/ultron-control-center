// ULTRON Control Center — Canonical dense index (MEMORY KERNEL Fase B)
//
// Indexes ACTIVE `memory_items` into the Qdrant collection `ultron_memory`
// (MultilingualE5Large, 1024-d) with a rich, filterable payload. This is the
// DERIVED dense index — `brain.db` remains the source of truth; this can be
// rebuilt at any time with `reindex_all`.
//
// Separate from the legacy `ultron_sessions` (384-d BGE), which is retired in
// Fase F. Qdrant is an index here, never the source of truth.

use std::collections::HashMap;

use super::model::{MemoryItem, Status};
use super::service::MemoryService;
use super::MemoryError;

/// The Fase B canonical dense collection (1024-d E5).
pub const COLLECTION: &str = "ultron_memory";

/// Rich, filterable payload for an item — mirrors the governance fields so the
/// recall can filter by status/scope/project without a round-trip to SQLite.
fn item_payload(item: &MemoryItem) -> HashMap<String, serde_json::Value> {
    let mut p: HashMap<String, serde_json::Value> = HashMap::new();
    p.insert("canonical_id".to_string(), item.id.clone().into());
    p.insert("type".to_string(), item.kind.as_str().into());
    p.insert("scope".to_string(), item.scope.as_str().into());
    if let Some(pid) = &item.project_id {
        p.insert("project_id".to_string(), pid.clone().into());
    }
    p.insert("status".to_string(), item.status.as_str().into());
    p.insert("confidence".to_string(), serde_json::json!(item.confidence));
    p.insert("importance".to_string(), serde_json::json!(item.importance));
    if let Some(s) = &item.summary {
        p.insert("summary".to_string(), s.clone().into());
    }
    p.insert("tags".to_string(), serde_json::json!(item.tags));
    p.insert("updated_at".to_string(), serde_json::json!(item.updated_at));
    p
}

/// Embed (E5 `passage:`) + upsert a single item into `ultron_memory`.
/// Errors if E5 is unavailable (zero vector) so the caller can count it.
pub fn index_item(item: &MemoryItem) -> Result<(), String> {
    let vector = crate::qdrant::embed_e5(&item.searchable_text(), false)?;
    if vector.iter().all(|&x| x == 0.0) {
        return Err("E5 embedding unavailable (zero vector) — item not indexed".to_string());
    }
    crate::qdrant::upsert_e5(COLLECTION, &item.id, vector, item_payload(item))
}

/// Rebuild the dense index from every ACTIVE item. Returns `(indexed, errors)`.
///
/// Warms up the E5 model FIRST so a missing/undownloaded model surfaces as one
/// clear error instead of N silent per-item failures (the model is a ~1.3 GB
/// lazy download; triggering it inside the loop was fragile).
pub fn reindex_all() -> Result<(usize, usize), MemoryError> {
    let probe = crate::qdrant::embed_e5("warmup", false)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("E5 model unavailable: {e}")))?;
    if probe.iter().all(|&x| x == 0.0) {
        return Err(MemoryError::RemoteUnavailable(
            "E5 returned a zero vector — model unavailable or `qdrant` feature off".to_string(),
        ));
    }

    let items = MemoryService::list_by_status(Status::Active, 100_000)?;
    let mut ok = 0usize;
    let mut err = 0usize;
    for item in &items {
        match index_item(item) {
            Ok(()) => ok += 1,
            Err(_) => err += 1,
        }
    }
    Ok((ok, err))
}

/// Retire an item from the dense index (for rejected/deprecated/quarantined).
/// Best-effort: a missing point/collection is not an error.
pub fn remove_item(id: &str) -> Result<(), String> {
    crate::qdrant::delete_point(COLLECTION, id)
}

/// Dense recall: embed the query (E5 `query:`), filter `status = active`
/// (+ optional project), return canonical_ids best-first. Returns an empty vec
/// when E5 is unavailable (zero vector) or Qdrant is offline, so the caller
/// degrades cleanly to sparse-only recall.
pub fn search_dense(query: &str, k: u32, project_id: Option<&str>) -> Vec<String> {
    let vector = match crate::qdrant::embed_e5(query, true) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    if vector.iter().all(|&x| x == 0.0) {
        return Vec::new(); // E5 stub / unavailable -> sparse only
    }
    let mut must = vec![serde_json::json!({ "key": "status", "match": { "value": "active" } })];
    if let Some(pid) = project_id {
        must.push(serde_json::json!({ "key": "project_id", "match": { "value": pid } }));
    }
    let filter = serde_json::json!({ "must": must });
    match crate::qdrant::search_with_vector(COLLECTION, vector, k, Some(filter)) {
        Ok(hits) => hits
            .into_iter()
            .map(|h| {
                h.payload
                    .get("canonical_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .unwrap_or(h.id)
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}
