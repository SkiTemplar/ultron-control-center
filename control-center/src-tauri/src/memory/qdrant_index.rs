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

// ---------------------------------------------------------------------------
// Reconciliation (OLA B): SQLite (SoT) vs Qdrant (derived index) drift check
// ---------------------------------------------------------------------------

/// Outcome of `reconcile_check`: which active items lack a dense point, and
/// which points are orphaned (no active item). Read-only — never mutates.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ReconcileReport {
    pub count_sqlite_active: usize,
    pub count_qdrant_points: usize,
    pub missing_count: usize,
    pub orphan_count: usize,
    pub in_sync: bool,
    /// Active SQLite item ids with no point in `ultron_memory` (need reindex).
    pub missing_in_qdrant: Vec<String>,
    /// Qdrant point ids with no matching active SQLite item (stale points).
    pub orphan_in_qdrant: Vec<String>,
}

/// Pure set-diff of SQLite active ids vs Qdrant point ids -> `(missing, orphan)`.
/// Extracted so the reconcile logic is unit-testable without a live Qdrant.
fn diff_ids(
    sqlite_active: &std::collections::HashSet<String>,
    qdrant_points: &std::collections::HashSet<String>,
) -> (Vec<String>, Vec<String>) {
    let mut missing: Vec<String> = sqlite_active.difference(qdrant_points).cloned().collect();
    let mut orphan: Vec<String> = qdrant_points.difference(sqlite_active).cloned().collect();
    missing.sort();
    orphan.sort();
    (missing, orphan)
}

/// Read-only consistency check between `brain.db` (active items = source of
/// truth) and the derived `ultron_memory` dense index (point id == item id).
/// Detects missing points (active item never indexed) and orphan points
/// (indexed but no longer active). Does NOT modify either store.
///
/// `reconcile --repair` is intentionally NOT implemented here: repairing mutates
/// the index and the policy (08-AUDIT) requires an explicit dry-run + confirm;
/// `reindex_all` already rebuilds the index from the SoT when that is desired.
pub fn reconcile_check() -> Result<ReconcileReport, MemoryError> {
    let items = MemoryService::list_by_status(Status::Active, 100_000)?;
    let sqlite_active: std::collections::HashSet<String> =
        items.into_iter().map(|i| i.id).collect();

    let points = crate::qdrant::scroll(COLLECTION, 100_000)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("qdrant scroll: {e}")))?;
    let qdrant_points: std::collections::HashSet<String> =
        points.into_iter().map(|p| p.id).collect();

    let (missing, orphan) = diff_ids(&sqlite_active, &qdrant_points);
    Ok(ReconcileReport {
        count_sqlite_active: sqlite_active.len(),
        count_qdrant_points: qdrant_points.len(),
        missing_count: missing.len(),
        orphan_count: orphan.len(),
        in_sync: missing.is_empty() && orphan.is_empty(),
        missing_in_qdrant: missing,
        orphan_in_qdrant: orphan,
    })
}

