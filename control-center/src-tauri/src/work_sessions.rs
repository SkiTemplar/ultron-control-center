// ULTRON Control Center — Work-sessions domain
//
// A "work-session" is a user-defined block of focused work on a project
// (typically 1–3 h). It is NOT a Claude AI session — it is the *container*
// that groups AI sessions, kanban cards touched, and files changed during
// one coherent stint of work.
//
// Storage: ~/.ultron/cockpit/projects/<project_id>/work-sessions.jsonl
// Each line is a serialised `WorkSession` JSON object. New sessions are
// appended; mutations rewrite the file (file is small enough that a full
// rewrite is cheap and atomic-safe).
//
// Why JSONL? Consistent with the rest of the cockpit surface (workdays use
// single JSON files; sessions and alerts use JSONL). Append is O(1) for the
// common "start" path; list is a full scan which is fine for <1000 entries.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// ID + timestamp helpers (mirrors workdays.rs conventions)
// ---------------------------------------------------------------------------

fn new_id() -> String {
    static C: AtomicU64 = AtomicU64::new(0);
    let n = C.fetch_add(1, Ordering::Relaxed);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    format!("ws-{t}-{n}")
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn epoch_iso(secs: u64) -> String {
    // Store as "epoch:<secs>" matching the workdays.rs convention so the
    // frontend's existing date-format helpers work unchanged.
    format!("epoch:{secs}")
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkSessionStatus {
    Active,
    Completed,
}

/// A kanban card referenced during a work-session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardRef {
    pub id: String,
    pub title: String,
    /// The column the card was in at the time of the touch (e.g. "In Progress").
    pub column: String,
}

/// One focused block of work by the user on a project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkSession {
    pub id: String,
    pub project_id: String,
    /// The Workday this session is linked to.
    pub workday_id: String,
    /// epoch:<secs> — set on start, never changed.
    pub started_at: String,
    /// epoch:<secs> — set on end; None while active.
    #[serde(default)]
    pub ended_at: Option<String>,
    /// Wall-clock seconds between started_at and ended_at.
    /// While active: 0. Computed on end.
    #[serde(default)]
    pub duration_seconds: u64,
    pub status: WorkSessionStatus,
    /// Claude / Codex / Gemini AI session IDs linked to this work block.
    #[serde(default)]
    pub ai_session_ids: Vec<String>,
    /// Kanban cards the user touched during this block.
    #[serde(default)]
    pub cards_touched: Vec<CardRef>,
    /// Relative file paths that were modified during this block (populated
    /// manually or via future git-diff integration).
    #[serde(default)]
    pub files_changed: Vec<String>,
    /// Free-form retrospective notes written when the session is closed.
    #[serde(default)]
    pub notes: Option<String>,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/// ~/.ultron/cockpit/projects/<project_id>/work-sessions.jsonl
pub fn work_sessions_path(project_id: &str) -> Result<PathBuf, String> {
    let root = dirs::home_dir()
        .ok_or_else(|| "no home dir".to_string())?
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id);
    Ok(root.join("work-sessions.jsonl"))
}

/// Read all sessions for a project. Malformed lines are silently skipped.
fn read_all(project_id: &str) -> Result<Vec<WorkSession>, String> {
    let path = work_sessions_path(project_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read work-sessions: {e}"))?;
    let sessions: Vec<WorkSession> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    Ok(sessions)
}

/// Overwrite the whole file atomically (full rewrite on mutation).
fn write_all(project_id: &str, sessions: &[WorkSession]) -> Result<(), String> {
    let path = work_sessions_path(project_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        for s in sessions {
            let line = serde_json::to_string(s).map_err(|e| format!("ser: {e}"))?;
            writeln!(f, "{line}").map_err(|e| format!("write line: {e}"))?;
        }
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))
}

/// Patch a single session in-place and persist the whole file.
fn patch_session<F>(project_id: &str, session_id: &str, mutate: F) -> Result<WorkSession, String>
where
    F: FnOnce(&mut WorkSession),
{
    let mut sessions = read_all(project_id)?;
    let pos = sessions
        .iter()
        .position(|s| s.id == session_id)
        .ok_or_else(|| format!("work-session {session_id} not found in project {project_id}"))?;
    mutate(&mut sessions[pos]);
    let updated = sessions[pos].clone();
    write_all(project_id, &sessions)?;
    Ok(updated)
}

