// commands/memory/catalog.rs — agent/skill catalog commands (Auto-routing #7)

use crate::memory::catalog::{self, CatalogHit};

/// (Re)index BOTH `~/.claude/agents/*.md` and the enabled skills (global +
/// project + plugin) into the `ultron_catalog` Qdrant collection (E5).
/// Idempotent — each entity upserts under a namespaced id (`agent::` vs
/// `skill::`) so re-running refreshes in place. With agents + skills in one
/// collection, the orchestrator can route a prompt to whichever specialist
/// (agent OR skill) fits best. Returns per-entity counts.
#[tauri::command]
pub async fn catalog_reindex() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (indexed_agents, agent_errors) = catalog::index_agents()?;
        // Skills are additive: a skill-indexing failure must not discard the
        // agent counts already committed above, so surface it as a field rather
        // than aborting the whole reindex.
        let (indexed_skills, skill_errors, skill_error) = match catalog::index_skills() {
            Ok((n, e)) => (n, e, None),
            Err(e) => (0usize, 0usize, Some(e)),
        };
        Ok(serde_json::json!({
            "indexed_agents": indexed_agents,
            "indexed_skills": indexed_skills,
            "errors": agent_errors + skill_errors,
            "skill_error": skill_error,
            "collection": catalog::CATALOG_COLLECTION,
        }))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// (Re)index ONLY the skills into `ultron_catalog` (leaves agent points
/// untouched). Useful after creating/editing a skill without paying the full
/// agent re-embed cost. Idempotent. Returns the skill counts.
#[tauri::command]
pub async fn catalog_reindex_skills() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (indexed, errors) = catalog::index_skills()?;
        Ok(serde_json::json!({
            "indexed_skills": indexed,
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
