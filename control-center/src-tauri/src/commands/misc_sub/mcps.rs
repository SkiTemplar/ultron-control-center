// MCP server CRUD + health-check commands.
use crate::mcps;

#[tauri::command]
pub async fn list_mcps() -> Result<Vec<mcps::McpInfo>, String> {
    mcps::list_mcps_inner()
}

#[tauri::command]
pub async fn add_mcp(
    name: String,
    config: serde_json::Value,
) -> Result<mcps::McpMutationResult, String> {
    mcps::add_mcp_inner(name, config)
}

#[tauri::command]
pub async fn update_mcp(
    name: String,
    config: serde_json::Value,
) -> Result<mcps::McpMutationResult, String> {
    mcps::update_mcp_inner(name, config)
}

#[tauri::command]
pub async fn delete_mcp(name: String) -> Result<mcps::McpMutationResult, String> {
    mcps::delete_mcp_inner(name)
}

// `run_mcp_health_check` (uv run python mcp_health_check.py) se quitó el
// 2026-10-23: sin consumidor; la UI usa `mcp_health_check_all` (MCPs.tsx) y la
// acción `mcp-health` de la paleta llama al mismo sondeo desde 2026-11-02.

#[tauri::command]
pub async fn mcp_ping(name: String) -> mcps::McpPingResult {
    mcps::mcp_ping_inner(name)
}

/// Enable/disable an MCP server via Claude Code's native `disabledMcpjsonServers`
/// list in settings.json. Works for project `.mcp.json` and `~/.claude.json`
/// project-scoped servers; NOT for plugin or top-level user servers.
#[tauri::command]
pub async fn mcp_set_disabled(
    name: String,
    disabled: bool,
) -> Result<mcps::McpMutationResult, String> {
    mcps::set_mcpjson_disabled_inner(name, disabled)
}

// -- Cuentas multi-token por plantilla (Settings -> MCP Accounts) ------------

#[tauri::command]
pub async fn mcp_account_templates() -> Vec<mcps::McpAccountTemplate> {
    mcps::TEMPLATES.to_vec()
}

#[tauri::command]
pub async fn mcp_accounts_list() -> Result<Vec<mcps::McpAccountRow>, String> {
    mcps::accounts_list_inner()
}

/// Alta: el token llega del formulario y aterriza en ~/.claude.json (local);
/// jamás se devuelve ni se loguea. Respuesta = (nombre_final, ruta_backup).
#[tauri::command]
pub async fn mcp_account_add(
    template_id: String,
    alias: String,
    token: String,
    read_only: bool,
) -> Result<(String, String), String> {
    mcps::account_add_inner(&template_id, &alias, &token, read_only)
}

#[tauri::command]
pub async fn mcp_account_remove(name: String) -> Result<String, String> {
    mcps::account_remove_inner(&name)
}
