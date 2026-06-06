// Settings.json / backup root / autostart commands.
use crate::{backup_status, env_keys, settings};
use std::collections::HashMap;

#[tauri::command]
pub async fn settings_read() -> Result<settings::SettingsSnapshot, String> {
    settings::settings_read_inner()
}

#[tauri::command]
pub async fn settings_save(
    content: serde_json::Value,
) -> Result<settings::SettingsSaveResult, String> {
    settings::settings_save_inner(settings::SettingsSavePayload { content })
}

#[tauri::command]
pub async fn purge_legacy_autostart() -> Result<settings::AutostartPurgeResult, String> {
    settings::purge_legacy_autostart_inner()
}

#[tauri::command]
pub async fn get_backup_root() -> Result<backup_status::BackupRootInfo, String> {
    backup_status::get_backup_root_inner()
}

#[tauri::command]
pub async fn set_backup_root(path: String) -> Result<backup_status::BackupRootInfo, String> {
    backup_status::set_backup_root_inner(backup_status::SetBackupRootPayload { path })
}

#[tauri::command]
pub async fn backup_status() -> Result<backup_status::BackupStatusReport, String> {
    backup_status::backup_status_inner()
}

#[tauri::command]
pub async fn get_backup_sources() -> Result<backup_status::BackupSourcesInfo, String> {
    backup_status::get_backup_sources_inner()
}

#[tauri::command]
pub async fn set_backup_sources(
    sources: Vec<String>,
) -> Result<backup_status::BackupSourcesInfo, String> {
    backup_status::set_backup_sources_inner(backup_status::SetBackupSourcesPayload { sources })
}

#[tauri::command]
pub async fn get_backup_schedule() -> Result<backup_status::BackupScheduleInfo, String> {
    backup_status::get_backup_schedule_inner()
}

#[tauri::command]
pub async fn set_backup_schedule(
    day: String,
    time: String,
) -> Result<backup_status::BackupScheduleInfo, String> {
    backup_status::set_backup_schedule_inner(backup_status::SetBackupSchedulePayload { day, time })
}

/// Persiste API keys de proveedores IA como variables de entorno de usuario
/// Windows via `setx`. Sólo acepta los nombres de variable de la whitelist
/// interna (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.). Valores vacíos se
/// omiten. El cambio surte efecto en sesiones nuevas; la sesión actual NO
/// lo recibe — el frontend debe notificar al usuario que reinicie.
#[tauri::command]
pub async fn set_env_vars_keys(
    keys: HashMap<String, String>,
) -> Result<env_keys::EnvKeysSaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || env_keys::set_env_vars_keys_inner(keys))
        .await
        .map_err(|e| e.to_string())?
}

/// Devuelve el estado de las API keys conocidas (cuáles están configuradas y
/// una vista enmascarada), para que Settings > API Keys muestre lo que el
/// usuario ya tiene puesto sin volver a pedirlo ni exponer el valor.
#[tauri::command]
pub async fn get_env_keys_status() -> Result<Vec<env_keys::EnvKeyStatus>, String> {
    tauri::async_runtime::spawn_blocking(env_keys::get_env_keys_status_inner)
        .await
        .map_err(|e| e.to_string())?
}

/// Persiste un nuevo GitHub token en `~/.ultron/.env` (línea GITHUB_TOKEN=<token>).
/// Usa el patrón dotenvy: el archivo .env es la fuente de verdad; la variable
/// también se aplica al proceso actual para que surta efecto sin reiniciar.
///
/// Seguridad:
///   - El token NUNCA se logea. Se valida que no esté vacío y que empiece
///     con "ghp_", "gho_", "github_pat_" o "ghs_" (prefijos oficiales GitHub).
///   - Sólo escribe la clave GITHUB_TOKEN — nada más.
///   - La escritura es atómica: tmp + rename para no dejar el .env truncado.
#[tauri::command]
pub async fn set_github_token(token: String) -> Result<env_keys::GithubTokenResult, String> {
    tauri::async_runtime::spawn_blocking(move || env_keys::set_github_token_inner(token))
        .await
        .map_err(|e| e.to_string())?
}
