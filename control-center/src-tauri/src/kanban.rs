// ULTRON Control Center 2.0 — Kanban domain
//
// Per-project board persisted at `~/.ultron/cockpit/projects/<project_id>/kanban.json`.
// Atomic writes via tmp + rename. Loader is idempotent: unknown fields ignored,
// missing fields defaulted, so older JSONs upgrade transparently.
//
// v2.14 — ColumnRole canonical field + Column CRUD commands.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Process-wide write lock for kanban RMW operations.
/// Covers `append_run` and `archive_done` — the two load→mutate→save paths.
/// Pure reads (`load`, `list_archives`, `load_archive`) are excluded.
static KANBAN_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn kanban_lock() -> &'static Mutex<()> {
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
    #[serde(default)]
    pub order: u32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub runs: Vec<CardRun>,
}

/// Canonical role for a Kanban column.
///
/// Decouples business logic (auto-dispatch, archive, counters) from the
/// visible name so that renaming a column never breaks automation.
///
/// Serialised as snake_case lowercase strings (`"todo"`, `"doing"`, …).
/// When a board is loaded from JSON that predates this field the missing field
/// defaults to `Other` (via `#[serde(default)]` on `Column::role`), and
/// [`infer_and_migrate_roles`] upgrades it in place during `load()`.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ColumnRole {
    /// Work not yet started (Backlog, Todo, Pending, Investigar, …).
    Todo,
    /// Work actively in progress (In Progress, Doing, WIP, En Curso, …).
    Doing,
    /// Work blocked (Blocked, Bloqueado, …).
    Blocked,
    /// Work finished (Done, Complete, Archive, …).
    Done,
    /// Any other user-defined role — treated as a generic lane.
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
    pub order: u32,
    /// Canonical role — drives automation instead of name-based matching.
    /// Defaults to `Other` on old boards so deserialisation never fails.
    #[serde(default)]
    pub role: ColumnRole,
}

/// Returns `true` when the column acts as a "Done" lane, regardless of how it
/// is named. Prefers the canonical `role` field; falls back to name-based
/// heuristics for boards that have not yet been migrated.
pub fn is_done_column(col: &Column) -> bool {
    match col.role {
        ColumnRole::Done => true,
        ColumnRole::Other => {
            let n = col.name.to_ascii_lowercase();
            n.contains("done") || n.contains("complete")
        }
        _ => false,
    }
}

/// Inspect every column in `board` and, for those whose role is still `Other`,
/// attempt to infer the role from the column name.
///
/// Returns `true` when at least one column was upgraded (caller should persist).
/// Safe to call repeatedly — already-assigned roles are never overwritten.
pub fn infer_and_migrate_roles(board: &mut KanbanBoard) -> bool {
    let mut changed = false;
    for col in &mut board.columns {
        if col.role == ColumnRole::Other {
            if let Some(inferred) = ColumnRole::infer_from_name(&col.name) {
                col.role = inferred;
                changed = true;
            }
        }
    }
    changed
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

fn default_schema() -> u32 {
    SCHEMA_VERSION
}

/// Returns ~/.ultron/cockpit/projects/<project_id>/kanban.json
pub fn board_path(project_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("kanban.json"))
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{}", secs)
}

fn new_ulid(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    format!("{prefix}-{t}-{n}")
}

pub fn default_board(project_id: &str) -> KanbanBoard {
    KanbanBoard {
        project_id: project_id.to_string(),
        columns: vec![
            Column {
                id: new_ulid("col"),
                name: "Backlog".into(),
                order: 0,
                role: ColumnRole::Todo,
            },
            Column {
                id: new_ulid("col"),
                name: "In Progress".into(),
                order: 1,
                role: ColumnRole::Doing,
            },
            Column {
                id: new_ulid("col"),
                name: "Blocked".into(),
                order: 2,
                role: ColumnRole::Blocked,
            },
            Column {
                id: new_ulid("col"),
                name: "Done".into(),
                order: 3,
                role: ColumnRole::Done,
            },
        ],
        cards: vec![],
        default_agent: None,
        default_prompt_template: None,
        schema_version: SCHEMA_VERSION,
    }
}

