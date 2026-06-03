// commands/memory/catalog.rs — agent/skill catalog commands (Auto-routing #7)

use crate::memory::catalog::{self, CatalogHit};

/// (Re)index ~/.claude/agents/*.md into the `ultron_catalog` Qdrant collection
/// (E5). Idempotent. Returns the counts.
#[tauri::command]
pub async fn catalog_reindex() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (indexed, errors) = catalog::index_agents()?;
        Ok(serde_json::json!({
            "indexed_agents": indexed,
            "errors": errors,
            "collection": catalog::CATALOG_COLLECTION,
        }))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Semantic catalog search — maps a prompt to the best specialist agent(s) to
/// delegate to. `entity = "agent"` filters to agents (None = any).
#[tauri::command]
pub async fn catalog_search(
    query: String,
    entity: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<CatalogHit>, String> {
    let k = limit.unwrap_or(5);
    tauri::async_runtime::spawn_blocking(move || {
        Ok(catalog::search_catalog(&query, entity.as_deref(), k))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}
