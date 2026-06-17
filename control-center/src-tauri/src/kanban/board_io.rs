// kanban/board_io.rs — board I/O, card and column operations.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::types_model::kanban_lock;
use super::types_model::{
    Card, CardPartial, CardPatch, CardRun, Column, ColumnRole, KanbanBoard, SCHEMA_VERSION,
};

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

pub(super) fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{}", secs)
}

pub(super) fn new_ulid(prefix: &str) -> String {
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
/// Safe to call repeatedly -- already-assigned roles are never overwritten.
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
    // Idempotent self-healing on load — each pass reports whether it changed
    // anything so we persist at most once. Best-effort save: a failure must not
    // prevent the caller from receiving the (already-corrected, in-memory)
    // board.
    //   1. role inference for pre-v2.14 columns,
    //   2. re-link orphan cards whose column_id is a column *name*, not an id,
    //   3. normalise card orders to a gap-free, unique 0..n per column.
    let mut dirty = infer_and_migrate_roles(&mut board);
    dirty |= relink_orphan_cards(&mut board);
    dirty |= normalize_card_orders(&mut board);
    if dirty {
        if let Err(e) = save(&board) {
            eprintln!("[kanban] load-time normalization save failed: {e}");
        }
    }
    Ok(board)
}

/// Re-link cards whose `column_id` matches no column id but *does* match a
/// column *name* (case-insensitive). Legacy seed scripts occasionally wrote the
/// human column name (e.g. `"Done"`) into `column_id` instead of the real id,
/// which left the card invisible -- it belonged to no rendered column.
///
/// Returns `true` when at least one card was re-homed. Idempotent.
pub fn relink_orphan_cards(board: &mut KanbanBoard) -> bool {
    let valid_ids: std::collections::HashSet<String> =
        board.columns.iter().map(|c| c.id.clone()).collect();
    let name_to_id: std::collections::HashMap<String, String> = board
        .columns
        .iter()
        .map(|c| (c.name.to_ascii_lowercase(), c.id.clone()))
        .collect();
    let mut changed = false;
    for card in &mut board.cards {
        if valid_ids.contains(&card.column_id) {
            continue;
        }
        if let Some(id) = name_to_id.get(&card.column_id.to_ascii_lowercase()) {
            card.column_id = id.clone();
            changed = true;
        }
    }
    changed
}

/// Normalise every column's card orders to a gap-free, duplicate-free `0..n`
/// sequence while preserving the existing relative order (ties broken by
/// current order, then creation time, then id for determinism).
///
/// Returns `true` when anything changed. This self-heals legacy boards that
/// carried negative or duplicate orders without ever rejecting the parse, and
/// guarantees the unique orders that make drag-and-drop sorting stable.
pub fn normalize_card_orders(board: &mut KanbanBoard) -> bool {
    let col_ids: Vec<String> = board.columns.iter().map(|c| c.id.clone()).collect();
    let mut changed = false;
    for col_id in col_ids {
        let mut pairs: Vec<(String, i32, String)> = board
            .cards
            .iter()
            .filter(|c| c.column_id == col_id)
            .map(|c| (c.id.clone(), c.order, c.created_at.clone()))
            .collect();
        pairs.sort_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)).then(a.0.cmp(&b.0)));
        for (i, (id, _, _)) in pairs.iter().enumerate() {
            let want = i as i32;
            if let Some(card) = board.cards.iter_mut().find(|c| &c.id == id) {
                if card.order != want {
                    card.order = want;
                    changed = true;
                }
            }
        }
    }
    changed
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
    order: i32,
) -> Result<KanbanBoard, String> {
    let mut board = load(project_id)?;
    apply_move(&mut board, card_id, target_column_id, order)?;
    save(&board)?;
    Ok(board)
}

/// Pure (I/O-free) core of [`move_card`]: re-home `card_id` into
/// `target_column_id` at position `order` (a 0-based index within the
/// destination column), then re-compact the orders of both the destination and
/// source columns to a gap-free, duplicate-free `0..n` sequence.
///
/// Re-compaction is what makes drag-and-drop reliable. The frontend sends a
/// positional index; without re-numbering the surrounding cards two cards could
/// end up sharing the same `order`, which makes the `sort_by(order)` in the UI
/// unstable -- the card appears to "jump back" after being dropped. After this
/// call every card in the touched columns has a unique, contiguous order.
/// Accessible to sibling modules for testing.
pub(super) fn apply_move(
    board: &mut KanbanBoard,
    card_id: &str,
    target_column_id: &str,
    order: i32,
) -> Result<(), String> {
    if !board.columns.iter().any(|c| c.id == target_column_id) {
        return Err(format!("column {target_column_id} not found"));
    }
    let source_column_id = board
        .cards
        .iter()
        .find(|c| c.id == card_id)
        .map(|c| c.column_id.clone())
        .ok_or_else(|| format!("card {card_id} not found"))?;

    // Re-home + stamp the moved card (existence already verified above).
    if let Some(card) = board.cards.iter_mut().find(|c| c.id == card_id) {
        card.column_id = target_column_id.to_string();
        card.updated_at = now_iso();
    }

    // Destination sequence: existing cards (excluding the moved one) sorted by
    // current order, with the moved card spliced in at the requested index.
    let mut dest_ids = sorted_card_ids(board, target_column_id, Some(card_id));
    let pos = (order.max(0) as usize).min(dest_ids.len());
    dest_ids.insert(pos, card_id.to_string());
    reassign_orders(board, &dest_ids);

    // Re-compact the source column too -- the moved card left a gap behind.
    if source_column_id != target_column_id {
        let src_ids = sorted_card_ids(board, &source_column_id, None);
        reassign_orders(board, &src_ids);
    }
    Ok(())
}

/// Card ids in `column_id` sorted by current order (ties by created_at then id),
/// optionally excluding one id.
fn sorted_card_ids(board: &KanbanBoard, column_id: &str, exclude: Option<&str>) -> Vec<String> {
    let mut pairs: Vec<(String, i32, String)> = board
        .cards
        .iter()
        .filter(|c| c.column_id == column_id && Some(c.id.as_str()) != exclude)
        .map(|c| (c.id.clone(), c.order, c.created_at.clone()))
        .collect();
    pairs.sort_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)).then(a.0.cmp(&b.0)));
    pairs.into_iter().map(|(id, _, _)| id).collect()
}

/// Assign `order = index` to each card id in `ordered_ids`. Ids not present on
/// the board are silently skipped.
fn reassign_orders(board: &mut KanbanBoard, ordered_ids: &[String]) {
    for (i, id) in ordered_ids.iter().enumerate() {
        if let Some(card) = board.cards.iter_mut().find(|c| &c.id == id) {
            card.order = i as i32;
        }
    }
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
// v2.14 -- Column CRUD
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
pub fn delete_column_in_memory(
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
///   this function returns `Err` -- cards are never silently dropped.
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
            col.order = pos as i32;
        }
    }
    board.columns.sort_by_key(|c| c.order);
    save(&board)?;
    Ok(board)
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
