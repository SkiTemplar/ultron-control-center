// kanban/types_model.rs — types, structs, enums, and write lock.

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

/// Process-wide write lock for kanban RMW operations.
/// Covers `append_run` and `archive_done` — the two load->mutate->save paths.
/// Pure reads (`load`, `list_archives`, `load_archive`) are excluded.
pub(super) static KANBAN_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) fn kanban_lock() -> &'static Mutex<()> {
    KANBAN_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(tag = "kind", content = "value")]
pub enum RunStatus {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "killed")]
    Killed,
    #[serde(rename = "failed")]
    Failed,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CardRun {
    pub session_id: String,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    pub status: RunStatus,
    #[serde(default)]
    pub exit_code: Option<i32>,
}

/// Deserialize a card timestamp that may arrive as a string (the canonical
/// `"epoch:<secs>"` form the app writes) or as a bare number. External capture
/// scripts have occasionally written `Date.now()` millis as a plain integer;
/// with a strict `String` field that single bad card made serde reject the
/// *entire* board (`invalid type: integer, expected a string`), so `kanban_load`
/// erred and the project card silently showed "--" for its pending counter.
/// Coercing a number to `"epoch:<secs>"` keeps one malformed card from breaking
/// the board -- same defensive stance as the signed `order` field below.
pub(super) fn de_flexible_timestamp<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrNum {
        S(String),
        I(i64),
        F(f64),
    }
    // The repo stores epoch *seconds* (see `now_iso`); coerce millis down.
    let to_secs = |n: i64| if n >= 1_000_000_000_000 { n / 1000 } else { n };
    Ok(match StringOrNum::deserialize(deserializer)? {
        StringOrNum::S(s) => s,
        StringOrNum::I(n) => format!("epoch:{}", to_secs(n)),
        StringOrNum::F(f) => format!("epoch:{}", to_secs(f as i64)),
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Card {
    pub id: String,
    pub column_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub prompt_template: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Relative sort index within its column. Signed (`i32`) on purpose: legacy
    /// seed scripts sometimes wrote negative orders to force a card to the top,
    /// and a `u32` field made serde reject the *entire* board on a single
    /// negative value ("invalid value: integer -2, expected u32"). `load()`
    /// normalises orders to a gap-free, duplicate-free `0..n` per column.
    #[serde(default)]
    pub order: i32,
    #[serde(default, deserialize_with = "de_flexible_timestamp")]
    pub created_at: String,
    #[serde(default, deserialize_with = "de_flexible_timestamp")]
    pub updated_at: String,
    #[serde(default)]
    pub runs: Vec<CardRun>,
}

/// Canonical role for a Kanban column.
///
/// Decouples business logic (auto-dispatch, archive, counters) from the
/// visible name so that renaming a column never breaks automation.
///
/// Serialised as snake_case lowercase strings (`"todo"`, `"doing"`, ...).
/// When a board is loaded from JSON that predates this field the missing field
/// defaults to `Other` (via `#[serde(default)]` on `Column::role`), and
/// [`infer_and_migrate_roles`](super::board_io::infer_and_migrate_roles) upgrades it in place during `load()`.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ColumnRole {
    /// Work not yet started (Backlog, Todo, Pending, Investigar, ...).
    Todo,
    /// Work actively in progress (In Progress, Doing, WIP, En Curso, ...).
    Doing,
    /// Work blocked (Blocked, Bloqueado, ...).
    Blocked,
    /// Work finished (Done, Complete, Archive, ...).
    Done,
    /// Any other user-defined role -- treated as a generic lane.
    #[default]
    Other,
}

impl ColumnRole {
    /// Infer role from column name using case-insensitive substring matching.
    ///
    /// Returns `None` when no heuristic matches (caller keeps `Other`).
    pub fn infer_from_name(name: &str) -> Option<Self> {
        let lower = name.to_ascii_lowercase();
        if lower.contains("done")
            || lower.contains("complete")
            || lower.contains("archiv")
            || lower.contains("finish")
        {
            Some(Self::Done)
        } else if lower.contains("progress")
            || lower.contains("doing")
            || lower.contains("wip")
            || lower.contains("curso")
            || lower.contains("haciendo")
        {
            Some(Self::Doing)
        } else if lower.contains("block")
            || lower.contains("bloque")
            || lower.contains("impediment")
        {
            Some(Self::Blocked)
        } else if lower.contains("backlog")
            || lower.contains("todo")
            || lower.contains("to do")
            || lower.contains("pending")
            || lower.contains("pendiente")
            || lower.contains("investigar")
            || lower.contains("investig")
            || lower.contains("queue")
            || lower.contains("new")
        {
            Some(Self::Todo)
        } else {
            None
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Column {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: i32,
    /// Canonical role -- drives automation instead of name-based matching.
    /// Defaults to `Other` on old boards so deserialisation never fails.
    #[serde(default)]
    pub role: ColumnRole,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KanbanBoard {
    pub project_id: String,
    pub columns: Vec<Column>,
    pub cards: Vec<Card>,
    #[serde(default)]
    pub default_agent: Option<String>,
    #[serde(default)]
    pub default_prompt_template: Option<String>,
    #[serde(default = "default_schema")]
    pub schema_version: u32,
}

pub(super) fn default_schema() -> u32 {
    SCHEMA_VERSION
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CardPartial {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub prompt_template: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

// ---------------------------------------------------------------------------
// Archive types
// ---------------------------------------------------------------------------

/// A single card snapshot inside an archive. We flatten the source column name
/// into the entry so the read-only viewer can show it without cross-referencing
/// the live board (which may have renamed/deleted the column since).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ArchivedCard {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub column_name: String,
    pub archived_from_column_id: String,
}

/// Full payload -- used by `kanban_load_archive` for the viewer modal.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KanbanArchive {
    pub name: String,
    pub archived_at: String,
    pub cards: Vec<ArchivedCard>,
}

/// Slim summary -- used by `kanban_list_archives` for the box-grid. Skips the
/// full `cards` payload so the grid renders fast even with many archives.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KanbanArchiveSummary {
    pub name: String,
    pub archived_at: String,
    pub card_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct CardPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub agent: Option<Option<String>>,
    #[serde(default)]
    pub prompt_template: Option<Option<String>>,
    #[serde(default)]
    pub cwd: Option<Option<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}
