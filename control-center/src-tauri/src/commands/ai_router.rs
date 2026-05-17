// AI Router config commands.
use crate::ai_router;

#[tauri::command]
pub async fn read_ai_router() -> Result<ai_router::AiRouterConfig, String> {
    ai_router::read_ai_router_inner()
}

#[tauri::command]
pub async fn save_ai_router(
    config: ai_router::AiRouterConfig,
) -> Result<ai_router::AiRouterConfig, String> {
    ai_router::save_ai_router_inner(config)
}

#[tauri::command]
pub async fn reset_ai_router_to_defaults() -> Result<ai_router::AiRouterConfig, String> {
    ai_router::reset_ai_router_to_defaults_inner()
}

/// v15.2.40 — resolve a zone for a specific prompt. Honours `auto_mode`
/// by shelling out to `embed_agents.py query` and picking the best
/// subagent. Falls back to the manual config on any failure so the
/// caller never has to handle errors specially.
#[tauri::command]
pub async fn resolve_zone_for_prompt(
    zone_key: String,
    prompt: String,
) -> Result<ai_router::ResolvedRoute, String> {
    ai_router::resolve_zone_inner(zone_key, prompt)
}
