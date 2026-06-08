// ULTRON Control Center — Tauri commands
//
// Sub-directory layout (post-reorganisation):
//
//   batches_sub/   — .bat/.ps1 runner, OpenGL scaffolder, project detach/reattach
//   kanban_sub/    — Kanban board CRUD + archive
//   library/       — GitHub search/install, curated catalog, plugins, skills
//   memory/        — recall (per-project/global/hybrid), inbox, catalog, memory_graph (KG lógica conservada para Fase 3)
//   misc_sub/      — Root helpers, alerts, MCPs, hotkeys, external editor, slash cmds
//   notes_sub/     — Per-project notes, global notes, inbox, button prompts
//   projects/      — Project CRUD, launcher, CLAUDE.md, agent roster
//   sessions_sub/  — Claude session spawn, PTY, tabs, terminal layout, timeline
//   system_ops/    — Scheduled tasks, apps, diagnostics, event log, settings, lifecycle
//   workflows/     — Hooks, plans, rules, maintenance,
//                    workflow_runs (YAML composability + SQLite history, KIRKARDO 23 P2)
// Adding a new command:
//   1. Add the `#[tauri::command]` wrapper inside the appropriate sub-directory.
//   2. Register it via `pub mod` + `pub use …::*` in the sub-directory's mod.rs.
//   3. Reference it from `generate_handler!` in `lib.rs` using
//      `commands::<sub_dir>::<fn_name>`.

pub mod batches_sub;
pub mod kanban_sub;
pub mod library;
pub mod memory;
pub mod misc_sub;
pub mod notes_sub;
pub mod projects;
pub mod sessions_sub;
pub mod system_ops;
pub mod workflows;

// ---------------------------------------------------------------------------
// Flat re-exports — `lib.rs` references commands via the old flat paths
// (e.g. `commands::agents::list_agents`).  The re-exports below preserve
// those call sites by delegating to the new sub-directory modules.
// ---------------------------------------------------------------------------

pub use batches_sub::batches;
pub use batches_sub::detach;
pub use batches_sub::opengl_project;

pub use kanban_sub::kanban;

// `library` sub-dir module already exposed via `pub mod library` above;
// re-exporting its inner `library` sub-module would shadow the name.
pub use library::plugins_info;
pub use library::skills;

pub use memory::memory_graph;
pub use memory::recall;

pub use misc_sub::alerts;
pub use misc_sub::external_editor;
pub use misc_sub::hotkeys;
pub use misc_sub::mcps;
pub use misc_sub::misc;
// `commands_registry` was renamed `slash_commands` in the sub-dir refactor;
// expose the old name for backward compat with `lib.rs` call sites.
pub use misc_sub::slash_commands as commands_registry;

pub use notes_sub::button_prompts;
pub use notes_sub::notes;

pub use projects::agents;
// `projects` sub-dir module already exposed via `pub mod projects` above.

pub use sessions_sub::pty;
pub use sessions_sub::sessions;
pub use sessions_sub::tabs;

pub use system_ops::apps;
pub use system_ops::diagnostics_native;
pub use system_ops::event_log;
pub use system_ops::lifecycle;
pub use system_ops::settings;
pub use system_ops::system;

pub use workflows::hooks;
pub use workflows::maintenance;
pub use workflows::plans;
pub use workflows::rules;
// workflow_runs sub-module is accessed via commands::workflows::workflow_* in generate_handler!

// ---------------------------------------------------------------------------
// Shared command-level helpers
// ---------------------------------------------------------------------------

// read_jsonl_tail lived here as a duplicate of the live one in
// commands/misc_sub/mod.rs (the one actually used by alerts.rs). Removed
// 2026-06-06 — was never called from this path.
