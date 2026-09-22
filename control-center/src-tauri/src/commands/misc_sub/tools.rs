// Settings > "Herramientas" — thin async wrapper over `crate::tools`
// (business logic + all process I/O lives there; see its module doc comment).

use crate::tools::ToolsReport;

/// Sondea las CLIs del catalogo (`--version` con timeout corto por binario,
/// `spawn_blocking` para no bloquear el runtime async).
#[tauri::command]
pub async fn tools_status() -> Result<ToolsReport, String> {
    tauri::async_runtime::spawn_blocking(crate::tools::status)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}