pub fn load(project_id: &str) -> Result<KanbanBoard, String> {
    let path = board_path(project_id)?;
    if !path.exists() {
        let board = default_board(project_id);
        save(&board)?;
        return Ok(board);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut board: KanbanBoard =
        serde_json::from_str(&raw).map_err(|e| format!("parse kanban.json: {e}"))?;
    // Idempotent role migration: infer roles for columns that still carry
    // `Other` (boards written before v2.14).  Only writes when something
    // actually changed to avoid unnecessary I/O.
    if infer_and_migrate_roles(&mut board) {
        // Best-effort save — a failure here must not prevent the caller from
        // receiving the (already-corrected) board.
        if let Err(e) = save(&board) {
            eprintln!("[kanban] migration save failed: {e}");
        }
    }
    Ok(board)
}

pub fn save(board: &KanbanBoard) -> Result<(), String> {
    let path = board_path(&board.project_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(board).map_err(|e| format!("serialize: {e}"))?;
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
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

pub fn create_card(
    project_id: &str,
    column_id: &str,
    partial: CardPartial,
) -> Result<Card, String> {
    let mut board = load(project_id)?;
    if !board.columns.iter().any(|c| c.id == column_id) {
        return Err(format!("column {column_id} not found"));
    }
    let next_order = board
        .cards
        .iter()
        .filter(|c| c.column_id == column_id)
        .map(|c| c.order)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);
    let now = now_iso();
    let card = Card {
        id: new_ulid("card"),
        column_id: column_id.to_string(),
        title: partial.title,
        description: partial.description,
        agent: partial.agent,
        prompt_template: partial.prompt_template,
        cwd: partial.cwd,
        tags: partial.tags,
        order: next_order,
        created_at: now.clone(),
        updated_at: now,
        runs: vec![],
    };
    board.cards.push(card.clone());
    save(&board)?;
    Ok(card)
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

pub fn update_card(project_id: &str, card_id: &str, patch: CardPatch) -> Result<Card, String> {
    let mut board = load(project_id)?;
    let card = board
        .cards
        .iter_mut()
        .find(|c| c.id == card_id)
        .ok_or_else(|| format!("card {card_id} not found"))?;
    if let Some(v) = patch.title {
        card.title = v;
    }
    if let Some(v) = patch.description {
        card.description = v;
    }
    if let Some(v) = patch.agent {
        card.agent = v;
    }
    if let Some(v) = patch.prompt_template {
        card.prompt_template = v;
    }
    if let Some(v) = patch.cwd {
        card.cwd = v;
    }
    if let Some(v) = patch.tags {
        card.tags = v;
    }
    card.updated_at = now_iso();
    let out = card.clone();
    save(&board)?;
    Ok(out)
}

pub fn move_card(
    project_id: &str,
    card_id: &str,
    target_column_id: &str,
    order: u32,
) -> Result<KanbanBoard, String> {
    let mut board = load(project_id)?;
    if !board.columns.iter().any(|c| c.id == target_column_id) {
        return Err(format!("column {target_column_id} not found"));
    }
    let card = board
        .cards
        .iter_mut()
        .find(|c| c.id == card_id)
        .ok_or_else(|| format!("card {card_id} not found"))?;
    card.column_id = target_column_id.to_string();
    card.order = order;
    card.updated_at = now_iso();
    save(&board)?;
    Ok(board)
}

pub fn delete_card(project_id: &str, card_id: &str) -> Result<(), String> {
    let mut board = load(project_id)?;
    let before = board.cards.len();
    board.cards.retain(|c| c.id != card_id);
    if board.cards.len() == before {
        return Err(format!("card {card_id} not found"));
    }
    save(&board)?;
    Ok(())
}

pub fn append_run(project_id: &str, card_id: &str, run: CardRun) -> Result<(), String> {
    let _g = kanban_lock()
        .lock()
        .map_err(|_| "kanban lock poisoned".to_string())?;
    let mut board = load(project_id)?;
    let card = board
        .cards
        .iter_mut()
        .find(|c| c.id == card_id)
        .ok_or_else(|| format!("card {card_id} not found"))?;
    card.runs.push(run);
    card.updated_at = now_iso();
    save(&board)?;
    Ok(())
}

pub fn column_by_name<'a>(board: &'a KanbanBoard, name: &str) -> Option<&'a Column> {
    board
        .columns
        .iter()
        .find(|c| c.name.eq_ignore_ascii_case(name))
}

pub fn card_by_id<'a>(board: &'a KanbanBoard, card_id: &str) -> Option<&'a Card> {
    board.cards.iter().find(|c| c.id == card_id)
}

