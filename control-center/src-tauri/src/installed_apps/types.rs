// installed_apps/types.rs — public data types for the installed-apps domain.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstalledApp {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    /// Absolute path to install dir. Best-effort: not all sources expose
    /// this. Empty string when unknown.
    #[serde(default)]
    pub install_location: Option<String>,
    /// One of: "winget" | "msi" | "store" | "manual".
    pub provider: String,
    /// winget package id (when provider == "winget" or "store"). Used as
    /// the canonical handle for the uninstall command — much more robust
    /// than the display name.
    #[serde(default)]
    pub package_id: Option<String>,
    /// Raw uninstall string from the registry (HKLM Uninstall key). When
    /// present and provider == "msi" or "manual", the UI may prefer this
    /// over the generic Get-Package path. Not exposed to the dispatcher
    /// directly — the dispatcher always re-derives the command from
    /// provider + package_id / name for safety.
    #[serde(default)]
    pub uninstall_hint: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct InstalledAppsReport {
    pub apps: Vec<InstalledApp>,
    pub source_errors: Vec<String>,
    /// ISO timestamp of when this snapshot was produced (from cache or
    /// freshly scanned).
    pub generated_at: String,
    pub cached: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct UninstallResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub command: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct AppxQueryResult {
    /// True when at least one Appx package matched the pattern. The UI uses
    /// this to switch the row state between "Installed" and "Not present".
    pub installed: bool,
    /// Resolved package full names that matched, useful for diagnostics.
    /// Empty when `installed` is false.
    pub matches: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BloatwareUninstallResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub command: String,
    /// Best-effort package full names we attempted to remove. Empty when
    /// the pattern matched nothing on this host.
    pub removed: Vec<String>,
}
