// installed_apps/commands.rs — list, open-folder, and uninstall commands.

#[cfg(target_os = "windows")]
use std::path::Path;

use super::types::{InstalledAppsReport, UninstallResult};

// ---------------------------------------------------------------------------
// list_installed_apps_inner
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub async fn list_installed_apps_inner(
    app: &tauri::AppHandle,
    force: bool,
) -> Result<InstalledAppsReport, String> {
    use super::cache::{cache_fresh, read_cache, write_cache};
    use super::inventory::scan_apps;
    use super::ps_util::iso_now_utc;

    if !force {
        if let Some(snap) = read_cache() {
            if cache_fresh(&snap) {
                return Ok(InstalledAppsReport {
                    apps: snap.apps,
                    source_errors: Vec::new(),
                    generated_at: snap.generated_at,
                    cached: true,
                });
            }
        }
    }
    let (apps, errors) = scan_apps(app).await?;
    let _ = write_cache(&apps);
    Ok(InstalledAppsReport {
        apps,
        source_errors: errors,
        generated_at: iso_now_utc(),
        cached: false,
    })
}

/// Linux/macOS stub — returns an empty inventory so the UI doesn't crash
/// when the user launches the Apps panel on a non-Windows host. The
/// frontend already handles `apps.is_empty()` (it shows an empty-state
/// card), so no extra signalling is needed.
#[cfg(not(target_os = "windows"))]
pub async fn list_installed_apps_inner(
    _app: &tauri::AppHandle,
    _force: bool,
) -> Result<InstalledAppsReport, String> {
    use super::ps_util::iso_now_utc;

    Ok(InstalledAppsReport {
        apps: Vec::new(),
        source_errors: vec!["installed-apps inventory is Windows-only".to_string()],
        generated_at: iso_now_utc(),
        cached: false,
    })
}

// ---------------------------------------------------------------------------
// open_app_folder_inner
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub fn open_app_folder_inner(install_location: String) -> Result<String, String> {
    let trimmed = install_location.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("install_location is empty".into());
    }
    let p = Path::new(trimmed);
    if !p.exists() {
        return Err(format!("path does not exist: {}", trimmed));
    }
    if !p.is_dir() {
        return Err(format!("path is not a directory: {}", trimmed));
    }
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", trimmed, e))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    let cleaned = canonical_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&canonical_str)
        .to_string();
    let mut explorer = std::process::Command::new("explorer.exe");
    explorer.arg(&cleaned);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        explorer.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    explorer
        .spawn()
        .map_err(|e| format!("spawn explorer: {}", e))?;
    Ok(cleaned)
}

#[cfg(not(target_os = "windows"))]
pub fn open_app_folder_inner(_install_location: String) -> Result<String, String> {
    Err("open_app_folder is not supported on this platform".to_string())
}

// ---------------------------------------------------------------------------
// uninstall_app_inner
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub async fn uninstall_app_inner(
    app: &tauri::AppHandle,
    name: String,
    provider: String,
    package_id: Option<String>,
) -> Result<UninstallResult, String> {
    use super::cache::cache_path;
    use super::ps_util::{ps_single_quote_escape, run_ps_command};

    // Whitelist provider — refuse anything else outright.
    let provider_normalised = match provider.as_str() {
        "winget" | "store" | "msi" | "manual" => provider,
        other => return Err(format!("invalid provider '{}'", other)),
    };
    if name.trim().is_empty() {
        return Err("app name is empty".into());
    }
    if name.len() > 256 {
        return Err("app name is unreasonably long".into());
    }

    // Build the PS command depending on provider. We embed user data only
    // via PS single-quoted literals, with `'` doubled. No interpolation,
    // no `$()` execution.
    let name_safe = ps_single_quote_escape(&name);
    let id_safe = package_id.as_deref().map(ps_single_quote_escape);

    let command = match provider_normalised.as_str() {
        "winget" | "store" => {
            // Prefer the package id when available — it's unambiguous.
            // Both winget and store entries are uninstalled via the same
            // `winget uninstall` invocation.
            if let Some(id) = id_safe {
                format!(
                    "& winget uninstall --id '{}' --accept-source-agreements \
                     --disable-interactivity --silent",
                    id
                )
            } else {
                format!(
                    "& winget uninstall --name '{}' --accept-source-agreements \
                     --disable-interactivity --silent",
                    name_safe
                )
            }
        }
        "msi" => {
            // PackageManagement route — robust across MSIs, doesn't need
            // to know the GUID. We pipe so the user's app name never
            // becomes a flag.
            format!(
                "Get-Package -Name '{}' -ErrorAction Stop | \
                 Uninstall-Package -Force -ErrorAction Stop",
                name_safe
            )
        }
        "manual" => {
            // Manual installers — try Get-Package first (some are still
            // tracked by PackageManagement), fall back to the registry
            // QuietUninstallString if present. We never blindly exec the
            // raw uninstall_hint to avoid arbitrary cmdlines from the
            // registry; the user can still uninstall via Windows Settings.
            format!(
                "Get-Package -Name '{}' -ErrorAction Stop | \
                 Uninstall-Package -Force -ErrorAction Stop",
                name_safe
            )
        }
        _ => unreachable!("provider whitelist enforced above"),
    };

    let (stdout, stderr, code, ok) = run_ps_command(app, &command).await?;
    // Best-effort cache invalidation — the next list call should re-scan.
    let _ = std::fs::remove_file(cache_path().unwrap_or_default());
    Ok(UninstallResult {
        success: ok,
        stdout,
        stderr,
        exit_code: code,
        command,
    })
}

#[cfg(not(target_os = "windows"))]
pub async fn uninstall_app_inner(
    _app: &tauri::AppHandle,
    _name: String,
    _provider: String,
    _package_id: Option<String>,
) -> Result<UninstallResult, String> {
    Err("uninstall_app is not supported on this platform".to_string())
}
