// ULTRON Control Center — memory_health command (MEMORY CORE D5)
//
// This file used to be recall_hybrid.rs. The recall_hybrid wrapper was removed
// 2026-06-28: it had no live callers (verified 2026-06-06) and only
// re-delegated to recall_unified::recall_pack, the canonical recall path.
//
// memory_health: health del store. El store sqlite trae en `details` el estado
//   del FTS5 (fts_rows, item_rows, integrity_ok, in_sync) y `healthy` es false
//   si el índice diverge. Desde el 2026-11-14 es el único store: el índice
//   denso y la sonda `embeddings_real` se retiraron con la ruta densa.
// memory_stats: contadores agregados (activas, pendientes...) para la tarjeta
//   "Sistema de memoria" del Panel; vivía en inbox.rs hasta el 2026-10-18.

use crate::memory::{sqlite_store::SqliteStore, MemoryService, MemoryStats};

/// Per-store health summary (`{ stores: { sqlite: {...} } }`).
#[tauri::command]
pub async fn memory_health() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let stores: Vec<(&str, Box<dyn crate::memory::MemoryStore>)> =
            vec![("sqlite", Box::new(SqliteStore::new()))];

        let mut statuses = serde_json::Map::new();
        for (name, store) in stores {
            let entry = match store.health() {
                Ok(h) => serde_json::json!({
                    "healthy": h.healthy,
                    "message": h.message,
                    "latency_ms": h.latency_ms,
                    "details": h.details,
                }),
                Err(e) => serde_json::json!({
                    "healthy": false,
                    "message": e.to_string(),
                    "latency_ms": null,
                }),
            };
            statuses.insert(name.to_string(), entry);
        }

        Ok(serde_json::json!({ "stores": statuses }))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Aggregate health counts (active/pending/rejected/deprecated/stale + candidates).
#[tauri::command]
pub async fn memory_stats() -> Result<MemoryStats, String> {
    tauri::async_runtime::spawn_blocking(|| MemoryService::stats().map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}
