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
