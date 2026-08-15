// projects/types.rs — Domain types for the Projects module.

use serde::{Deserialize, Serialize};

/// One thing to launch as part of a project. `kind` discriminates the
/// payload:
///   - "exe"    -> `path` (absolute), optional `args[]`. Spawned with
///     Start-Process so the parent doesn't wait.
///   - "folder" -> `path` (absolute directory). Revealed in Explorer.
///   - "claude" -> `cwd` (absolute directory). Forwarded to
///     `sessions::spawn_session_inner`.
///   - "codex"  -> `cwd` (absolute directory). Same as claude but for codex.
///
/// `label` is optional UI text; when absent the UI derives one from the path.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LauncherItem {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// v15.4.11 — only meaningful when `kind == "session"`. One of
    /// "claude" / "codex". Lets the UI consolidate the legacy kinds behind a
    /// single "Sesion AI" entry with a provider sub-selector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProjectInfo {
    pub id: String,
    pub name: Option<String>,
    pub path: Option<String>,
    pub ide: Option<String>,
    pub language: Option<String>,
    pub type_: Option<String>,
    pub status: Option<String>,
    pub last_active: Option<String>,
    pub tags: Vec<String>,
    /// Per-project launcher items. When the registry entry omits an
    /// `items[]` array AND has a `path`, the loader synthesises a default
    /// `[folder(path), claude(path)]` pair at read time so old-style entries
    /// keep working without an on-disk migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<LauncherItem>>,
    /// Preferred session provider when the user hits the project's "main
    /// launch" path: one of "claude" | "codex". The frontend uses it to mark
    /// the corresponding chip as the default. Old registries without the field
    /// default to "claude" at read time — see `list_projects_inner`. The
    /// launch dispatch is provider-agnostic; this field is pure metadata.
    pub default_provider: Option<String>,
    /// fb-016 — preferred default shell for new terminals spawned inside
    /// this project's workspace. One of "powershell" | "powershell-admin" |
    /// "cmd" | "bash". `None` falls back to the global default. Pure
    /// metadata — the PTY layer reads it when it spawns a non-AI terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_shell: Option<String>,
    /// fb-016 — override the cwd terminals open in. When set (and a real
    /// directory on disk) terminals start here instead of `path`. Use case:
    /// the project lives at `repo/` but most work happens in `repo/app/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_folder_override: Option<String>,
    /// fb-016 — free-form notes about the project. Distinct from the Notes
    /// tab (which manages standalone notes). This is a single textarea the
    /// user sees in the project edit modal — useful for stack reminders,
    /// gotchas, todos that don't deserve a kanban card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// v2.6.2 — Quick Launch executables surfaced on the project home. Each
    /// entry pairs a display name with an .exe / .lnk / .bat / .cmd path
    /// that `launch_project_executable` can spawn directly. Distinct from
    /// `items[]` (the Projects-tab launcher chips): this list is intentionally
    /// kept thin so the Project home can show big buttons without forcing the
    /// user to use the chip wizard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executables: Option<Vec<ExecutableEntry>>,
    /// v2.7.2 — accent colour for the project, `#rrggbb` lowercase. Two
    /// consumers: the Projects UI tints the card with it, and
    /// `spawn_session_inner` derives a per-project Claude Code custom theme
    /// from it (`~/.claude/themes/ultron-proj-<id>.json`) so the terminal
    /// session carries the same identity. `None` = neutral card + whatever
    /// theme the user has globally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// v2.6.2 — single Quick Launch executable. `name` is the user-facing label;
/// `path` must point at a .exe / .lnk / .bat / .cmd that
/// `launch_project_executable` can spawn. `args` / `icon` are reserved for
/// future expansion; serde keeps them optional so older registries round-trip
/// without rewriting.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExecutableEntry {
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// Internal registry deserialization types — private to this crate.
#[derive(Debug, Deserialize)]
pub(crate) struct ProjectsRoot {
    #[serde(default)]
    pub(crate) projects: Vec<RegEntry>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RegEntry {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) ide: Option<String>,
    #[serde(default)]
    pub(crate) language: Option<String>,
    #[serde(default, rename = "type")]
    pub(crate) type_: Option<String>,
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default)]
    pub(crate) last_active: Option<String>,
    #[serde(default)]
    pub(crate) tags: Vec<String>,
    #[serde(default)]
    pub(crate) items: Option<Vec<LauncherItem>>,
    #[serde(default)]
    pub(crate) default_provider: Option<String>,
    #[serde(default)]
    pub(crate) default_shell: Option<String>,
    #[serde(default)]
    pub(crate) parent_folder_override: Option<String>,
    #[serde(default)]
    pub(crate) notes: Option<String>,
    #[serde(default)]
    pub(crate) executables: Option<Vec<ExecutableEntry>>,
    #[serde(default)]
    pub(crate) color: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProjectActionResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectPayload {
    pub name: String,
    pub path: String,
    pub ide: Option<String>,
    pub language: Option<String>,
    pub tags: Option<Vec<String>>,
    /// One of "claude" | "codex". Anything else (or absent) is normalised to
    /// "claude" before being written to projects.json.
    pub default_provider: Option<String>,
    /// fb-016 — preferred shell for non-AI terminals (optional).
    pub default_shell: Option<String>,
    /// fb-016 — override the cwd that terminals open in (optional).
    pub parent_folder_override: Option<String>,
    /// fb-016 — free-form notes (optional).
    pub notes: Option<String>,
    /// v2.7.2 — accent colour `#rrggbb` (optional). Invalid values are
    /// dropped by `normalise_color` instead of failing the create.
    pub color: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CreateProjectResult {
    pub success: bool,
    pub id: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProjectPayload {
    pub id: String,
    pub name: Option<String>,
    pub path: Option<String>,
    pub ide: Option<String>,
    pub language: Option<String>,
    pub tags: Option<Vec<String>>,
    /// Optional update for the project's default provider. None = leave the
    /// existing value untouched (consistent with the rest of the patch
    /// fields). Any non-`claude/codex` value collapses to "claude".
    pub default_provider: Option<String>,
    /// fb-016 — patch the default shell. Empty string clears the field
    /// (loader will read it back as None). Unknown values collapse to None
    /// at write time so the registry stays clean.
    pub default_shell: Option<String>,
    /// fb-016 — patch the parent_folder_override. Empty string clears.
    pub parent_folder_override: Option<String>,
    /// fb-016 — patch the free-form notes. Empty string clears.
    pub notes: Option<String>,
    /// v2.6.2 — patch the Quick Launch executables list. Some(empty vec)
    /// clears the list; None leaves it alone (consistent with the rest of
    /// the patch fields). Entries with an empty name or path are dropped
    /// before persistence.
    pub executables: Option<Vec<ExecutableEntry>>,
    /// v2.7.2 — patch the accent colour. Empty string clears it (card goes
    /// back to neutral and the session stops forcing a theme); an invalid
    /// hex is ignored so a typo can't wipe a good value.
    pub color: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct UpdateProjectResult {
    pub success: bool,
    pub id: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DeleteProjectResult {
    pub success: bool,
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub struct AddLauncherItemPayload {
    pub project_id: String,
    pub item: LauncherItem,
}
