// ULTRON Control Center — Projects module.
//
// Reads ~/.ultron/cockpit/projects.json (registry built by
// scripts/cockpit/scan_projects.py). Exposes a flat list with the fields
// the UI needs for the workspace picker + Projects tab.
//
// Module layout:
//   types.rs      — All domain types (LauncherItem, ProjectInfo, payloads...)
//   normalise.rs  — Normalisation helpers for provider, shell, and IDE fields
//   registry.rs   — Registry I/O helpers: load, atomic write, path helpers
//   read_ops.rs   — list_projects_inner, load_items_for
//   write_ops.rs  — create, update, delete, touch, launcher-item mutations
//   launch.rs     — open_project, launch_item, launch_all, open_in_ide, dispatch
//   scan.rs       — scan_projects_inner + emit-aware wrappers

pub(crate) mod launch;
pub(crate) mod normalise;
pub(crate) mod read_ops;
pub(crate) mod registry;
pub(crate) mod scan;
pub(crate) mod types;
pub(crate) mod write_ops;

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Public re-exports — every symbol callers reference as `crate::projects::*`
// must appear here so external callers are unchanged.
// ---------------------------------------------------------------------------

pub use launch::{
    launch_all_items_inner, launch_item_inner, launch_project_executable_inner, open_project_inner,
};
pub use read_ops::list_projects_inner;
pub use scan::{
    create_project_inner_with_emit, delete_project_inner_with_emit, scan_projects_inner,
};
pub use types::{
    AddLauncherItemPayload, CreateProjectPayload, CreateProjectResult, DeleteProjectResult,
    ExecutableEntry, LauncherItem, ProjectActionResult, ProjectInfo, UpdateProjectPayload,
    UpdateProjectResult,
};
pub use write_ops::{
    add_launcher_item_inner, remove_launcher_item_inner, reorder_launcher_items_inner,
    set_default_provider_inner, touch_project_inner, update_project_inner,
};