/// Dense recall: embed the query (E5 `query:`), filter `status = active`
/// (+ optional project), return canonical_ids best-first. Returns an empty vec
/// when E5 is unavailable (zero vector) or Qdrant is offline, so the caller
/// degrades cleanly to sparse-only recall.
pub fn search_dense(query: &str, k: u32, project_id: Option<&str>) -> Vec<String> {
    search_dense_scored(query, k, project_id)
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

/// Like `search_dense` but returns `(canonical_id, cosine_score)` best-first so
/// the fusion can use the REAL similarity (not just rank order) — B1. Empty when
/// E5/Qdrant is unavailable, so the caller degrades to sparse-only.
pub fn search_dense_scored(query: &str, k: u32, project_id: Option<&str>) -> Vec<(String, f32)> {
    let vector = match crate::qdrant::embed_e5(query, true) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    if vector.iter().all(|&x| x == 0.0) {
        return Vec::new(); // E5 stub / unavailable -> sparse only
    }
    let mut must = vec![serde_json::json!({ "key": "status", "match": { "value": "active" } })];
    if let Some(pid) = project_id {
        // 1.0 (recall cross-project): ademas del proyecto, admite items AMBIENTE
        // (sin project_id en el payload, ~82% del corpus) -> dejan de ser invisibles
        // desde una sesion de proyecto. La relevancia da la precision; el filtro solo
        // excluye memorias de OTRO proyecto IDENTIFICADO.
        must.push(serde_json::json!({
            "should": [
                { "key": "project_id", "match": { "value": pid } },
                { "is_empty": { "key": "project_id" } }
            ]
        }));
    }
    let filter = serde_json::json!({ "must": must });
    match crate::qdrant::search_with_vector(COLLECTION, vector, k, Some(filter)) {
        Ok(hits) => hits
            .into_iter()
            .map(|h| {
                let id = h
                    .payload
                    .get("canonical_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .unwrap_or(h.id);
                (id, h.score)
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Como `search_dense` pero DISTINGUE "infra de búsqueda no disponible" de "0
/// vecinos": `None` = E5 no embebió (Err / vector cero) o Qdrant devolvió Err →
/// NO verificable; `Some(vec)` = la consulta se ejecutó (vec vacío = sin vecinos).
/// Lo usa el detector de contradicción (1.7) para no tratar "Qdrant caído" como
/// "sin contradicción" → fail-closed end-to-end.
pub fn search_dense_checked(query: &str, k: u32, project_id: Option<&str>) -> Option<Vec<String>> {
    // Floor de VECINDAD para el juez de contradicción (2026-07-02). Sin él, un
    // top-k SIEMPRE devuelve k vecinos por lejanos que estén, y el juez LLM
    // decide sobre pares de temas sin relación — un solo falso positivo manda el
    // candidato a quarantine, así que banda A casi nunca disparaba (caso real:
    // "entrenó en otoño" marcado como conflicto de "Mantener Autumn activo").
    // 0.83 = el mismo listón empírico del gate de abstención del read-path
    // (DEFAULT_RECALL_FLOOR): por debajo, dos textos NO son "el mismo tema" y no
    // hay proposición que puedan contradecir.
    const JUDGE_NEIGHBOUR_FLOOR: f32 = 0.83;

    let vector = crate::qdrant::embed_e5(query, true).ok()?;
    if vector.iter().all(|&x| x == 0.0) {
        return None; // E5 stub / unavailable -> NO verificable
    }
    let mut must = vec![serde_json::json!({ "key": "status", "match": { "value": "active" } })];
    if let Some(pid) = project_id {
        must.push(serde_json::json!({
            "should": [
                { "key": "project_id", "match": { "value": pid } },
                { "is_empty": { "key": "project_id" } }
            ]
        }));
    }
    let filter = serde_json::json!({ "must": must });
    let hits = crate::qdrant::search_with_vector(COLLECTION, vector, k, Some(filter)).ok()?;
    Some(
        hits.into_iter()
            .filter(|h| h.score >= JUDGE_NEIGHBOUR_FLOOR)
            .map(|h| {
                h.payload
                    .get("canonical_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .unwrap_or(h.id)
            })
            .collect(),
    )
}

#[cfg(test)]
mod reconcile_tests {
    use super::diff_ids;
    use std::collections::HashSet;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn diff_reports_missing_and_orphan() {
        let sqlite = set(&["a", "b", "c"]);
        let qdrant = set(&["b", "c", "z"]);
        let (missing, orphan) = diff_ids(&sqlite, &qdrant);
        assert_eq!(missing, vec!["a".to_string()]); // active in SQLite, not indexed
        assert_eq!(orphan, vec!["z".to_string()]); // indexed, not an active item
    }

    #[test]
    fn diff_empty_when_in_sync() {
        let s = set(&["a", "b"]);
        let (missing, orphan) = diff_ids(&s, &s.clone());
        assert!(missing.is_empty() && orphan.is_empty());
    }
}
