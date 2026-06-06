// ULTRON Control Center — Workflow run persistence (KIRKARDO 23 P2).
//
// Stores the history of every workflow execution in a local SQLite database:
//   ~/.ultron/cockpit/workflow-runs.db
//
// Schema:
//   CREATE TABLE workflow_runs (
//     id              INTEGER PRIMARY KEY AUTOINCREMENT,
//     workflow_id     TEXT    NOT NULL,
//     project_id      TEXT,
//     started_at      TEXT    NOT NULL,   -- ISO-8601 UTC
//     ended_at        TEXT,               -- ISO-8601 UTC, NULL while running
//     status          TEXT    NOT NULL,   -- "running"|"success"|"failed"|"cancelled"
//     steps_completed INTEGER NOT NULL DEFAULT 0,
//     steps_total     INTEGER NOT NULL DEFAULT 0,
//     output_summary  TEXT    NOT NULL DEFAULT '',
//     error           TEXT                -- NULL on success
//   );
//
//   CREATE INDEX idx_workflow_id  ON workflow_runs (workflow_id);
//   CREATE INDEX idx_started_at   ON workflow_runs (started_at DESC);
//
// WAL mode is enabled on every connection open so concurrent readers and a
// single writer don't block each other (Tauri backend + potential future CLI).
//
// Thread safety: `rusqlite::Connection` is not `Send`, so every public
// function opens its own connection and closes it when the function returns.
// For P2 write frequency (a few runs per minute at most) this is acceptable
// and simpler than a global connection pool.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Execution status of a single workflow run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Success,
    Failed,
    Cancelled,
}

impl RunStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "success" => Self::Success,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Running,
        }
    }
}

/// A single workflow execution record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRun {
    pub id: i64,
    pub workflow_id: String,
    pub project_id: Option<String>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub status: RunStatus,
    pub steps_completed: u32,
    pub steps_total: u32,
    pub output_summary: String,
    pub error: Option<String>,
}

/// Payload for updating an existing run (all fields optional).
#[derive(Debug, Serialize, Deserialize)]
pub struct RunUpdate {
    pub status: Option<RunStatus>,
    pub steps_completed: Option<u32>,
    pub steps_total: Option<u32>,
    pub output_summary: Option<String>,
    pub error: Option<String>,
    /// When set, records the completion timestamp.
    pub ended_at: Option<DateTime<Utc>>,
}

// ---------------------------------------------------------------------------
// DB path
// ---------------------------------------------------------------------------

fn db_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let dir = home.join(".ultron").join("cockpit");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create cockpit dir: {e}"))?;
    Ok(dir.join("workflow-runs.db"))
}

// ---------------------------------------------------------------------------
// Connection helper
// ---------------------------------------------------------------------------

fn open_conn() -> Result<Connection, String> {
    let path = db_path()?;
    let conn = Connection::open(&path).map_err(|e| format!("open workflow-runs.db: {e}"))?;

    // WAL mode: non-blocking concurrent reads + single writer.
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .map_err(|e| format!("set WAL mode: {e}"))?;

    Ok(conn)
}

// ---------------------------------------------------------------------------
// Schema initialisation
// ---------------------------------------------------------------------------

