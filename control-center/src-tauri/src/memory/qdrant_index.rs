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
    // Gate healthz (2026-08-10): con Qdrant caído no se paga el embed E5 (~1s)
    // por un upsert que va a fallar igual; el caller ya cuenta el error.
    if !crate::qdrant::qdrant_healthy_cached() {
        return Err("qdrant unhealthy (healthz gate) — item not indexed".to_string());
    }
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
/// Repairing is a separate, opt-in call: see `reconcile_fix` (`reconcile --fix`,
/// with `--dry-run`), which re-embeds only the drift; `reindex_all` rebuilds the
/// whole index when that is what is wanted.
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

// ---------------------------------------------------------------------------
// Reconciliation repair (OLA B): re-embed the drift instead of rebuilding all
// ---------------------------------------------------------------------------

/// Upper bound on how many missing items `reconcile_fix` re-embeds in one run.
/// Drift above this is not a handful of swallowed write-path failures but a
/// lost or rebuilt index; there `reindex_all` (one warmup, one pass) is the
/// honest operation, and silently re-embedding thousands of items behind a
/// `--fix` flag would hide that cost.
pub const RECONCILE_FIX_MAX_MISSING: usize = 500;

/// Outcome of `reconcile_fix`. Carries the `reconcile_check` report it acted on
/// so one payload shows both the drift and the repair.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ReconcileFixReport {
    pub dry_run: bool,
    /// Missing items successfully re-embedded and upserted.
    pub reindexed: usize,
    /// Orphan points deleted from the dense index.
    pub removed_orphans: usize,
    /// Ids that no longer resolve to an ACTIVE item (deleted or deprecated
    /// between the check and the repair): nothing to index, not a failure.
    pub skipped_not_found: Vec<String>,
    /// `(id, error)` for every item that could not be repaired.
    pub failed: Vec<(String, String)>,
    pub report: ReconcileReport,
}

/// Refuse a repair whose missing set is large enough that `reindex_all` is the
/// right tool. Pure, so the policy is unit-testable without a live Qdrant.
fn check_fix_cap(missing_count: usize) -> Result<(), MemoryError> {
    if missing_count > RECONCILE_FIX_MAX_MISSING {
        return Err(MemoryError::Unsupported(format!(
            "{missing_count} missing points exceed the {RECONCILE_FIX_MAX_MISSING} cap for --fix; use `ultron-memory reindex`"
        )));
    }
    Ok(())
}