// ---------------------------------------------------------------------------
// v2.14 — Column CRUD
//
// All operations acquire KANBAN_WRITE_LOCK and use the atomic load→mutate→save
// pattern.  They are additive-only: no cards are ever silently discarded.
// ---------------------------------------------------------------------------

/// Add a new column to the end of the board.
///
/// The column is assigned `order = max_existing_order + 1` and returned.
pub fn add_column(
    project_id: &str,
    name: impl Into<String>,
    role: ColumnRole,
) -> Result<Column, String> {
    let _g = kanban_lock()
        .lock()
        .map_err(|_| "kanban lock poisoned".to_string())?;
    let mut board = load(project_id)?;
    let next_order = board
        .columns
        .iter()
        .map(|c| c.order)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);
    let col = Column {
        id: new_ulid("col"),
        name: name.into(),
        order: next_order,
        role,
    };
    board.columns.push(col.clone());
    save(&board)?;
    Ok(col)
}

/// Core logic for column deletion, operating purely on an in-memory board.
///
/// Extracted so that unit tests can exercise it without touching the filesystem.
/// See [`delete_column`] for the public, file-backed entry point.
pub(crate) fn delete_column_in_memory(
    board: &mut KanbanBoard,
    column_id: &str,
    reassign_to_column_id: Option<&str>,
) -> Result<(), String> {
    if !board.columns.iter().any(|c| c.id == column_id) {
        return Err(format!("column {column_id} not found"));
    }

    let card_count = board
        .cards
        .iter()
        .filter(|c| c.column_id == column_id)
        .count();

    if card_count > 0 {
        match reassign_to_column_id {
            Some(target_id) => {
                if !board.columns.iter().any(|c| c.id == target_id) {
                    return Err(format!("reassign target column {target_id} not found"));
                }
                let now = now_iso();
                for card in &mut board.cards {
                    if card.column_id == column_id {
                        card.column_id = target_id.to_string();
                        card.updated_at = now.clone();
                    }
                }
            }
            None => {
                return Err(format!(
                    "column {column_id} has {card_count} card(s); provide \
                     reassign_to_column_id or move cards first"
                ));
            }
        }
    }

    board.columns.retain(|c| c.id != column_id);
    Ok(())
}

/// Delete a column by `column_id`.
///
/// If the column contains cards:
/// - When `reassign_to_column_id` is `Some(id)`, all cards are moved to that
///   column before deletion.
/// - When `reassign_to_column_id` is `None` and the column still has cards
///   this function returns `Err` — cards are never silently dropped.
///
/// If the column does not exist this function returns `Err`.
pub fn delete_column(
    project_id: &str,
    column_id: &str,
    reassign_to_column_id: Option<&str>,
) -> Result<(), String> {
    let _g = kanban_lock()
        .lock()
        .map_err(|_| "kanban lock poisoned".to_string())?;
    let mut board = load(project_id)?;
    delete_column_in_memory(&mut board, column_id, reassign_to_column_id)?;
    save(&board)?;
    Ok(())
}

/// Rename a column.  Returns the updated column.
pub fn rename_column(
    project_id: &str,
    column_id: &str,
    name: impl Into<String>,
) -> Result<Column, String> {
    let _g = kanban_lock()
        .lock()
        .map_err(|_| "kanban lock poisoned".to_string())?;
    let mut board = load(project_id)?;
    let col = board
        .columns
        .iter_mut()
        .find(|c| c.id == column_id)
        .ok_or_else(|| format!("column {column_id} not found"))?;
    col.name = name.into();
    let out = col.clone();
    save(&board)?;
    Ok(out)
}