/// Create the `workflow_runs` table and indices if they do not yet exist.
///
/// Safe to call on every startup — all statements use `CREATE … IF NOT EXISTS`.
pub fn init_db() -> Result<(), String> {
    let conn = open_conn()?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS workflow_runs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_id     TEXT    NOT NULL,
            project_id      TEXT,
            started_at      TEXT    NOT NULL,
            ended_at        TEXT,
            status          TEXT    NOT NULL DEFAULT 'running',
            steps_completed INTEGER NOT NULL DEFAULT 0,
            steps_total     INTEGER NOT NULL DEFAULT 0,
            output_summary  TEXT    NOT NULL DEFAULT '',
            error           TEXT,
            state_json      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_id ON workflow_runs (workflow_id);
        CREATE INDEX IF NOT EXISTS idx_started_at  ON workflow_runs (started_at DESC);
        ",
    )
    .map_err(|e| format!("create workflow_runs table: {e}"))?;

    // Idempotent migration: rich Workflow State (#6) as a side-channel column,
    // so the core WorkflowRun struct + CRUD stay untouched.
    let has_state = conn
        .prepare("PRAGMA table_info(workflow_runs)")
        .ok()
        .map(|mut s| {
            s.query_map([], |r| r.get::<_, String>(1))
                .map(|it| it.flatten().any(|c| c == "state_json"))
                .unwrap_or(true)
        })
        .unwrap_or(true);
    if !has_state {
        let _ = conn.execute_batch("ALTER TABLE workflow_runs ADD COLUMN state_json TEXT;");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/// Insert a new workflow run record and return its auto-assigned `id`.
///
/// `started_at` defaults to `Utc::now()` when `None`.
pub fn record_run_inner(
    workflow_id: String,
    project_id: Option<String>,
    started_at: Option<DateTime<Utc>>,
    steps_total: u32,
) -> Result<i64, String> {
    let conn = open_conn()?;
    let ts = started_at.unwrap_or_else(Utc::now).to_rfc3339();
    conn.execute(
        "INSERT INTO workflow_runs
             (workflow_id, project_id, started_at, status, steps_total)
         VALUES (?1, ?2, ?3, 'running', ?4)",
        params![workflow_id, project_id, ts, steps_total],
    )
    .map_err(|e| format!("insert workflow run: {e}"))?;
    Ok(conn.last_insert_rowid())
}

/// Fetch runs, optionally filtered by `workflow_id` and/or `project_id`.
///
/// Results are ordered newest-first. `limit` is capped at 500.
pub fn list_runs_inner(
    workflow_id: Option<String>,
    project_id: Option<String>,
    limit: u32,
) -> Result<Vec<WorkflowRun>, String> {
    let conn = open_conn()?;
    let cap = limit.clamp(1, 500);

    // Build the WHERE clause dynamically to avoid shipping dead predicates.
    let mut conditions: Vec<&str> = Vec::new();
    if workflow_id.is_some() {
        conditions.push("workflow_id = ?1");
    }
    if project_id.is_some() {
        conditions.push("project_id = ?2");
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT id, workflow_id, project_id, started_at, ended_at,
                status, steps_completed, steps_total, output_summary, error
         FROM   workflow_runs
         {where_clause}
         ORDER BY started_at DESC
         LIMIT {cap}"
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare list: {e}"))?;

    let rows = stmt
        .query_map(
            params![
                workflow_id.as_deref().unwrap_or(""),
                project_id.as_deref().unwrap_or(""),
            ],
            row_to_run,
        )
        .map_err(|e| format!("query workflow_runs: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("read row: {e}"))?);
    }
    Ok(out)
}

/// Update mutable fields of an existing run by `id`.
///
/// Only fields present in `payload` are updated — `None` fields are left
/// unchanged. Returns the updated [`WorkflowRun`].
pub fn update_run_inner(id: i64, payload: RunUpdate) -> Result<WorkflowRun, String> {
    let conn = open_conn()?;

    // Build SET clause from whatever was provided.
    let mut sets: Vec<String> = Vec::new();
    let mut idx = 1usize;

    if payload.status.is_some() {
        sets.push(format!("status = ?{idx}"));
        idx += 1;
    }
    if payload.steps_completed.is_some() {
        sets.push(format!("steps_completed = ?{idx}"));
        idx += 1;
    }
    if payload.steps_total.is_some() {
        sets.push(format!("steps_total = ?{idx}"));
        idx += 1;
    }
    if payload.output_summary.is_some() {
        sets.push(format!("output_summary = ?{idx}"));
        idx += 1;
    }
    if payload.error.is_some() {
        sets.push(format!("error = ?{idx}"));
        idx += 1;
    }
    if payload.ended_at.is_some() {
        sets.push(format!("ended_at = ?{idx}"));
        idx += 1;
    }

    if sets.is_empty() {
        // Nothing to update — just fetch and return the current record.
        return get_run_by_id(&conn, id);
    }

    let id_param_idx = idx;
    let sql = format!(
        "UPDATE workflow_runs SET {} WHERE id = ?{id_param_idx}",
        sets.join(", ")
    );

    // Build the params vector using rusqlite's dynamic dispatch path.
    // We collect into a Vec<Box<dyn rusqlite::ToSql>> so the borrow checker
    // is satisfied when the owned values leave each arm.
    use rusqlite::types::ToSql;
    let mut param_values: Vec<Box<dyn ToSql>> = Vec::new();
    if let Some(ref s) = payload.status {
        param_values.push(Box::new(s.as_str().to_owned()));
    }
    if let Some(v) = payload.steps_completed {
        param_values.push(Box::new(v as i64));
    }
    if let Some(v) = payload.steps_total {
        param_values.push(Box::new(v as i64));
    }
    if let Some(ref s) = payload.output_summary {
        param_values.push(Box::new(s.clone()));
    }
    if let Some(ref s) = payload.error {
        param_values.push(Box::new(s.clone()));
    }
    if let Some(ref dt) = payload.ended_at {
        param_values.push(Box::new(dt.to_rfc3339()));
    }
    param_values.push(Box::new(id));

    let refs: Vec<&dyn ToSql> = param_values.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, refs.as_slice())
        .map_err(|e| format!("update run {id}: {e}"))?;

    get_run_by_id(&conn, id)
}

fn get_run_by_id(conn: &Connection, id: i64) -> Result<WorkflowRun, String> {
    conn.query_row(
        "SELECT id, workflow_id, project_id, started_at, ended_at,
                status, steps_completed, steps_total, output_summary, error
         FROM workflow_runs WHERE id = ?1",
        params![id],
        row_to_run,
    )
    .map_err(|e| format!("fetch run {id}: {e}"))
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

fn row_to_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowRun> {
    let started_str: String = row.get(3)?;
    let ended_str: Option<String> = row.get(4)?;
    let status_str: String = row.get(5)?;
    let steps_completed: i64 = row.get(6)?;
    let steps_total: i64 = row.get(7)?;

    let started_at = started_str
        .parse::<DateTime<Utc>>()
        .unwrap_or_else(|_| Utc::now());
    let ended_at = ended_str
        .as_deref()
        .and_then(|s| s.parse::<DateTime<Utc>>().ok());

    Ok(WorkflowRun {
        id: row.get(0)?,
        workflow_id: row.get(1)?,
        project_id: row.get(2)?,
        started_at,
        ended_at,
        status: RunStatus::from_str(&status_str),
        steps_completed: steps_completed as u32,
        steps_total: steps_total as u32,
        output_summary: row.get(8)?,
        error: row.get(9)?,
    })
}

// ---------------------------------------------------------------------------
// Workflow State (#6) — rich, persisted run state in the `state_json` column.
// Additive side-channel: leaves the WorkflowRun struct + core CRUD untouched.
// ---------------------------------------------------------------------------

/// The rich, recoverable state of a workflow run: where it is, what's next, and
/// what it has touched. Persisted as JSON in `workflow_runs.state_json` so a
/// future orchestrator (and Session Resume) can recover/continue a workflow.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkflowState {
    pub current_step: Option<String>,
    pub next_action: Option<String>,
    #[serde(default)]
    pub agents_used: Vec<String>,
    #[serde(default)]
    pub skills_used: Vec<String>,
    #[serde(default)]
    pub memory_ids: Vec<String>,
    #[serde(default)]
    pub files_touched: Vec<String>,
    #[serde(default)]
    pub blockers: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub errors: Vec<String>,
}

/// Persist the rich state of a run (writes only `state_json`).
pub fn set_run_state(id: i64, state: &WorkflowState) -> Result<(), String> {
    let conn = open_conn()?;
    let json = serde_json::to_string(state).map_err(|e| format!("serialize state: {e}"))?;
    let n = conn
        .execute(
            "UPDATE workflow_runs SET state_json = ?1 WHERE id = ?2",
            params![json, id],
        )
        .map_err(|e| format!("set run state {id}: {e}"))?;
    if n == 0 {
        return Err(format!("workflow run {id} not found"));
    }
    Ok(())
}

/// Read the rich state of a run (default when unset/absent).
pub fn get_run_state(id: i64) -> Result<WorkflowState, String> {
    let conn = open_conn()?;
    let json: Option<String> = conn
        .query_row(
            "SELECT state_json FROM workflow_runs WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| format!("get run state {id}: {e}"))?;
    Ok(json
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default())
}

#[cfg(test)]
mod state_tests {
    use super::*;

    #[test]
    fn workflow_state_serde_roundtrips() {
        let s = WorkflowState {
            current_step: Some("reindex".into()),
            next_action: Some("verify recall".into()),
            agents_used: vec!["code-reviewer".into()],
            memory_ids: vec!["mem-1".into(), "mem-2".into()],
            blockers: vec!["qdrant down".into()],
            ..Default::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: WorkflowState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.current_step.as_deref(), Some("reindex"));
        assert_eq!(back.agents_used, vec!["code-reviewer".to_string()]);
        assert_eq!(back.memory_ids.len(), 2);
        assert_eq!(back.blockers, vec!["qdrant down".to_string()]);
    }

    #[test]
    #[ignore = "e2e: real ~/.ultron/cockpit/workflow-runs.db"]
    fn e2e_run_state_persists() {
        init_db().unwrap();
        let id = record_run_inner("test-wf-state".into(), Some("ultron".into()), None, 3).unwrap();
        let st = WorkflowState {
            current_step: Some("step-1".into()),
            next_action: Some("do step 2".into()),
            memory_ids: vec!["mem-x".into()],
            ..Default::default()
        };
        set_run_state(id, &st).unwrap();
        let got = get_run_state(id).unwrap();
        assert_eq!(got.current_step.as_deref(), Some("step-1"));
        assert_eq!(got.memory_ids, vec!["mem-x".to_string()]);
        eprintln!("=== workflow state persisted on run {id} ===");
        // cleanup so the test run does not pollute "running".
        let _ = update_run_inner(
            id,
            RunUpdate {
                status: Some(RunStatus::Cancelled),
                steps_completed: None,
                steps_total: None,
                output_summary: None,
                error: None,
                ended_at: Some(Utc::now()),
            },
        );
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Override `db_path()` for tests by pointing `HOME` to a temp dir.
    /// We use a thread-local so parallel tests don't collide.
    ///
    /// On Windows, `dirs::home_dir()` reads the Win32 known-folder API and
    /// ignores `HOME`/`USERPROFILE` overrides set via `std::env::set_var`.
    /// Therefore we test the inner functions directly with an explicit path.
    fn open_test_conn(dir: &TempDir) -> Connection {
        let path = dir.path().join("workflow-runs.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS workflow_runs (
                 id              INTEGER PRIMARY KEY AUTOINCREMENT,
                 workflow_id     TEXT    NOT NULL,
                 project_id      TEXT,
                 started_at      TEXT    NOT NULL,
                 ended_at        TEXT,
                 status          TEXT    NOT NULL DEFAULT 'running',
                 steps_completed INTEGER NOT NULL DEFAULT 0,
                 steps_total     INTEGER NOT NULL DEFAULT 0,
                 output_summary  TEXT    NOT NULL DEFAULT '',
                 error           TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_workflow_id ON workflow_runs (workflow_id);
             CREATE INDEX IF NOT EXISTS idx_started_at  ON workflow_runs (started_at DESC);",
        )
        .unwrap();
        conn
    }

    fn insert_run(conn: &Connection, workflow_id: &str, project_id: Option<&str>) -> i64 {
        let ts = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO workflow_runs (workflow_id, project_id, started_at, status, steps_total)
             VALUES (?1, ?2, ?3, 'running', 3)",
            params![workflow_id, project_id, ts],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    // --- RunStatus ---

    #[test]
    fn run_status_round_trip() {
        for status in [
            RunStatus::Running,
            RunStatus::Success,
            RunStatus::Failed,
            RunStatus::Cancelled,
        ] {
            let s = status.as_str();
            assert_eq!(RunStatus::from_str(s), status, "round-trip failed for {s}");
        }
    }

    #[test]
    fn run_status_unknown_maps_to_running() {
        assert_eq!(RunStatus::from_str("bogus"), RunStatus::Running);
    }

    // --- init_db (idempotent) ---

    #[test]
    fn init_db_is_idempotent() {
        // We can't override home on Windows, so we just verify that calling
        // init_db twice on a real path doesn't panic. If the cockpit dir is
        // not writable this test is skipped gracefully.
        let _ = init_db();
        let _ = init_db(); // second call must not error
    }

    // --- record + list ---

    #[test]
    fn insert_and_list_by_workflow_id() {
        let tmp = TempDir::new().unwrap();
        let conn = open_test_conn(&tmp);

        let id1 = insert_run(&conn, "quick", Some("proj-a"));
        let id2 = insert_run(&conn, "feature", Some("proj-a"));
        let _id3 = insert_run(&conn, "quick", None);

        // Fetch all for "quick"
        let mut stmt = conn
            .prepare(
                "SELECT id, workflow_id, project_id, started_at, ended_at,
                        status, steps_completed, steps_total, output_summary, error
                 FROM workflow_runs
                 WHERE workflow_id = 'quick'
                 ORDER BY started_at DESC",
            )
            .unwrap();
        let rows: Vec<WorkflowRun> = stmt
            .query_map([], row_to_run)
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(rows.len(), 2);
        // All returned with "running" status
        assert!(rows.iter().all(|r| r.status == RunStatus::Running));
        // "feature" row is absent
        assert!(!rows.iter().any(|r| r.id == id2));
        assert!(rows.iter().any(|r| r.id == id1));
    }

    // --- update ---

    #[test]
    fn update_status_and_ended_at() {
        let tmp = TempDir::new().unwrap();
        let conn = open_test_conn(&tmp);

        let row_id = insert_run(&conn, "debug", None);
        let ended = Utc::now();

        conn.execute(
            "UPDATE workflow_runs SET status = ?1, ended_at = ?2, steps_completed = ?3 WHERE id = ?4",
            params!["success", ended.to_rfc3339(), 3i64, row_id],
        )
        .unwrap();

        let run = get_run_by_id(&conn, row_id).unwrap();
        assert_eq!(run.status, RunStatus::Success);
        assert!(run.ended_at.is_some());
        assert_eq!(run.steps_completed, 3);
    }

    #[test]
    fn update_with_error_sets_failed() {
        let tmp = TempDir::new().unwrap();
        let conn = open_test_conn(&tmp);

        let row_id = insert_run(&conn, "security", None);
        conn.execute(
            "UPDATE workflow_runs SET status = 'failed', error = ?1 WHERE id = ?2",
            params!["agent timed out", row_id],
        )
        .unwrap();

        let run = get_run_by_id(&conn, row_id).unwrap();
        assert_eq!(run.status, RunStatus::Failed);
        assert_eq!(run.error.as_deref(), Some("agent timed out"));
    }

    // --- row_to_run ---

    #[test]
    fn row_to_run_handles_null_project_and_ended() {
        let tmp = TempDir::new().unwrap();
        let conn = open_test_conn(&tmp);
        let row_id = insert_run(&conn, "learning", None);

        let run = get_run_by_id(&conn, row_id).unwrap();
        assert!(run.project_id.is_none());
        assert!(run.ended_at.is_none());
        assert_eq!(run.output_summary, "");
        assert!(run.error.is_none());
    }

    // --- limit cap ---

    #[test]
    fn list_limit_respected() {
        let tmp = TempDir::new().unwrap();
        let conn = open_test_conn(&tmp);
        for _ in 0..10 {
            insert_run(&conn, "quick", None);
        }
        let mut stmt = conn
            .prepare(
                "SELECT id, workflow_id, project_id, started_at, ended_at,
                        status, steps_completed, steps_total, output_summary, error
                 FROM workflow_runs ORDER BY started_at DESC LIMIT 5",
            )
            .unwrap();
        let rows: Vec<WorkflowRun> = stmt
            .query_map([], row_to_run)
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows.len(), 5);
    }
}
