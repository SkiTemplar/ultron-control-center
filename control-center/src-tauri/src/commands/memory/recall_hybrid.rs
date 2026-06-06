// ULTRON Control Center — recall_hybrid + memory_health commands (MEMORY CORE D5)
//
// recall_hybrid: DEPRECATED — no live frontend callers (verified 2026-06-06).
//   Retained for backward-compat with any external CLI caller; internally
//   delegates to the unified recall pipeline (RRF + governance + quality ranker)
//   so it benefits from the same Pilar 1 fixes without duplicating logic.
//
// memory_health: per-store health check + embeddings_real flag.

use crate::memory::{qdrant_store::QdrantStore, sqlite_store::SqliteStore, KgStore, MemoryHit};

/// Fan-out hybrid recall — DEPRECATED wrapper kept for CLI back-compat.
///
/// Delegates to `recall_unified::recall_pack` (RRF + confidence quality ranker +
/// governance) with `project_id = None` (no project filter; vault NOT gated).
/// Returns a flat `Vec<MemoryHit>` shaped from the unified pack entries.
///
/// Prefer `recall` (recall_unified) for all new callers — it returns the richer
/// `RecallPack` with per-entry ranks, token estimates, and discard trace.
#[tauri::command]
pub async fn recall_hybrid(query: String, limit: Option<u32>) -> Result<Vec<MemoryHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Delegate to the unified pipeline: no project filter, cross_project=false.
        // project_id = None means the vault gate in assemble_pack does NOT fire
        // (gate only activates when project_id.is_some()), so vault items surface
        // as before — the caller is not inside any project context.
        let pack = crate::commands::memory::recall_unified::recall_pack(
            &query,
            limit.map(|n| n as usize).unwrap_or(20),
            None,  // project_id = None: no project filter, vault gate inactive
            false, // cross_project = false
            None,  // session_id = None: use default resolution (env → proc-<pid>)
        )?;
        // Map RecallEntry -> MemoryHit for backward-compat callers.
        Ok(pack
            .entries
            .into_iter()
            .map(|e| MemoryHit {
                id: e.canonical_id,
                text: e.summary.unwrap_or_default(),
                score: e.score,
                source: crate::memory::StoreKind::Sqlite,
                namespace: e.project_id,
            })
            .collect())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Per-store health summary + `embeddings_real` flag.
///
/// `embeddings_real` is `true` when `crate::qdrant::embed` returns a non-zero
/// vector for a known probe string (i.e. the real fastembed model is active).
#[tauri::command]
pub async fn memory_health() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let embeddings_real = probe_embeddings_real();

        let stores: Vec<(&str, Box<dyn crate::memory::MemoryStore>)> = vec![
            ("qdrant", Box::new(QdrantStore::new())),
            ("sqlite", Box::new(SqliteStore::new())),
            ("kg", Box::new(KgStore::new())),
        ];

        let mut statuses = serde_json::Map::new();
        for (name, store) in stores {
            let entry = match store.health() {
                Ok(h) => serde_json::json!({
                    "healthy": h.healthy,
                    "message": h.message,
                    "latency_ms": h.latency_ms,
                }),
                Err(e) => serde_json::json!({
                    "healthy": false,
                    "message": e.to_string(),
                    "latency_ms": null,
                }),
            };
            statuses.insert(name.to_string(), entry);
        }

        Ok(serde_json::json!({
            "stores": statuses,
            "embeddings_real": embeddings_real,
        }))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Probe whether `crate::qdrant::embed` is returning real (non-zero) vectors.
fn probe_embeddings_real() -> bool {
    match crate::qdrant::embed("ultron memory probe") {
        Ok(v) => v.iter().any(|&x| x != 0.0),
        Err(_) => false,
    }
}
