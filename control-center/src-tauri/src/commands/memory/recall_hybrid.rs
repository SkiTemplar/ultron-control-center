// ULTRON Control Center — memory_health command (MEMORY CORE D5)
//
// recall_hybrid (deprecated wrapper) was removed 2026-06-28 — it had no live
// callers (verified 2026-06-06) and only re-delegated to
// recall_unified::recall_pack, which is the canonical recall path. Call that
// directly.
//
// memory_health: per-store health check + embeddings_real flag.

use crate::memory::{qdrant_store::QdrantStore, sqlite_store::SqliteStore, KgStore};

/// Per-store health summary + `embeddings_real` flag.
///
/// `embeddings_real` is `true` when `crate::qdrant::embed_e5` returns a non-zero
/// vector for a known probe string (i.e. the real E5 model is active).
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

/// Probe whether `crate::qdrant::embed_e5` is returning real (non-zero) vectors.
fn probe_embeddings_real() -> bool {
    match crate::qdrant::embed_e5("ultron memory probe", true) {
        Ok(v) => v.iter().any(|&x| x != 0.0),
        Err(_) => false,
    }
}
