// Settings > "Cuentas y modelos" — thin async wrappers over `crate::accounts`
// (business logic + all filesystem/process I/O lives there; see its module
// doc comment for what is and isn't read from each CLI).

use crate::accounts::AccountsReport;

/// Fast, read-only report: file reads only, no process spawned.
#[tauri::command]
pub async fn accounts_report() -> Result<AccountsReport, String> {
    tauri::async_runtime::spawn_blocking(crate::accounts::report)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}

/// "Actualizar modelos" button: re-probes codex and antigravity via their
/// CLIs (15s cap each) and refreshes the on-disk cache.
#[tauri::command]
pub async fn accounts_refresh_models() -> Result<AccountsReport, String> {
    tauri::async_runtime::spawn_blocking(crate::accounts::refresh_models)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}