// ---------------------------------------------------------------------------
// Inner functions (called by the command wrappers)
// ---------------------------------------------------------------------------

/// Create and persist a new active work-session.
pub fn start_inner(project_id: String, workday_id: String) -> Result<WorkSession, String> {
    // Enforce single active session per project.
    let existing = read_all(&project_id)?;
    if existing
        .iter()
        .any(|s| s.status == WorkSessionStatus::Active)
    {
        return Err(
            "there is already an active work-session for this project — end it first".to_string(),
        );
    }

    let session = WorkSession {
        id: new_id(),
        project_id: project_id.clone(),
        workday_id,
        started_at: epoch_iso(now_epoch_secs()),
        ended_at: None,
        duration_seconds: 0,
        status: WorkSessionStatus::Active,
        ai_session_ids: Vec::new(),
        cards_touched: Vec::new(),
        files_changed: Vec::new(),
        notes: None,
    };

    let path = work_sessions_path(&project_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    // Append a single line — fast path for the start case.
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open for append: {e}"))?;
    let line = serde_json::to_string(&session).map_err(|e| format!("ser: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("append: {e}"))?;

    Ok(session)
}

/// Close an active work-session, writing back notes and computing duration.
pub fn end_inner(
    project_id: String,
    session_id: String,
    notes: Option<String>,
) -> Result<WorkSession, String> {
    let end_secs = now_epoch_secs();
    patch_session(&project_id, &session_id, |s| {
        if s.status != WorkSessionStatus::Active {
            // Idempotent: ending a completed session is a no-op update.
            return;
        }
        // Parse started_at epoch:<secs>
        let started_secs = s
            .started_at
            .strip_prefix("epoch:")
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(0);
        s.ended_at = Some(epoch_iso(end_secs));
        s.duration_seconds = end_secs.saturating_sub(started_secs);
        s.status = WorkSessionStatus::Completed;
        if notes.is_some() {
            s.notes = notes.clone();
        }
    })
}

/// Return all sessions newest-first.
pub fn list_inner(project_id: String) -> Result<Vec<WorkSession>, String> {
    let mut sessions = read_all(&project_id)?;
    sessions.reverse(); // newest first
    Ok(sessions)
}

/// Append an AI session ID to an existing work-session (idempotent).
pub fn link_ai_inner(
    project_id: String,
    session_id: String,
    ai_session_id: String,
) -> Result<WorkSession, String> {
    patch_session(&project_id, &session_id, |s| {
        if !s.ai_session_ids.contains(&ai_session_id) {
            s.ai_session_ids.push(ai_session_id.clone());
        }
    })
}

/// Return the currently active session for a project, if any.
pub fn active_session_inner(project_id: String) -> Result<Option<WorkSession>, String> {
    let sessions = read_all(&project_id)?;
    Ok(sessions.into_iter().find(|s| s.status == WorkSessionStatus::Active))
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn project_work_session_start(
    project_id: String,
    workday_id: String,
) -> Result<WorkSession, String> {
    start_inner(project_id, workday_id)
}

#[tauri::command]
pub fn project_work_session_end(
    project_id: String,
    session_id: String,
    notes: Option<String>,
) -> Result<WorkSession, String> {
    end_inner(project_id, session_id, notes)
}

#[tauri::command]
pub fn project_work_sessions_list(project_id: String) -> Result<Vec<WorkSession>, String> {
    list_inner(project_id)
}

#[tauri::command]
pub fn project_work_session_link_ai(
    project_id: String,
    session_id: String,
    ai_session_id: String,
) -> Result<WorkSession, String> {
    link_ai_inner(project_id, session_id, ai_session_id)
}

#[tauri::command]
pub fn project_work_session_active(
    project_id: String,
) -> Result<Option<WorkSession>, String> {
    active_session_inner(project_id)
}
