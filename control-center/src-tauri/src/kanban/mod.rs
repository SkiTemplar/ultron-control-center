// kanban/mod.rs — Kanban domain.
//
// Per-project board persisted at `~/.ultron/cockpit/projects/<project_id>/kanban.json`.
// Atomic writes via tmp + rename. Loader is idempotent: unknown fields ignored,
// missing fields defaulted, so older JSONs upgrade transparently.
//
// v2.14 -- ColumnRole canonical field + Column CRUD commands.

pub(crate) mod archive;
pub(crate) mod board_io;
pub(crate) mod file_lock;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_project;
pub(crate) mod types_model;

pub use archive::{archive_done, list_archives, load_archive};
pub use board_io::{
    add_column, create_card, delete_card, delete_column, load, migrate_all_projects, move_card,
    rename_column, reorder_columns, update_card,
};
pub use types_model::{
    Card, CardPartial, CardPatch, Column, ColumnRole, KanbanArchive, KanbanArchiveSummary,
    KanbanBoard,
};