/// Repair the drift reported by `reconcile_check`: re-embed every ACTIVE item
/// with no dense point, and delete every orphan point.
///
/// Closes the gap left by `sync_index`, which indexes best-effort and swallows
/// the error: an item written while Qdrant was down or E5 cold stayed out of
/// the dense index permanently, because a full `reindex_all` was the only
/// repair available. Mutating, hence opt-in (`reconcile --fix`) and honouring
/// `--dry-run` (08-AUDIT policy: repair needs a dry-run plus a confirmation).
pub fn reconcile_fix(dry_run: bool) -> Result<ReconcileFixReport, MemoryError> {
    let report = reconcile_check()?;
    check_fix_cap(report.missing_count)?;

    if dry_run || report.in_sync {
        return Ok(ReconcileFixReport {
            dry_run,
            reindexed: 0,
            removed_orphans: 0,
            skipped_not_found: Vec::new(),
            failed: Vec::new(),
            report,
        });
    }

    // Warm up E5 once: a missing model must surface as a single clear error
    // instead of N identical per-item failures (same discipline as
    // `reindex_all`).
    if !report.missing_in_qdrant.is_empty() {
        let probe = crate::qdrant::embed_e5("warmup", false)
            .map_err(|e| MemoryError::RemoteUnavailable(format!("E5 model unavailable: {e}")))?;
        if probe.iter().all(|&x| x == 0.0) {
            return Err(MemoryError::RemoteUnavailable(
                "E5 returned a zero vector - model unavailable or `qdrant` feature off".to_string(),
            ));
        }
    }

    let mut reindexed = 0usize;
    let mut skipped_not_found: Vec<String> = Vec::new();
    let mut failed: Vec<(String, String)> = Vec::new();

    for id in &report.missing_in_qdrant {
        match MemoryService::get(id) {
            Ok(Some(item)) if matches!(item.status, Status::Active) => match index_item(&item) {
                Ok(()) => reindexed += 1,
                Err(e) => failed.push((id.clone(), e)),
            },
            Ok(_) => skipped_not_found.push(id.clone()),
            Err(e) => failed.push((id.clone(), e.to_string())),
        }
    }

    let mut removed_orphans = 0usize;
    for id in &report.orphan_in_qdrant {
        match remove_item(id) {
            Ok(()) => removed_orphans += 1,
            Err(e) => failed.push((id.clone(), e)),
        }
    }

    Ok(ReconcileFixReport {
        dry_run,
        reindexed,
        removed_orphans,
        skipped_not_found,
        failed,
        report,
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
    search_dense_scored_typed(query, k, project_id, None)
}

/// Filtro del k-NN denso. PURO para poder testearlo sin Qdrant:
/// - `status = active` siempre;
/// - `project_id`: el proyecto dado O items ambiente (sin project_id);
/// - `only_type`: restringe a UN tipo (F1.3, pasada de lecciones);
/// - `excluded`: tipos vetados por `recall_policy` (must_not).
pub(crate) fn dense_filter(
    project_id: Option<&str>,
    only_type: Option<&str>,
    excluded: &[String],
) -> serde_json::Value {
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
    if let Some(t) = only_type {
        must.push(serde_json::json!({ "key": "type", "match": { "value": t } }));
    }
    // Tipos vetados en el recall (ver memory::recall_policy): se cortan aqui, en
    // el k-NN, y no despues — si llegaran al fanout coparían sus 30-60 slots y el
    // pack saldria vacio en vez de saliendo con las memorias buenas detras.
    let mut filter = serde_json::json!({ "must": must });
    if !excluded.is_empty() {
        filter["must_not"] = serde_json::json!(excluded
            .iter()
            .map(|t| serde_json::json!({ "key": "type", "match": { "value": t } }))
            .collect::<Vec<_>>());
    }
    filter
}

/// Como [`search_dense_scored`] con un filtro opcional por tipo de memoria
/// (`only_type`): el k-NN se hace SOLO entre esos puntos, así el fanout no lo
/// ocupan otros tipos (2026-09-03: la lección con dense 0.888 caía al rango 15
/// del recall general sin reranker).
pub fn search_dense_scored_typed(
    query: &str,
    k: u32,
    project_id: Option<&str>,
    only_type: Option<&str>,
) -> Vec<(String, f32)> {
    // Fail-fast (2026-08-10): Qdrant caído → vacío SIN pagar el embed E5 ni el
    // connect; el caller degrada a sparse (audit 2026-08-09: ~9.2s/prompt para
    // inyectar contexto vacío).
    if !crate::qdrant::qdrant_healthy_cached() {
        return Vec::new();
    }
    let vector = match crate::qdrant::embed_e5(query, true) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    if vector.iter().all(|&x| x == 0.0) {
        return Vec::new(); // E5 stub / unavailable -> sparse only
    }
    let excluded = crate::memory::recall_policy::excluded_types();
    let filter = dense_filter(project_id, only_type, &excluded);
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

    // Gate healthz: infra caída → None (NO verificable, fail-closed) sin pagar
    // el embed. Mismo contrato que el Err de Qdrant más abajo.
    if !crate::qdrant::qdrant_healthy_cached() {
        return None;
    }
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

    #[test]
    fn fix_cap_allows_drift_up_to_the_limit() {
        assert!(super::check_fix_cap(0).is_ok());
        assert!(super::check_fix_cap(super::RECONCILE_FIX_MAX_MISSING).is_ok());
    }

    #[test]
    fn fix_cap_rejects_index_wide_drift_and_points_at_reindex() {
        let err = super::check_fix_cap(super::RECONCILE_FIX_MAX_MISSING + 1)
            .expect_err("drift past the cap must be refused");
        assert!(err.to_string().contains("reindex"));
    }
}

#[cfg(test)]
mod dense_filter_tests {
    use super::dense_filter;

    fn must_of(filter: &serde_json::Value) -> Vec<serde_json::Value> {
        filter["must"].as_array().cloned().unwrap_or_default()
    }

    #[test]
    fn filter_always_pins_active_status() {
        let f = dense_filter(None, None, &[]);
        let must = must_of(&f);
        assert_eq!(must.len(), 1);
        assert_eq!(must[0]["key"], "status");
        assert_eq!(must[0]["match"]["value"], "active");
        assert!(f.get("must_not").is_none());
    }

    #[test]
    fn only_type_adds_a_must_match_on_type() {
        let f = dense_filter(None, Some("lesson"), &[]);
        let must = must_of(&f);
        assert!(
            must.iter()
                .any(|c| c["key"] == "type" && c["match"]["value"] == "lesson"),
            "{f}"
        );
    }

    #[test]
    fn project_filter_admits_ambient_items_and_excluded_types_go_to_must_not() {
        let f = dense_filter(
            Some("tortunabo"),
            Some("lesson"),
            &["agent_note".to_string()],
        );
        let must = must_of(&f);
        assert_eq!(must.len(), 3, "{f}");
        let should = must[1]["should"].as_array().cloned().unwrap_or_default();
        assert!(should.iter().any(|c| c["match"]["value"] == "tortunabo"));
        assert!(should.iter().any(|c| c["is_empty"]["key"] == "project_id"));
        let must_not = f["must_not"].as_array().cloned().unwrap_or_default();
        assert_eq!(must_not.len(), 1);
        assert_eq!(must_not[0]["match"]["value"], "agent_note");
    }
}
