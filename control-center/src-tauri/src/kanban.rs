// ULTRON Control Center 2.0 — Kanban domain
//
// Per-project board persisted at `~/.ultron/cockpit/projects/<project_id>/kanban.json`.
// Atomic writes via tmp + rename. Loader is idempotent: unknown fields ignored,
// missing fields defaulted, so older JSONs upgrade transparently.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Column {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: u32,
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
            Column { id: new_ulid("col"), name: "Backlog".into(), order: 0 },
            Column { id: new_ulid("col"), name: "In Progress".into(), order: 1 },
            Column { id: new_ulid("col"), name: "Blocked".into(), order: 2 },
            Column { id: new_ulid("col"), name: "Done".into(), order: 3 },
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
    let board: KanbanBoard =
        serde_json::from_str(&raw).map_err(|e| format!("parse kanban.json: {e}"))?;
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
        f.write_all(json.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
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
    board.columns.iter().find(|c| c.name.eq_ignore_ascii_case(name))
}

pub fn card_by_id<'a>(board: &'a KanbanBoard, card_id: &str) -> Option<&'a Card> {
    board.cards.iter().find(|c| c.id == card_id)
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
    let safe = sanitise_archive_name(archive_name);
    if safe.is_empty() {
        return Err("archive name is empty after sanitisation".into());
    }
    let mut board = load(project_id)?;
    // Resolve the set of Done-ish column ids on the live board.
    let done_col_ids: std::collections::HashSet<String> = board
        .columns
        .iter()
        .filter(|c| {
            let n = c.name.to_ascii_lowercase();
            n.contains("done") || n.contains("complete")
        })
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
        let raw = fs::read_to_string(&archive_path)
            .map_err(|e| format!("read existing archive: {e}"))?;
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
