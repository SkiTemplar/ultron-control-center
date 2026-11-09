// mcps/commands.rs — Comandos Tauri nuevos de la pestaña MCPs (H14/H15).
//
// Los comandos históricos (`list_mcps`, `add_mcp`, `mcp_ping`…) siguen en
// `commands/misc_sub/mcps.rs` y llaman a los `*_inner` de este módulo.

use super::types_io::McpInfo;

/// Configuración en bruto (con `env`) de un servidor de ámbito de usuario de
/// `~/.claude.json`, para el formulario de edición.
#[tauri::command]
pub async fn mcp_get_config(name: String) -> Result<serde_json::Value, String> {
    super::mutations_gen::mcp_get_config_inner(name)
}

/// Chequeo de salud real de todos los servidores (misma unión de fuentes
/// que el listado): escribe `~/.ultron/.tmp/mcp-health.json` y devuelve el
/// listado actualizado. Lanza procesos y espera respuestas: va fuera del
/// hilo de la runtime.
#[tauri::command]
pub async fn mcp_health_check_all() -> Result<Vec<McpInfo>, String> {
    tauri::async_runtime::spawn_blocking(super::ping::mcp_health_check_all_inner)
        .await
        .map_err(|e| format!("chequeo de salud MCP interrumpido: {e}"))?
}
