//! Control Center 2.0 — plugin cache introspection.
//!
//! Four layers:
//!   - `read_plugin_info_inner()` — legacy single-plugin probe used by the
//!     original Settings panel; still returns ECC counts so anything that
//!     relied on it keeps working.
//!   - `list_all_plugins_inner()` — full enumeration of
//!     `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` plus the
//!     `~/.claude/plugins/installed_plugins.json` manifest. Returns a flat
//!     list with per-plugin counts and the canonical `<plugin>@<market>`
//!     coordinate so the UI can render install/update/uninstall buttons
//!     without re-implementing the cache layout.
//!   - `check_plugin_updates_inner()` (v2.6 fb-022) — for each installed
//!     plugin, asks `gh` for the marketplace repo's `pushed_at`. If that
//!     timestamp is newer than the local cache mtime, the plugin is flagged
//!     `update_available`. Returns one row per known plugin so the UI can
//!     paint badges.
//!   - `plugin_check_updates_bulk_inner()` (v2.9.5) — SHA-aware bulk update
//!     check. Reads `gitCommitSha` from `installed_plugins.json` and compares
//!     against `gh api repos/<owner>/<repo>/commits?path=<plugin-path>&per_page=1`.
//!     Falls back to timestamp comparison for plugins without a local SHA.
//!     Results are cached 1 h to `~/.ultron/cockpit/plugin-update-cache.json`.
//!   - `plugin_changelog_summary_inner()` (v2.9.5) — invokes `ai_router::route`
//!     with the recent commits log to produce a human-readable summary.
//!
//! Sub-module layout:
//!   - `types`        — public data types (`PluginInfo`, `PluginEntry`, …)
//!   - `cache`        — legacy probe, full enumeration, uninstall, fs helpers
//!   - `update_check` — v2.6 per-plugin `gh repo view` update scan
//!   - `bulk_update`  — v2.9.5 SHA-aware bulk check + AI changelog summary

mod bulk_update;
mod cache;
mod types;
mod update_check;

// Public types re-exported at the module root so callers keep working.
pub use types::{PluginBulkUpdate, PluginEntry, PluginInfo, PluginUpdateStatus};

// Public inner functions re-exported at the module root.
pub use bulk_update::{plugin_changelog_summary_inner, plugin_check_updates_bulk_inner};
pub use cache::{list_all_plugins_inner, read_plugin_info_inner, uninstall_plugin_cache_inner};
pub use update_check::check_plugin_updates_inner;