/// Reorder columns by providing the desired sequence of column IDs.
///
/// Every ID in `ordered_ids` must exist on the board; extra or missing IDs
/// return `Err`.  The `order` field of each column is set to its index in
/// `ordered_ids`.
pub fn reorder_columns(project_id: &str, ordered_ids: &[String]) -> Result<KanbanBoard, String> {
    let _g = kanban_lock()
        .lock()
        .map_err(|_| "kanban lock poisoned".to_string())?;
    let mut board = load(project_id)?;

    if ordered_ids.len() != board.columns.len() {
        return Err(format!(
            "ordered_ids has {} entries but board has {} columns",
            ordered_ids.len(),
            board.columns.len()
        ));
    }
    for id in ordered_ids {
        if !board.columns.iter().any(|c| &c.id == id) {
            return Err(format!("column {id} not found in board"));
        }
    }

    for col in &mut board.columns {
        if let Some(pos) = ordered_ids.iter().position(|id| id == &col.id) {
            col.order = pos as u32;
        }
    }
    board.columns.sort_by_key(|c| c.order);
    save(&board)?;
    Ok(board)
}

// KIRKARDO 19 — kanban concurrency lock tests
#[cfg(test)]
mod tests {
    use super::*;

    // card-test-fixtures-rust-infra: the fixture must deserialise into the real
    // KanbanBoard type, so it stays honest if the schema changes.
    #[test]
    fn fixture_kanban_test_deserialises_into_board() {
        let raw = crate::test_support::load_fixture("kanban", "kanban-test.json");
        let board: KanbanBoard =
            serde_json::from_str(&raw).expect("kanban-test.json must parse into KanbanBoard");
        assert_eq!(board.columns.len(), 2, "fixture has 2 columns");
        assert_eq!(board.cards.len(), 5, "fixture has 5 cards");
        assert_eq!(
            board
                .cards
                .iter()
                .filter(|c| c.column_id == "col-done")
                .count(),
            2,
            "2 cards in the Done column"
        );
        assert!(
            board
                .cards
                .iter()
                .any(|c| c.tags.contains(&"rust".to_string())),
            "card-2 carries tags"
        );
    }

    #[test]
    fn kanban_lock_same_static() {
        let a = kanban_lock() as *const Mutex<()>;
        let b = kanban_lock() as *const Mutex<()>;
        assert_eq!(a, b);
    }

