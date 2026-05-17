// MCP server CRUD + health-check commands.
use crate::mcps;
use tauri_plugin_shell::ShellExt;

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

#[tauri::command]
pub async fn generate_mcp_from_prompt(
    app: tauri::AppHandle,
    description: String,
) -> Result<mcps::McpGenerationResult, String> {
    mcps::generate_mcp_from_prompt_inner(&app, description).await
}

/// Run mcp_health_check.py and return the updated list of MCPs.
/// Honors the user's CLAUDE.md rule of always invoking python via `uv run`.
#[tauri::command]
pub async fn run_mcp_health_check(app: tauri::AppHandle) -> Result<Vec<mcps::McpInfo>, String> {
    let script_path = crate::ultron_root()?.join("scripts/cockpit/mcp_health_check.py");
    let script_str = script_path.to_string_lossy().to_string();

    // Use uv run python for project-managed env (per CLAUDE.md global rule).
    let output = app
        .shell()
        .command("uv")
        .args(["run", "python", &script_str, "--quiet"])
        .output()
        .await
        .map_err(|e| format!("spawn uv: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("health check failed (exit {:?}): {}", output.status.code(), stderr));
    }
    mcps::list_mcps_inner()
}
