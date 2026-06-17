// kanban/mod.rs — Kanban domain.
//
// Per-project board persisted at `~/.ultron/cockpit/projects/<project_id>/kanban.json`.
// Atomic writes via tmp + rename. Loader is idempotent: unknown fields ignored,
// missing fields defaulted, so older JSONs upgrade transparently.
//
// v2.14 -- ColumnRole canonical field + Column CRUD commands.

pub(crate) mod archive;
pub(crate) mod board_io;
#[cfg(test)]
mod tests;
pub(crate) mod types_model;

pub use archive::{archive_done, list_archives, load_archive};
pub use board_io::{
    add_column, append_run, card_by_id, column_by_name, create_card, delete_card, delete_column,
    load, migrate_all_projects, move_card, rename_column, reorder_columns, save, update_card,
};
pub use types_model::{
    Card, CardPartial, CardPatch, CardRun, Column, ColumnRole, KanbanArchive, KanbanArchiveSummary,
    KanbanBoard, RunStatus,
};