    #[test]
    fn kanban_lock_sequential_under_contention() {
        use std::sync::{Arc, Barrier};
        use std::thread;
        let barrier = Arc::new(Barrier::new(2));
        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let b2 = Arc::clone(&barrier);
        let c2 = Arc::clone(&counter);
        let h = thread::spawn(move || {
            b2.wait();
            let _g = kanban_lock().lock().unwrap();
            let v = c2.load(Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(5));
            c2.store(v + 1, Ordering::SeqCst);
        });
        barrier.wait();
        {
            let _g = kanban_lock().lock().unwrap();
            let v = counter.load(Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(5));
            counter.store(v + 1, Ordering::SeqCst);
        }
        h.join().unwrap();
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    // -----------------------------------------------------------------------
    // v2.14 — ColumnRole inference tests
    // -----------------------------------------------------------------------

    /// Helper: build a minimal board with given column names, all roles Other.
    fn board_with_columns(names: &[&str]) -> KanbanBoard {
        KanbanBoard {
            project_id: "test".into(),
            columns: names
                .iter()
                .enumerate()
                .map(|(i, name)| Column {
                    id: format!("col-{i}"),
                    name: (*name).to_string(),
                    order: i as u32,
                    role: ColumnRole::Other,
                })
                .collect(),
            cards: vec![],
            default_agent: None,
            default_prompt_template: None,
            schema_version: SCHEMA_VERSION,
        }
    }

    #[test]
    fn role_inference_in_progress_maps_to_doing() {
        assert_eq!(
            ColumnRole::infer_from_name("In Progress"),
            Some(ColumnRole::Doing)
        );
    }

    #[test]
    fn role_inference_investigar_maps_to_todo() {
        assert_eq!(
            ColumnRole::infer_from_name("Investigar"),
            Some(ColumnRole::Todo)
        );
    }

    #[test]
    fn role_inference_done_maps_to_done() {
        assert_eq!(ColumnRole::infer_from_name("Done"), Some(ColumnRole::Done));
    }

    #[test]
    fn role_inference_blocked_maps_to_blocked() {
        assert_eq!(
            ColumnRole::infer_from_name("Blocked"),
            Some(ColumnRole::Blocked)
        );
    }

    #[test]
    fn role_inference_backlog_maps_to_todo() {
        assert_eq!(
            ColumnRole::infer_from_name("Backlog"),
            Some(ColumnRole::Todo)
        );
    }

    #[test]
    fn role_inference_unknown_column_returns_none() {
        assert_eq!(ColumnRole::infer_from_name("Sprint 42"), None);
    }

    /// Migration must assign correct roles from name heuristics and return true.
    #[test]
    fn migrate_roles_infers_all_defaults() {
        let mut board =
            board_with_columns(&["Backlog", "In Progress", "Investigar", "Blocked", "Done"]);
        let changed = infer_and_migrate_roles(&mut board);
        assert!(changed, "should report that roles were updated");

        let role = |name: &str| {
            board
                .columns
                .iter()
                .find(|c| c.name == name)
                .unwrap()
                .role
                .clone()
        };
        assert_eq!(role("Backlog"), ColumnRole::Todo);
        assert_eq!(role("In Progress"), ColumnRole::Doing);
        assert_eq!(role("Investigar"), ColumnRole::Todo);
        assert_eq!(role("Blocked"), ColumnRole::Blocked);
        assert_eq!(role("Done"), ColumnRole::Done);
    }

    /// Second call to migrate_roles must not change anything (idempotent).
    #[test]
    fn migrate_roles_is_idempotent() {
        let mut board = board_with_columns(&["Backlog", "Done"]);
        infer_and_migrate_roles(&mut board);
        // Snapshot roles after first pass.
        let snapshot: Vec<ColumnRole> = board.columns.iter().map(|c| c.role.clone()).collect();
        // Second pass must report no changes.
        let changed = infer_and_migrate_roles(&mut board);
        assert!(!changed, "second migration must be a no-op");
        let after: Vec<ColumnRole> = board.columns.iter().map(|c| c.role.clone()).collect();
        assert_eq!(snapshot, after);
    }

    /// A board loaded from JSON without the `role` field must deserialise to Other.
    #[test]
    fn column_without_role_field_deserialises_to_other() {
        let json = r#"{
            "project_id": "p",
            "columns": [{"id": "c1", "name": "Done", "order": 0}],
            "cards": [],
            "schema_version": 1
        }"#;
        let board: KanbanBoard = serde_json::from_str(json).unwrap();
        assert_eq!(board.columns[0].role, ColumnRole::Other);
    }

    /// `is_done_column` must use role when set, not name.
    #[test]
    fn is_done_column_uses_role_when_set() {
        let col_by_role = Column {
            id: "c1".into(),
            name: "Finished work".into(), // name does NOT contain "done"/"complete"
            order: 0,
            role: ColumnRole::Done,
        };
        assert!(is_done_column(&col_by_role), "role=Done must be detected");

        let col_not_done = Column {
            id: "c2".into(),
            name: "Done".into(), // name contains "done" but role overrides
            order: 1,
            role: ColumnRole::Todo, // explicit non-Done role
        };
        assert!(
            !is_done_column(&col_not_done),
            "role=Todo must NOT be detected as done"
        );
    }

    /// `is_done_column` falls back to name matching when role is Other.
    #[test]
    fn is_done_column_falls_back_to_name_when_other() {
        let col = Column {
            id: "c1".into(),
            name: "Done".into(),
            order: 0,
            role: ColumnRole::Other,
        };
        assert!(is_done_column(&col), "name fallback must detect 'Done'");
    }

    // -----------------------------------------------------------------------
    // v2.14 — delete_column tests (in-memory, no filesystem)
    // -----------------------------------------------------------------------

    fn make_card(id: &str, column_id: &str) -> Card {
        Card {
            id: id.to_string(),
            column_id: column_id.to_string(),
            title: id.to_string(),
            description: String::new(),
            agent: None,
            prompt_template: None,
            cwd: None,
            tags: vec![],
            order: 0,
            created_at: "epoch:0".into(),
            updated_at: "epoch:0".into(),
            runs: vec![],
        }
    }

