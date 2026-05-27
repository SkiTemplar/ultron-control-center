// Plugin cache introspection handlers.
use crate::plugins_info as pi;

#[tauri::command]
pub fn read_plugin_info() -> Result<pi::PluginInfo, String> {
    pi::read_plugin_info_inner()
}

#[tauri::command]
pub fn list_all_plugins() -> Result<Vec<pi::PluginEntry>, String> {
    pi::list_all_plugins_inner()
}

#[tauri::command]
pub fn uninstall_plugin_cache(name: String, marketplace: String) -> Result<(), String> {
    pi::uninstall_plugin_cache_inner(&name, &marketplace)
}

#[tauri::command]
pub async fn check_plugin_updates() -> Result<Vec<pi::PluginUpdateStatus>, String> {
    // Runs `gh repo view` per plugin which is I/O-bound. We push it to a
    // blocking thread so the Tauri main loop stays responsive while users
    // wait for the spinner. Uses tauri's runtime helper (the rest of the
    // codebase consistently goes through `tauri::async_runtime`).
    tauri::async_runtime::spawn_blocking(pi::check_plugin_updates_inner)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

// ---------------------------------------------------------------------------
// v2.9.5 — SHA-aware bulk update check + AI changelog summary
// ---------------------------------------------------------------------------

/// SHA-aware bulk update check. Pass `force = true` to bypass the 1-hour
/// on-disk cache and re-fetch from GitHub immediately.
///
/// For each installed plugin the command:
///   1. Looks up the marketplace's upstream `owner/repo` in
///      `known_marketplaces.json` (falling back to `marketplaces.json`).
///   2. Derives the plugin sub-path inside the repo (e.g.
///      `plugins/code-review` for `claude-plugins-official`; empty for
///      whole-repo plugins like ECC or superpowers).
///   3. Calls `gh api repos/<owner>/<repo>/commits?path=<subpath>&per_page=1`
///      to get the HEAD SHA + commit message.
///   4. Compares against the `gitCommitSha` stored in
///      `installed_plugins.json`.  Plugins without a local SHA fall back to
///      ISO-timestamp comparison.
/// Results are cached to `~/.ultron/cockpit/plugin-update-cache.json` for
/// 1 hour to avoid hammering the GitHub API on every panel open.
#[tauri::command]
pub async fn plugin_check_updates_bulk(
    force: bool,
) -> Result<Vec<pi::PluginBulkUpdate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pi::plugin_check_updates_bulk_inner(force)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// AI-powered changelog summary for a single plugin.
///
/// Fetches the last ~15 commits from the plugin's upstream path and asks
/// `ai_router::route("light", …)` (Haiku / Gemini Flash / etc., depending on
/// the user's routing config) to produce 3-5 bullet points. Degrades
/// gracefully to a raw numbered commit list when the AI router is not
/// configured or returns an error.
#[tauri::command]
pub async fn plugin_changelog_summary(
    coordinate: String,
    installed_sha: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pi::plugin_changelog_summary_inner(
            &coordinate,
            installed_sha.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}
