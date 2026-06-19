// installed_apps/mod.rs — Installed Apps module.
//
// Inventory all software installed on this Windows host and expose two
// safe mutations: open the install folder in Explorer, and uninstall via
// the appropriate package manager.
//
// Sources merged:
//   - winget list (modern packages, includes Microsoft Store + WingetCli)
//   - Get-Package (PackageManagement / MSI / PowerShellGet)
// Each app is tagged with a `provider` ∈ {winget, msi, store, manual} so
// the UI can filter and the uninstall dispatcher picks the correct
// invocation.
//
// Cache: results are cached at ~/.ultron/.tmp/installed-apps.json with a
// 1-hour TTL. The frontend can pass `force=true` to bypass the cache.
//
// Security:
//   - The `name` field is allowed any UTF-8, but for uninstall we only
//     route through fixed argv forms (`winget uninstall --id <id>`,
//     `Get-Package -Name <name> | Uninstall-Package`). The name is sent
//     as a separate PowerShell argument (single-quoted, escaped) so a
//     malicious app name cannot inject extra flags.
//   - `provider` must be in the whitelist before uninstall is invoked.
//   - `install_location` for the "open folder" command is canonicalised
//     and must resolve under an existing directory before we hand it to
//     explorer.exe.
//
// Sub-modules:
//   bloatware  — Appx/bloatware query and Remove-AppxPackage commands
//   cache      — disk cache with 1-hour TTL
//   commands   — list, open-folder, and standard-uninstall inner fns
//   inventory  — PowerShell inventory script + scan_apps
//   ps_util    — PowerShell runner, BOM-aware decoder, PS escaping, ISO date
//   tests      — unit tests
//   types      — public data types (InstalledApp, InstalledAppsReport, …)

pub(super) mod bloatware;
pub(super) mod cache;
pub(super) mod commands;
pub(super) mod inventory;
pub(super) mod ps_util;
#[cfg(test)]
mod tests;
pub(super) mod types;

pub use commands::{list_installed_apps_inner, open_app_folder_inner, uninstall_app_inner};
pub use types::{InstalledAppsReport, UninstallResult};
