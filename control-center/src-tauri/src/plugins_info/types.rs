// plugins_info/types.rs — public data types shared across sub-modules.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub root: Option<String>,
    pub last_update_iso: Option<String>,
    pub skills_count: usize,
    pub agents_count: usize,
    pub hooks_count: usize,
    pub mcp_servers_count: usize,
}

/// Single row for the Plugins panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginEntry {
    /// Plugin slug (e.g. "ecc", "superpowers", "code-review").
    pub name: String,
    /// Marketplace slug (e.g. "ecc", "superpowers-marketplace",
    /// "claude-plugins-official").
    pub marketplace: String,
    /// Canonical "<name>@<marketplace>" coordinate used by `/plugin install`.
    pub coordinate: String,
    /// Version dir name (e.g. "2.0.0-rc.1", "1.0.0", "unknown").
    pub version: String,
    /// Absolute path to the version directory.
    pub root: String,
    /// True when installed_plugins.json mentions this plugin (the cache dir
    /// may exist without an active install if the user ran /plugin uninstall
    /// but Claude Code hasn't pruned the bytes yet).
    pub installed: bool,
    /// ISO of the version dir's mtime — the closest thing to "last updated".
    pub last_update_iso: Option<String>,
    pub skills_count: usize,
    pub agents_count: usize,
    pub hooks_count: usize,
    pub mcp_servers_count: usize,
}

/// Result of a single plugin update probe. The UI uses
/// `update_available` to draw a badge and `remote_pushed_iso` to display
/// the upstream "last updated" stamp next to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginUpdateStatus {
    pub name: String,
    pub marketplace: String,
    pub coordinate: String,
    /// Local cache mtime (ISO 8601) — same value as `PluginEntry.last_update_iso`.
    pub local_iso: Option<String>,
    /// Remote `pushed_at` reported by `gh repo view --json pushedAt`.
    pub remote_pushed_iso: Option<String>,
    /// True when the marketplace repo was pushed after the local cache.
    pub update_available: bool,
    /// Optional error string (gh failed, marketplace not resolvable, etc.).
    /// When set, `update_available` is false and the row is treated as
    /// "unknown" by the UI.
    pub error: Option<String>,
}

/// Rich per-plugin update record returned by the new bulk check command.
/// Supersedes `PluginUpdateStatus` for new UI code; old command is kept for
/// backwards compatibility with any caller that already depends on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginBulkUpdate {
    /// `<name>@<marketplace>` coordinate.
    pub coordinate: String,
    pub name: String,
    pub marketplace: String,
    /// Git SHA stored in `installed_plugins.json` (may be absent for old installs).
    pub installed_sha: Option<String>,
    /// HEAD SHA of the plugin's path in the upstream marketplace repo.
    pub latest_sha: Option<String>,
    /// True when `latest_sha` differs from `installed_sha` (or when the
    /// remote commit date is newer than `lastUpdated` for plugins without SHAs).
    pub update_available: bool,
    /// Subject line of the latest remote commit (empty when unavailable).
    pub latest_commit_msg: String,
    /// When the upstream commit was authored (ISO 8601, may be empty).
    pub latest_commit_date: String,
    /// ISO 8601 timestamp of when this record was last fetched from GitHub.
    pub last_check: String,
    /// Non-fatal diagnostic; the row is still returned but `update_available`
    /// is conservatively false when this is set.
    pub error: Option<String>,
}