    /// Deleting a column that has cards without a reassign target must return Err.
    #[test]
    fn delete_column_with_cards_and_no_reassign_returns_err() {
        let col_a = Column {
            id: "col-a".into(),
            name: "Active".into(),
            order: 0,
            role: ColumnRole::Doing,
        };
        let col_b = Column {
            id: "col-b".into(),
            name: "Done".into(),
            order: 1,
            role: ColumnRole::Done,
        };
        let mut board = KanbanBoard {
            project_id: "proj".into(),
            columns: vec![col_a, col_b],
            cards: vec![make_card("card-1", "col-a"), make_card("card-2", "col-a")],
            default_agent: None,
            default_prompt_template: None,
            schema_version: SCHEMA_VERSION,
        };

        let err = delete_column_in_memory(&mut board, "col-a", None).unwrap_err();
        assert!(
            err.contains("2 card(s)"),
            "error must mention card count, got: {err}"
        );
        // Cards must NOT have been removed.
        assert_eq!(board.cards.len(), 2, "no cards must be lost");
    }

    /// Deleting a column with reassign moves all cards to the target.
    #[test]
    fn delete_column_with_reassign_moves_cards_and_removes_column() {
        let col_a = Column {
            id: "col-a".into(),
            name: "Active".into(),
            order: 0,
            role: ColumnRole::Doing,
        };
        let col_b = Column {
            id: "col-b".into(),
            name: "Done".into(),
            order: 1,
            role: ColumnRole::Done,
        };
        let mut board = KanbanBoard {
            project_id: "proj".into(),
            columns: vec![col_a, col_b],
            cards: vec![make_card("card-1", "col-a"), make_card("card-2", "col-a")],
            default_agent: None,
            default_prompt_template: None,
            schema_version: SCHEMA_VERSION,
        };

        delete_column_in_memory(&mut board, "col-a", Some("col-b")).unwrap();

        assert_eq!(board.columns.len(), 1, "col-a must be removed");
        assert_eq!(board.columns[0].id, "col-b");
        assert_eq!(board.cards.len(), 2, "no cards must be lost");
        assert!(
            board.cards.iter().all(|c| c.column_id == "col-b"),
            "all cards must be reassigned to col-b"
        );
    }
}

/// Migration: ensure every project listed in `projects.json` has a kanban.json.
/// Idempotent: no-op if file already exists.
pub fn migrate_all_projects(project_ids: &[String]) -> Result<u32, String> {
    let mut created = 0u32;
    for pid in project_ids {
        let path = board_path(pid)?;
        if !path.exists() {
            save(&default_board(pid))?;
            created += 1;
        }
    }
    Ok(created)
}

// ---------------------------------------------------------------------------
// v2.6.2 — kanban archive (named groups for archived Done cards).
//
// Archives live under
//   ~/.ultron/cockpit/projects/<project_id>/archives/<name>.json
// One archive = one named group (e.g. "2026-05-sprint", "v15-cleanup"). The
// frontend "Archive Done" toolbar button writes a new archive containing every
// card currently in any Done/Complete column, then strips those cards from the
// live board.
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

/// Full payload — used by `kanban_load_archive` for the viewer modal.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KanbanArchive {
    pub name: String,
    pub archived_at: String,
    pub cards: Vec<ArchivedCard>,
}

/// Slim summary — used by `kanban_list_archives` for the box-grid. Skips the
/// full `cards` payload so the grid renders fast even with many archives.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KanbanArchiveSummary {
    pub name: String,
    pub archived_at: String,
    pub card_count: usize,
}

fn archives_dir(project_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("archives"))
}

/// Coerce a user-supplied archive name to a filesystem-safe stem. Mirrors the
/// approach used elsewhere in the codebase (slugify-ish): keep alnum, dash,
/// underscore, dot; collapse everything else to a single dash. Empty result
/// is rejected upstream.
fn sanitise_archive_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches(|c: char| c == '-' || c == '.').to_string()
}

fn archive_path(project_id: &str, sanitised_name: &str) -> Result<PathBuf, String> {
    Ok(archives_dir(project_id)?.join(format!("{sanitised_name}.json")))
}

