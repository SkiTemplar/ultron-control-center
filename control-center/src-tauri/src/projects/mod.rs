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
//   ide.rs        — resolve an IDE slug to an installed launcher + spawn it
//   launch.rs     — open_project, launch_item, launch_all, open_in_ide, dispatch,
//                   project_open_app (FRENTE D)
//   discover.rs   — scan_projects_inner: altas bajo las raíces del creador
//   scan.rs       — emit-aware wrappers
//   game.rs       — «Jugar»: detecta proyectos UE/Unity y elige el ejecutable (puro)
//   game_launch.rs — «Jugar»: registro de Epic + spawn desacoplado del juego

pub(crate) mod discover;
pub(crate) mod game;
pub(crate) mod game_launch;
pub(crate) mod ide;
pub(crate) mod launch;
pub(crate) mod normalise;
pub(crate) mod read_ops;
pub(crate) mod registry;
pub(crate) mod scan;
pub(crate) mod session_log;
pub(crate) mod types;
pub(crate) mod write_ops;

#[cfg(test)]
mod game_tests;
#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Public re-exports — every symbol callers reference as `crate::projects::*`
// must appear here so external callers are unchanged.
// ---------------------------------------------------------------------------

pub use launch::{
    launch_all_items_inner, launch_item_inner, open_project_inner, project_open_app_inner,
};

pub use discover::{scan_projects_inner, ScanReport};
pub use game_launch::{project_play_game_inner, GameLaunchResult};
pub use read_ops::list_projects_inner;
pub use scan::{create_project_inner_with_emit, delete_project_inner_with_emit};
pub use types::{
    AddLauncherItemPayload, CreateProjectPayload, CreateProjectResult, DeleteProjectResult,
    ExecutableEntry, LauncherItem, ProjectActionResult, ProjectInfo, UpdateProjectPayload,
    UpdateProjectResult,
};
pub use write_ops::{
    add_launcher_item_inner, remove_launcher_item_inner, set_default_provider_inner,
    touch_project_inner, update_project_inner,
};
