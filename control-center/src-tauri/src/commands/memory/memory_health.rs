// ULTRON Control Center — memory_health command (MEMORY CORE D5)
//
// This file used to be recall_hybrid.rs. The recall_hybrid wrapper was removed
// 2026-06-28: it had no live callers (verified 2026-06-06) and only
// re-delegated to recall_unified::recall_pack, the canonical recall path.
//
// memory_health: per-store health check + embeddings_real flag. El store
//   sqlite trae en `details` el estado del FTS5 (fts_rows, item_rows,
//   integrity_ok, in_sync) y `healthy` es false si el índice diverge.
// memory_stats: contadores agregados (activas, pendientes...) para la tarjeta
//   "Sistema de memoria" del Panel; vivía en inbox.rs hasta el 2026-10-18.

use crate::memory::{
    qdrant_store::QdrantStore, sqlite_store::SqliteStore, MemoryService, MemoryStats,
};

/// Per-store health summary + `embeddings_real` flag.
///
/// `embeddings_real` is `true` when the daemon returns a non-zero E5 vector for a
/// known probe string (E5 is never loaded in the GUI process; with the dense
/// stack off or the daemon down it is `false`). See [`probe_embeddings_real`].
#[tauri::command]
pub async fn memory_health() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (embeddings_real, embeddings_probe) = probe_embeddings_real();
        tracing::debug!("memory_health: embeddings_real={embeddings_real} ({embeddings_probe})");

        let stores: Vec<(&str, Box<dyn crate::memory::MemoryStore>)> = vec![
            ("qdrant", Box::new(QdrantStore::new())),
            ("sqlite", Box::new(SqliteStore::new())),
        ];

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

        Ok(serde_json::json!({
            "stores": statuses,
            "embeddings_real": embeddings_real,
        }))
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMBED_PROBE_TEXT: &str = "ultron memory probe";

/// Probe whether the real E5 model is producing (non-zero) vectors, WITHOUT
/// loading E5 in the GUI process (CLAUDE.md, «una sola copia de los modelos»).
///
/// Antes llamaba a `crate::qdrant::embed_e5` en este proceso: con el denso
/// encendido, abrir la tarjeta de memoria del Panel cargaba ~1,5 GB en la app
/// (auditoría 2026-10-26, M4). Ahora:
///   - denso apagado (`ULTRON_DENSE=0`) → `false` sin embeber nada;
///   - denso encendido → se le pide el vector al daemon; si no contesta,
///     `false` y `daemon_unreachable`, sin caer al camino local.
fn probe_embeddings_real() -> (bool, &'static str) {
    probe_with(crate::qdrant::dense_enabled(), || {
        crate::daemon_client::remote_embed(EMBED_PROBE_TEXT)
    })
}

/// Decisión pura de la sonda: `(embeddings_real, origen)`. `remote` solo se
/// llama con el denso encendido.
fn probe_with(dense_on: bool, remote: impl FnOnce() -> Option<Vec<f32>>) -> (bool, &'static str) {
    if !dense_on {
        return (false, "dense_disabled");
    }
    match remote() {
        Some(v) => (v.iter().any(|&x| x != 0.0), "daemon"),
        None => (false, "daemon_unreachable"),
    }
}

#[cfg(test)]
mod tests {
    use super::probe_with;

    #[test]
    fn con_el_denso_apagado_no_se_pide_ningun_vector() {
        let r = probe_with(false, || panic!("no debe embeber con el denso apagado"));
        assert_eq!(r, (false, "dense_disabled"));
    }

    #[test]
    fn sin_daemon_no_hay_camino_local() {
        assert_eq!(probe_with(true, || None), (false, "daemon_unreachable"));
    }

    #[test]
    fn el_vector_del_daemon_decide() {
        assert_eq!(probe_with(true, || Some(vec![0.0, 0.3])), (true, "daemon"));
        assert_eq!(probe_with(true, || Some(vec![0.0; 4])), (false, "daemon"));
    }
}