/// Move every card sitting in a Done/Complete column into a named archive
/// file, then strip them from the live board.
///
/// Idempotency note: passing the same `archive_name` twice merges into the
/// existing archive — we append the new batch instead of clobbering it. This
/// matches how the user described the feature ("agrupar por sprint").
pub fn archive_done(project_id: &str, archive_name: &str) -> Result<KanbanArchive, String> {
    let _g = kanban_lock()
        .lock()
        .map_err(|_| "kanban lock poisoned".to_string())?;
    let safe = sanitise_archive_name(archive_name);
    if safe.is_empty() {
        return Err("archive name is empty after sanitisation".into());
    }
    let mut board = load(project_id)?;
    // Resolve the set of Done-ish column ids on the live board using the
    // canonical role when available, falling back to name-based heuristics.
    let done_col_ids: std::collections::HashSet<String> = board
        .columns
        .iter()
        .filter(|c| is_done_column(c))
        .map(|c| c.id.clone())
        .collect();
    if done_col_ids.is_empty() {
        return Err("no Done/Complete column on this board".into());
    }
    // Snapshot the Done cards into archived form before we strip them.
    let archived_now: Vec<ArchivedCard> = board
        .cards
        .iter()
        .filter(|c| done_col_ids.contains(&c.column_id))
        .map(|c| {
            let col_name = board
                .columns
                .iter()
                .find(|col| col.id == c.column_id)
                .map(|col| col.name.clone())
                .unwrap_or_else(|| c.column_id.clone());
            ArchivedCard {
                id: c.id.clone(),
                title: c.title.clone(),
                description: c.description.clone(),
                tags: c.tags.clone(),
                column_name: col_name,
                archived_from_column_id: c.column_id.clone(),
            }
        })
        .collect();
    if archived_now.is_empty() {
        return Err("no Done cards to archive".into());
    }
    // Merge with the existing archive (if any) so re-using a name appends.
    let archive_path = archive_path(project_id, &safe)?;
    let mut archive = if archive_path.exists() {
        let raw =
            fs::read_to_string(&archive_path).map_err(|e| format!("read existing archive: {e}"))?;
        let existing: KanbanArchive =
            serde_json::from_str(&raw).map_err(|e| format!("parse archive: {e}"))?;
        existing
    } else {
        KanbanArchive {
            name: safe.clone(),
            archived_at: now_iso(),
            cards: Vec::new(),
        }
    };
    archive.cards.extend(archived_now);
    archive.archived_at = now_iso();
    // Persist the archive atomically — tmp + rename, same envelope as `save`.
    if let Some(parent) = archive_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir archives: {e}"))?;
    }
    let tmp = archive_path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&archive).map_err(|e| format!("serialize: {e}"))?;
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create archive tmp: {e}"))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("write archive tmp: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &archive_path).map_err(|e| format!("rename archive: {e}"))?;
    // Strip the archived cards from the live board.
    board.cards.retain(|c| !done_col_ids.contains(&c.column_id));
    save(&board)?;
    Ok(archive)
}

/// List archive summaries (no card payload — keeps the grid light).
pub fn list_archives(project_id: &str) -> Result<Vec<KanbanArchiveSummary>, String> {
    let dir = archives_dir(project_id)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir).map_err(|e| format!("read archives dir: {e}"))?;
    let mut out: Vec<KanbanArchiveSummary> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let archive: KanbanArchive = match serde_json::from_str(&raw) {
            Ok(a) => a,
            Err(_) => continue, // tolerate stale / malformed entries
        };
        out.push(KanbanArchiveSummary {
            name: archive.name,
            archived_at: archive.archived_at,
            card_count: archive.cards.len(),
        });
    }
    // Newest first — archived_at is "epoch:<secs>" so lexicographic-desc is
    // numerically-desc for any timestamp on the same digit-width.
    out.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    Ok(out)
}

/// Load a single archive file by its (sanitised) name.
pub fn load_archive(project_id: &str, archive_name: &str) -> Result<KanbanArchive, String> {
    let safe = sanitise_archive_name(archive_name);
    if safe.is_empty() {
        return Err("archive name is empty".into());
    }
    let path = archive_path(project_id, &safe)?;
    if !path.exists() {
        return Err(format!("archive '{safe}' not found"));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read archive: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse archive: {e}"))
}
