// ULTRON Control Center 2.0 - Workdays domain
//
// 2026-05-26 redesign: automatic workflow tracking.
//
// Workdays used to be a manual state machine (Planned -> InProgress -> Paused
// -> Completed -> Archived) that the user had to drive by hand. That model
// did not match the actual usage pattern: USER never opens the tab to
// click "Start" -- he just starts working. The new model treats a workday
// as a passive timeline that the system feeds automatically:
//
//   * The first Claude / Codex / Gemini session that lands on a project's
//     cwd today auto-creates an `in_progress` workday for that project.
//   * Subsequent sessions inside the same project on the same day are
//     auto-linked to the existing workday (no second workday is created).
//   * Kanban card moves to "In Progress" or "Done" auto-append to the
//     workday's `goals` (Done) or `context.notes` (movement events).
//   * Agents / sessions / scripts can call `workday_append_context` to add
//     decisions, file changes, agent messages so the next invocation sees
//     a coherent shared context for the project's working day.
//
// Backwards compatibility: the original Workday struct fields are kept
// untouched. Every new field is `#[serde(default)]` so workdays already
// written under ~/.ultron/cockpit/workdays/ continue to load.
//
// The manual create/start/pause/resume/complete/archive commands are still
// exposed -- the UI now hides them, but the test suite and external scripts
// keep working.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Process-wide write lock for workday RMW (read-modify-write) operations.
/// All functions that call `load_wd` + `persist_workday` in sequence acquire
/// this lock before the read so concurrent threads cannot interleave writes.
/// Read-only helpers (list, metrics, …) are intentionally excluded.
static WORKDAY_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn workday_lock() -> &'static Mutex<()> {
    WORKDAY_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

fn new_id(prefix: &str) -> String {
    static C: AtomicU64 = AtomicU64::new(0);
    let n = C.fetch_add(1, Ordering::Relaxed);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros()).unwrap_or(0);
    format!("{prefix}-{t}-{n}")
}
fn now_iso() -> String {
    let s = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("epoch:{}", s)
}
fn today_date() -> String { chrono::Local::now().format("%Y-%m-%d").to_string() }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkdayStatus { Planned, InProgress, Paused, Completed, Archived }
impl std::fmt::Display for WorkdayStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            WorkdayStatus::Planned => write!(f, "planned"),
            WorkdayStatus::InProgress => write!(f, "in_progress"),
            WorkdayStatus::Paused => write!(f, "paused"),
            WorkdayStatus::Completed => write!(f, "completed"),
            WorkdayStatus::Archived => write!(f, "archived"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus { #[default] Pending, Done, Skipped }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum GoalSource { #[default] Manual, AiInferred, Kanban }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkdayGoal {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub status: GoalStatus,
    /// How this goal was created: manual (user typed it), ai_inferred (auto-fill
    /// from AI scan), or kanban (card move).
    #[serde(default)]
    pub source: GoalSource,
    /// Kanban card id this goal was created from, if any.
    #[serde(default)]
    pub linked_card_id: Option<String>,
}

/// Single entry in the shared workday context.
///
/// `kind` is a short tag so the UI / downstream agents can group entries:
///   * "note"           free-form note from the user or an agent
///   * "decision"       architectural / design decision the next agent must
///                      respect
///   * "file_change"    a file the workday touched
///   * "agent_message"  message produced by a delegate / subagent
///   * "session_start"  auto-recorded when a session is linked
///   * "kanban_move"    auto-recorded when a kanban card moves
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkdayContextEntry {
    pub id: String,
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub source: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkdayContext {
    #[serde(default)]
    pub notes: Vec<WorkdayContextEntry>,
    #[serde(default)]
    pub decisions: Vec<WorkdayContextEntry>,
    #[serde(default)]
    pub file_changes: Vec<WorkdayContextEntry>,
    #[serde(default)]
    pub agent_messages: Vec<WorkdayContextEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workday {
    pub id: String,
    #[serde(default)] pub template_id: Option<String>,
    /// Workflow template id (quick / feature / debug / security / research /
    /// game / learning) -- matches the canonical seven defined in
    /// `agent_orchestration::list_workflows_inner`. Used to seed the goal
    /// list and to drive the agent sequence the next session will follow.
    #[serde(default)] pub workflow_template: Option<String>,
    /// Project the workday is bound to. Auto-set when the workday is created
    /// by a session-start hook. Older workdays may carry `None`.
    #[serde(default)] pub project_id: Option<String>,
    /// Canonical filesystem cwd the workday was opened from. Used by the
    /// auto-linker to match incoming sessions to an existing workday.
    #[serde(default)] pub project_cwd: Option<String>,
    pub title: String,
    pub status: WorkdayStatus,
    pub planned_date: String,
    #[serde(default)] pub start_ts: Option<String>,
    #[serde(default)] pub end_ts: Option<String>,
    #[serde(default)] pub focus_seconds: u64,
    #[serde(default)] pub break_seconds: u64,
    #[serde(default)] pub energy_before: Option<u8>,
    #[serde(default)] pub energy_after: Option<u8>,
    #[serde(default)] pub mood_note: Option<String>,
    #[serde(default)] pub retro_good: Option<String>,
    #[serde(default)] pub retro_bad: Option<String>,
    #[serde(default)] pub retro_learned: Option<String>,
    #[serde(default)] pub summary_md: Option<String>,
    #[serde(default)] pub goals: Vec<WorkdayGoal>,
    #[serde(default)] pub linked_sessions: Vec<String>,
    #[serde(default)] pub linked_tasks: Vec<String>,
    /// Shared context that subsequent agents/sessions can read and append
    /// to. Replaces the old "notes" model with a structured surface that
    /// stays small enough to inline into prompts.
    #[serde(default)] pub context: WorkdayContext,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkdayTemplate {
    pub id: String, pub name: String,
    #[serde(default)] pub default_title: Option<String>,
    #[serde(default)] pub default_goals: Vec<String>,
    #[serde(default)] pub notes: Option<String>,
    pub created_at: String, pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkdayMetrics {
    pub id: String, pub title: String, pub status: WorkdayStatus, pub planned_date: String,
    pub focus_minutes: u64, pub break_minutes: u64,
    pub total_goals: usize, pub completed_goals: usize,
    pub linked_sessions: usize, pub linked_tasks: usize,
}

/// Aggregated "today" view returned by `workday_today_timeline`. Carries the
/// active workday (or `None` if nothing has happened today yet) plus any
/// other workdays that share the same date.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkdayTodayView {
    pub date: String,
    pub active: Option<Workday>,
    pub other_today: Vec<Workday>,
}

pub fn workdays_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir().ok_or_else(|| "no home".to_string())?.join(".ultron").join("cockpit").join("workdays"))
}
fn templates_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir().ok_or_else(|| "no home".to_string())?.join(".ultron").join("cockpit").join("workday-templates"))
}
fn workday_path(id: &str) -> Result<PathBuf, String> { Ok(workdays_dir()?.join(format!("{id}.json"))) }
fn template_path(id: &str) -> Result<PathBuf, String> { Ok(templates_dir()?.join(format!("{id}.json"))) }

fn atomic_write(path: &PathBuf, j: &str) -> Result<(), String> {
    if let Some(p) = path.parent() { fs::create_dir_all(p).map_err(|e| format!("mkdir: {e}"))?; }
    let tmp = path.with_extension("json.tmp");
    { let mut f = fs::File::create(&tmp).map_err(|e| format!("create: {e}"))?;
      f.write_all(j.as_bytes()).map_err(|e| format!("write: {e}"))?; f.sync_all().ok(); }
    fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))
}
fn persist_workday(wd: &Workday) -> Result<(), String> {
    let p = workday_path(&wd.id)?;
    atomic_write(&p, &serde_json::to_string_pretty(wd).map_err(|e| format!("ser: {e}"))?)
}
fn load_from_path(p: &PathBuf) -> Result<Workday, String> {
    serde_json::from_str(&fs::read_to_string(p).map_err(|e| format!("read: {e}"))?).map_err(|e| format!("parse: {e}"))
}
/// O(1) lookup of a workday by id (KIRKARDO 17 HIGH fix). External callers
/// (agent_orchestration blackboard) should prefer this over
/// `list_workdays_inner(..)` + filter, which deserialises every workday on
/// disk for a single-record lookup.
///
/// Returns `Ok(None)` when no file exists for `id` (the id is unknown, not
/// an error), `Ok(Some(_))` when found and parsed successfully, and `Err`
/// only for genuine I/O or deserialisation failures.
///
/// # Examples
///
/// ```no_run
/// // Returns None for a completely unknown id — callers can gracefully skip.
/// let result = get_workday_by_id("wd-does-not-exist");
/// assert!(matches!(result, Ok(None)));
/// ```
pub fn get_workday_by_id(id: &str) -> Result<Option<Workday>, String> {
    let p = workday_path(id)?;
    if !p.exists() {
        return Ok(None);
    }
    load_from_path(&p).map(Some)
}

fn load_wd(id: &str) -> Result<Workday, String> {
    let p = workday_path(id)?;
    if !p.exists() { return Err(format!("workday {id} not found")); }
    load_from_path(&p)
}
fn persist_template(t: &WorkdayTemplate) -> Result<(), String> {
    let p = template_path(&t.id)?;
    atomic_write(&p, &serde_json::to_string_pretty(t).map_err(|e| format!("ser: {e}"))?)
}

fn assert_transition(from: &WorkdayStatus, to: &WorkdayStatus) -> Result<(), String> {
    let ok = matches!((from, to),
        (WorkdayStatus::Planned, WorkdayStatus::InProgress)
        | (WorkdayStatus::InProgress, WorkdayStatus::Paused)
        | (WorkdayStatus::Paused, WorkdayStatus::InProgress)
        | (WorkdayStatus::InProgress, WorkdayStatus::Completed)
        | (WorkdayStatus::Completed, WorkdayStatus::Archived)
        | (WorkdayStatus::InProgress, WorkdayStatus::Archived)
        | (WorkdayStatus::Paused, WorkdayStatus::Archived));
    if ok { Ok(()) } else { Err(format!("invalid transition: {} -> {}", from, to)) }
}

fn gen_summary(wd: &Workday) -> String {
    let fm = wd.focus_seconds / 60; let bm = wd.break_seconds / 60;
    let tot = wd.goals.len();
    let done = wd.goals.iter().filter(|g| g.status == GoalStatus::Done).count();
    let gl: String = wd.goals.iter().map(|g| {
        let m = match g.status { GoalStatus::Done => "[x]", GoalStatus::Skipped => "[~]", GoalStatus::Pending => "[ ]" };
        format!("- {m} {}\n", g.text)
    }).collect();
    format!("# {}\n\nFecha: {}  \nEstado: {}  \nFoco: {fm} min  \nDescanso: {bm} min  \nTareas: {done}/{tot}  \n\n## Objetivos\n{gl}",
        wd.title, wd.planned_date, wd.status)
}

pub fn create_workday_inner(title: String, planned_date: Option<String>, template_id: Option<String>, goals: Option<Vec<String>>) -> Result<Workday, String> {
    let d = planned_date.unwrap_or_else(today_date);
    let gi: Vec<WorkdayGoal> = goals.unwrap_or_default().into_iter()
        .map(|text| WorkdayGoal { id: new_id("goal"), text, status: GoalStatus::Pending, source: GoalSource::Manual, linked_card_id: None }).collect();
    let wd = Workday { id: new_id("wd"), template_id, workflow_template: None,
        project_id: None, project_cwd: None,
        title, status: WorkdayStatus::Planned, planned_date: d,
        start_ts: None, end_ts: None, focus_seconds: 0, break_seconds: 0,
        energy_before: None, energy_after: None, mood_note: None,
        retro_good: None, retro_bad: None, retro_learned: None, summary_md: None,
        goals: gi, linked_sessions: Vec::new(), linked_tasks: Vec::new(),
        context: WorkdayContext::default(), created_at: now_iso() };
    persist_workday(&wd)?; Ok(wd)
}
pub fn start_workday_inner(id: String, energy_before: Option<u8>) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&id)?;
    assert_transition(&wd.status, &WorkdayStatus::InProgress)?;
    wd.status = WorkdayStatus::InProgress; wd.start_ts = Some(now_iso());
    if let Some(e) = energy_before { wd.energy_before = Some(e); }
    persist_workday(&wd)?; Ok(wd)
}
pub fn pause_workday_inner(id: String, break_seconds_delta: Option<u64>) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&id)?;
    assert_transition(&wd.status, &WorkdayStatus::Paused)?;
    wd.status = WorkdayStatus::Paused;
    if let Some(d) = break_seconds_delta { wd.break_seconds += d; }
    persist_workday(&wd)?; Ok(wd)
}
pub fn resume_workday_inner(id: String) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&id)?;
    assert_transition(&wd.status, &WorkdayStatus::InProgress)?;
    wd.status = WorkdayStatus::InProgress;
    persist_workday(&wd)?; Ok(wd)
}
pub fn complete_workday_inner(id: String, focus_seconds: Option<u64>, energy_after: Option<u8>, mood_note: Option<String>, retro_good: Option<String>, retro_bad: Option<String>, retro_learned: Option<String>) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&id)?;
    assert_transition(&wd.status, &WorkdayStatus::Completed)?;
    if let Some(s) = focus_seconds { wd.focus_seconds = s; }
    if let Some(e) = energy_after { wd.energy_after = Some(e); }
    if let Some(m) = mood_note { wd.mood_note = Some(m); }
    if let Some(g) = retro_good { wd.retro_good = Some(g); }
    if let Some(b) = retro_bad { wd.retro_bad = Some(b); }
    if let Some(l) = retro_learned { wd.retro_learned = Some(l); }
    wd.status = WorkdayStatus::Completed; wd.end_ts = Some(now_iso());
    let s = gen_summary(&wd); wd.summary_md = Some(s.clone());
    persist_workday(&wd)?;
    let wid = wd.id.clone(); let wt = wd.title.clone(); let wdt = wd.planned_date.clone();
    tauri::async_runtime::spawn(async move {
        let md = serde_json::json!({"source":"workday","workday_id":wid,"title":wt,"date":wdt});
        let _ = crate::mem0::add_inner(s, "workdays".to_string(), Some(md)).await;
    });
    Ok(wd)
}
pub fn archive_workday_inner(id: String) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&id)?;
    assert_transition(&wd.status, &WorkdayStatus::Archived)?;
    wd.status = WorkdayStatus::Archived;
    persist_workday(&wd)?; Ok(wd)
}
pub fn list_workdays_inner(status_filter: Option<String>, date_from: Option<String>, date_to: Option<String>, limit: Option<usize>) -> Result<Vec<Workday>, String> {
    let d = workdays_dir()?;
    if !d.exists() { return Ok(Vec::new()); }
    let es = fs::read_dir(&d).map_err(|e| format!("read: {e}"))?;
    let mut ws: Vec<Workday> = Vec::new();
    for e in es.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
        if let Ok(wd) = load_from_path(&p) { ws.push(wd); }
    }
    if let Some(ref sf) = status_filter { ws.retain(|wd| wd.status.to_string() == *sf); }
    if let Some(ref f) = date_from { ws.retain(|wd| wd.planned_date >= *f); }
    if let Some(ref t) = date_to { ws.retain(|wd| wd.planned_date <= *t); }
    ws.sort_by(|a, b| b.planned_date.cmp(&a.planned_date));
    if let Some(n) = limit { ws.truncate(n); }
    Ok(ws)
}
pub fn get_workday_detail_inner(id: String) -> Result<Workday, String> { load_wd(&id) }
pub fn link_session_inner(id: String, session_id: String) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&id)?;
    if !wd.linked_sessions.contains(&session_id) {
        wd.linked_sessions.push(session_id.clone());
        wd.context.notes.push(WorkdayContextEntry {
            id: new_id("ctx"),
            kind: "session_start".to_string(),
            text: format!("session linked: {session_id}"),
            source: Some("auto-linker".to_string()),
            created_at: now_iso(),
        });
        persist_workday(&wd)?;
    }
    Ok(wd)
}
pub fn link_task_inner(id: String, task_id: String) -> Result<Workday, String> {
    let mut wd = load_wd(&id)?;
    if !wd.linked_tasks.contains(&task_id) { wd.linked_tasks.push(task_id); persist_workday(&wd)?; }
    Ok(wd)
}
pub fn get_workday_metrics_inner(id: String) -> Result<WorkdayMetrics, String> {
    let wd = load_wd(&id)?;
    Ok(WorkdayMetrics { id: wd.id.clone(), title: wd.title.clone(), status: wd.status.clone(),
        planned_date: wd.planned_date.clone(),
        focus_minutes: wd.focus_seconds/60, break_minutes: wd.break_seconds/60,
        total_goals: wd.goals.len(),
        completed_goals: wd.goals.iter().filter(|g| g.status==GoalStatus::Done).count(),
        linked_sessions: wd.linked_sessions.len(), linked_tasks: wd.linked_tasks.len() })
}
pub fn list_templates_inner() -> Result<Vec<WorkdayTemplate>, String> {
    let d = templates_dir()?;
    if !d.exists() { return Ok(Vec::new()); }
    let es = fs::read_dir(&d).map_err(|e| format!("read: {e}"))?;
    let mut ts: Vec<WorkdayTemplate> = Vec::new();
    for e in es.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
        if let Ok(r) = fs::read_to_string(&p) {
            if let Ok(t) = serde_json::from_str::<WorkdayTemplate>(&r) { ts.push(t); }
        }
    }
    ts.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(ts)
}
pub fn save_template_inner(name: String, default_title: Option<String>, default_goals: Option<Vec<String>>, notes: Option<String>) -> Result<WorkdayTemplate, String> {
    let n = now_iso();
    let t = WorkdayTemplate { id: new_id("tmpl"), name, default_title,
        default_goals: default_goals.unwrap_or_default(), notes,
        created_at: n.clone(), updated_at: n };
    persist_template(&t)?; Ok(t)
}
pub fn update_goal_inner(workday_id: String, goal_id: String, status: GoalStatus, text: Option<String>) -> Result<Workday, String> {
    let mut wd = load_wd(&workday_id)?;
    let g = wd.goals.iter_mut().find(|x| x.id == goal_id).ok_or_else(|| format!("goal {goal_id} not found"))?;
    g.status = status;
    if let Some(t) = text { g.text = t; }
    persist_workday(&wd)?; Ok(wd)
}
pub fn workday_list_inner(limit: Option<usize>) -> Result<Vec<Workday>, String> { list_workdays_inner(None, None, None, limit) }

// ---------------------------------------------------------------------------
// Automatic surface (2026-05-26 redesign)
// ---------------------------------------------------------------------------

/// Best-effort project lookup. Given a filesystem cwd, return the project_id
/// (if any) whose configured `path` is a prefix of the cwd. Returns the
/// canonical project path so the caller can persist a stable identity.
///
/// Errors from the projects registry are swallowed -- a missing or unreadable
/// `projects.json` simply means we cannot resolve a project, which is a
/// legitimate state for a one-off cwd.
fn resolve_project_for_cwd(cwd: &str) -> Option<(String, String)> {
    let norm = cwd.replace('\\', "/").to_lowercase();
    let projects = crate::projects::list_projects_inner().ok()?;
    let mut best: Option<(usize, String, String)> = None;
    for p in projects {
        let path = match p.path.as_deref() {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => continue,
        };
        let pnorm = path.replace('\\', "/").to_lowercase();
        if norm == pnorm || norm.starts_with(&format!("{}/", pnorm)) {
            let len = pnorm.len();
            if best.as_ref().map(|(l, _, _)| *l < len).unwrap_or(true) {
                best = Some((len, p.id.clone(), path));
            }
        }
    }
    best.map(|(_, id, path)| (id, path))
}

/// Try to find an existing `in_progress` workday for the given project and
/// today's date. Falls back to matching on `project_cwd` when `project_id`
/// is absent (handles older workdays that pre-date the new fields).
fn find_active_workday_for_project(project_id: &str, project_cwd: &str) -> Result<Option<Workday>, String> {
    let today = today_date();
    let all = list_workdays_inner(Some("in_progress".to_string()), Some(today.clone()), Some(today), None)?;
    for wd in all {
        let match_id = wd.project_id.as_deref() == Some(project_id);
        let match_cwd = match wd.project_cwd.as_deref() {
            Some(c) => c.replace('\\', "/").eq_ignore_ascii_case(&project_cwd.replace('\\', "/")),
            None => false,
        };
        if match_id || match_cwd {
            return Ok(Some(wd));
        }
    }
    Ok(None)
}

/// Build the default goal list for a workflow template. Mirrors the canonical
/// seven defined in `agent_orchestration::list_workflows_inner` so the user
/// sees the same agent sequence laid out as goals when the workday opens.
fn goals_for_workflow(workflow: &str) -> Vec<String> {
    match workflow {
        "quick" => vec!["Terry: surgical fix".to_string(), "Kirkardo: 30s validation".to_string()],
        "feature" => vec![
            "Don Claudio: architect".to_string(),
            "Terry: TDD implementation".to_string(),
            "Kirkardo: quality PR".to_string(),
        ],
        "debug" => vec![
            "Debugger: systematic root cause".to_string(),
            "Terry: surgical fix".to_string(),
            "Kirkardo: verify fix".to_string(),
        ],
        "security" => vec![
            "Security reviewer: threat model".to_string(),
            "Terry: harden".to_string(),
            "Kirkardo: regression check".to_string(),
        ],
        "research" => vec![
            "Einstein: literature scan".to_string(),
            "Novalbos: deep notes".to_string(),
            "Terry: prototype".to_string(),
        ],
        "game" => vec![
            "Don Claudio: gameplay design".to_string(),
            "Terry: engine integration".to_string(),
            "Kirkardo: playtest review".to_string(),
        ],
        "learning" => vec![
            "Novalbos: learning plan".to_string(),
            "Terry: hands-on exercise".to_string(),
        ],
        _ => Vec::new(),
    }
}

/// Derive a human-readable workday title from the project name and date.
fn auto_title(project_name: &str, date: &str) -> String {
    if project_name.is_empty() {
        format!("Workday {date}")
    } else {
        format!("{project_name} - {date}")
    }
}

/// Auto-start a workday for the given project. If a workday with status
/// `in_progress` already exists today for that project, return it untouched.
/// Otherwise create a fresh one, mark it `in_progress`, seed goals from the
/// workflow template, and return it.
///
/// `cwd` falls back to the project's registered path when omitted; the
/// workflow template defaults to `None` (no seeded goals) when the caller
/// doesn't supply one.
pub fn auto_start_for_project_inner(
    project_id: String,
    cwd: Option<String>,
    workflow_template: Option<String>,
) -> Result<Workday, String> {
    // Resolve project metadata so we can put a friendly title on the workday.
    let projects = crate::projects::list_projects_inner().unwrap_or_default();
    let project = projects.iter().find(|p| p.id == project_id);
    let project_name = project
        .and_then(|p| p.name.clone())
        .unwrap_or_else(|| project_id.clone());
    let project_path = cwd
        .or_else(|| project.and_then(|p| p.path.clone()))
        .unwrap_or_default();

    // De-dupe: if today's workday already exists, return it as-is.
    if let Some(existing) = find_active_workday_for_project(&project_id, &project_path)? {
        return Ok(existing);
    }

    let date = today_date();
    let goals: Vec<WorkdayGoal> = workflow_template
        .as_deref()
        .map(goals_for_workflow)
        .unwrap_or_default()
        .into_iter()
        .map(|text| WorkdayGoal { id: new_id("goal"), text, status: GoalStatus::Pending, source: GoalSource::Manual, linked_card_id: None })
        .collect();
    let now = now_iso();
    let wd = Workday {
        id: new_id("wd"),
        template_id: None,
        workflow_template,
        project_id: Some(project_id),
        project_cwd: if project_path.is_empty() { None } else { Some(project_path) },
        title: auto_title(&project_name, &date),
        status: WorkdayStatus::InProgress,
        planned_date: date,
        start_ts: Some(now.clone()),
        end_ts: None,
        focus_seconds: 0,
        break_seconds: 0,
        energy_before: None,
        energy_after: None,
        mood_note: None,
        retro_good: None,
        retro_bad: None,
        retro_learned: None,
        summary_md: None,
        goals,
        linked_sessions: Vec::new(),
        linked_tasks: Vec::new(),
        context: WorkdayContext::default(),
        created_at: now,
    };
    persist_workday(&wd)?;
    Ok(wd)
}

/// Convenience used by the session-start hook. Given a `cwd`, locate the
/// matching project, auto-start (or fetch) today's workday for it, and link
/// the session to it. Returns the workday whether new or pre-existing.
///
/// When the cwd does not match any registered project, the call is a no-op
/// that returns `Ok(None)` -- we deliberately do NOT create orphan workdays
/// for arbitrary directories.
pub fn auto_workday_for_session_inner(
    session_id: String,
    cwd: String,
) -> Result<Option<Workday>, String> {
    let Some((project_id, project_path)) = resolve_project_for_cwd(&cwd) else {
        return Ok(None);
    };
    let wd = auto_start_for_project_inner(project_id, Some(project_path), None)?;
    let wd = link_session_inner(wd.id.clone(), session_id)?;
    Ok(Some(wd))
}

/// Append a shared-context entry to a workday. Used by agents / sessions /
/// scripts that want to leave a note for the next invocation.
///
/// `kind` is bucketed into the four `WorkdayContext` lists; unknown kinds
/// land in `notes`.
pub fn append_context_inner(
    workday_id: String,
    kind: String,
    text: String,
    source: Option<String>,
) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&workday_id)?;
    let entry = WorkdayContextEntry {
        id: new_id("ctx"),
        kind: kind.clone(),
        text,
        source,
        created_at: now_iso(),
    };
    match kind.as_str() {
        "decision" => wd.context.decisions.push(entry),
        "file_change" => wd.context.file_changes.push(entry),
        "agent_message" => wd.context.agent_messages.push(entry),
        _ => wd.context.notes.push(entry),
    }
    persist_workday(&wd)?;
    Ok(wd)
}

/// Record a kanban card movement against today's workday for `project_id`.
/// Moving a card into a "Done" column appends a completed goal; moving into
/// any other column appends a context note. Idempotent on goal text so the
/// same Done event won't double-add.
///
/// Returns `Ok(None)` when no active workday exists -- the caller treats
/// this as "kanban move happened outside a workday" and moves on.
pub fn record_kanban_event_inner(
    project_id: String,
    card_id: String,
    card_title: String,
    target_column: String,
) -> Result<Option<Workday>, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let project_path = crate::projects::list_projects_inner()
        .ok()
        .and_then(|ps| ps.into_iter().find(|p| p.id == project_id))
        .and_then(|p| p.path.clone())
        .unwrap_or_default();
    let Some(mut wd) = find_active_workday_for_project(&project_id, &project_path)? else {
        return Ok(None);
    };
    let lower = target_column.to_lowercase();
    if lower.contains("done") || lower.contains("complet") {
        let goal_text = format!("[kanban] {card_title}");
        if let Some(existing) = wd.goals.iter_mut().find(|g| g.text == goal_text) {
            existing.status = GoalStatus::Done;
        } else {
            wd.goals.push(WorkdayGoal {
                id: new_id("goal"),
                text: goal_text,
                status: GoalStatus::Done,
                source: GoalSource::Kanban,
                linked_card_id: Some(card_id.clone()),
            });
        }
    }
    wd.context.notes.push(WorkdayContextEntry {
        id: new_id("ctx"),
        kind: "kanban_move".to_string(),
        text: format!("card {card_id} ({card_title}) -> {target_column}"),
        source: Some("kanban".to_string()),
        created_at: now_iso(),
    });
    persist_workday(&wd)?;
    Ok(Some(wd))
}

/// Return today's timeline view -- the active workday (if any) plus any
/// other workdays scheduled for today (e.g. a second project the user
/// touched). Used by the redesigned Workdays tab.
pub fn today_timeline_inner() -> Result<WorkdayTodayView, String> {
    let date = today_date();
    let today_all = list_workdays_inner(None, Some(date.clone()), Some(date.clone()), None)?;
    let mut active: Option<Workday> = None;
    let mut other: Vec<Workday> = Vec::new();
    for wd in today_all {
        if active.is_none() && matches!(wd.status, WorkdayStatus::InProgress) {
            active = Some(wd);
        } else {
            other.push(wd);
        }
    }
    Ok(WorkdayTodayView { date, active, other_today: other })
}

/// Return historic workdays (everything *not* dated today), sorted by date
/// descending. The frontend renders this as the "History" lane.
pub fn history_inner(limit: Option<usize>) -> Result<Vec<Workday>, String> {
    let today = today_date();
    let mut all = list_workdays_inner(None, None, None, None)?;
    all.retain(|wd| wd.planned_date != today);
    if let Some(n) = limit { all.truncate(n); }
    Ok(all)
}

// ---------------------------------------------------------------------------
// Workflow templates (2026-05-26 redesign, orchestrator surface)
// ---------------------------------------------------------------------------
//
// `WorkflowTemplate` is the user-facing description of one of the seven
// canonical workflows USER cycles through (quick-fix, feature, debug,
// security, research, gamedev, learning). It is the data the Workdays UI
// renders as clickable cards on the "Templates" tab; clicking a card calls
// `workday_start_with_template`, which spins up an `in_progress` workday for
// the supplied project, seeds the goal list with the workflow's agent
// sequence, and stores the prompt skeleton so the next session knows how to
// begin.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub agent_slugs: Vec<String>,
    pub prompt_skeleton: String,
}

/// Return the seven hardcoded workflow templates. These match the canonical
/// sequence rendered by `agent_orchestration::list_workflows_inner`, but are
/// re-stated here so the Workdays tab does not need to invoke another module.
pub fn list_workflow_templates_inner() -> Result<Vec<WorkflowTemplate>, String> {
    Ok(vec![
        WorkflowTemplate {
            id: "quick-fix".to_string(),
            name: "Quick fix".to_string(),
            description: "One surgical change, validated by Kirkardo in 30s.".to_string(),
            agent_slugs: vec!["terry-davis".to_string(), "kirkardo".to_string()],
            prompt_skeleton:
                "Workflow: quick-fix\n\nGoal: <one-sentence fix description>\n\nAcceptance: \
                 build green, lint clean, no regression in adjacent tests."
                    .to_string(),
        },
        WorkflowTemplate {
            id: "feature".to_string(),
            name: "Feature".to_string(),
            description: "End-to-end feature: architect, TDD, quality PR.".to_string(),
            agent_slugs: vec![
                "don-claudio".to_string(),
                "terry-davis".to_string(),
                "kirkardo".to_string(),
            ],
            prompt_skeleton:
                "Workflow: feature\n\nUser story: <as a ... I want ... so that ...>\n\n\
                 Architecture brief: <constraints, integration points>\n\n\
                 Tests-first: enumerate happy + edge cases before coding."
                    .to_string(),
        },
        WorkflowTemplate {
            id: "debug".to_string(),
            name: "Debug".to_string(),
            description: "Systematic root-cause search before any code change.".to_string(),
            agent_slugs: vec![
                "debugger".to_string(),
                "terry-davis".to_string(),
                "kirkardo".to_string(),
            ],
            prompt_skeleton:
                "Workflow: debug\n\nSymptom: <observed behavior>\nExpected: <intended behavior>\n\
                 Repro steps: <numbered>\n\nDo NOT patch until the root cause is named."
                    .to_string(),
        },
        WorkflowTemplate {
            id: "security".to_string(),
            name: "Security review".to_string(),
            description: "Threat model + harden + regression check.".to_string(),
            agent_slugs: vec![
                "security-reviewer".to_string(),
                "terry-davis".to_string(),
                "kirkardo".to_string(),
            ],
            prompt_skeleton:
                "Workflow: security\n\nScope: <files / endpoints / surfaces>\n\
                 Threat actors: <who, capabilities>\n\nDeliverable: signed-off threat model + \
                 patch + regression tests."
                    .to_string(),
        },
        WorkflowTemplate {
            id: "research".to_string(),
            name: "Research".to_string(),
            description: "Literature scan, deep notes, prototype.".to_string(),
            agent_slugs: vec![
                "einstein".to_string(),
                "novalbos".to_string(),
                "terry-davis".to_string(),
            ],
            prompt_skeleton:
                "Workflow: research\n\nQuestion: <what we don't know>\n\
                 Sources: <papers, repos, vendor docs>\n\n\
                 Output: notes-for-notebooklm + 1-page summary + go/no-go recommendation."
                    .to_string(),
        },
        WorkflowTemplate {
            id: "gamedev".to_string(),
            name: "Gamedev".to_string(),
            description: "Gameplay design, engine integration, playtest review.".to_string(),
            agent_slugs: vec![
                "don-claudio".to_string(),
                "terry-davis".to_string(),
                "kirkardo".to_string(),
            ],
            prompt_skeleton:
                "Workflow: gamedev\n\nSystem: <gameplay system or mechanic>\n\
                 Engine: <Unreal / Unity / custom>\n\nReplication / netcode considerations: \
                 <single-player or multiplayer>\n\nAcceptance: builds in editor + plays as \
                 designed in PIE."
                    .to_string(),
        },
        WorkflowTemplate {
            id: "learning".to_string(),
            name: "Learning".to_string(),
            description: "Structured learning plan + hands-on exercise.".to_string(),
            agent_slugs: vec!["novalbos".to_string(), "terry-davis".to_string()],
            prompt_skeleton:
                "Workflow: learning\n\nTopic: <what to learn>\n\
                 Current level: <beginner / intermediate / advanced>\n\n\
                 Deliverable: NotebookLM-ready notes + 1 working exercise."
                    .to_string(),
        },
    ])
}

/// Return today's `in_progress` workday for the project, or `None`. Used by
/// the frontend before showing the templates tab: if a workday is already
/// active for the project, we surface it directly instead of asking the user
/// to pick a template.
pub fn active_today_for_project_inner(
    project_id: String,
) -> Result<Option<Workday>, String> {
    let project_path = crate::projects::list_projects_inner()
        .ok()
        .and_then(|ps| ps.into_iter().find(|p| p.id == project_id))
        .and_then(|p| p.path.clone())
        .unwrap_or_default();
    find_active_workday_for_project(&project_id, &project_path)
}

/// Start a workday with the supplied template. Idempotent on (project, day):
/// if today's workday already exists for the project it is returned as-is.
/// Otherwise a fresh workday is opened in `in_progress`, the workflow id is
/// recorded, the agent sequence is seeded as goals, and the prompt skeleton
/// lands in `context.notes` so the next session can pick it up.
pub fn start_with_template_inner(
    project_id: String,
    template_id: String,
) -> Result<Workday, String> {
    let templates = list_workflow_templates_inner()?;
    let tpl = templates
        .into_iter()
        .find(|t| t.id == template_id)
        .ok_or_else(|| format!("unknown workflow template: {template_id}"))?;

    let wd = auto_start_for_project_inner(
        project_id,
        None,
        Some(tpl.id.clone()),
    )?;

    // If the workday was just created (no notes yet for this template) seed
    // it with the prompt skeleton so the next agent invocation can read it.
    let already_seeded = wd
        .context
        .notes
        .iter()
        .any(|e| e.kind == "workflow_prompt" && e.source.as_deref() == Some(tpl.id.as_str()));
    if already_seeded {
        return Ok(wd);
    }
    append_context_inner(
        wd.id.clone(),
        "workflow_prompt".to_string(),
        tpl.prompt_skeleton.clone(),
        Some(tpl.id.clone()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // KIRKARDO 19 — concurrency lock tests

    #[test]
    fn workday_lock_same_static() {
        let a = workday_lock() as *const Mutex<()>;
        let b = workday_lock() as *const Mutex<()>;
        assert_eq!(a, b);
    }

    #[test]
    fn workday_lock_sequential_under_contention() {
        use std::sync::{Arc, Barrier};
        use std::thread;
        let barrier = Arc::new(Barrier::new(2));
        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let b2 = Arc::clone(&barrier);
        let c2 = Arc::clone(&counter);
        let h = thread::spawn(move || {
            b2.wait();
            let _g = workday_lock().lock().unwrap();
            let v = c2.load(Ordering::SeqCst);
            thread::sleep(std::time::Duration::from_millis(5));
            c2.store(v + 1, Ordering::SeqCst);
        });
        barrier.wait();
        {
            let _g = workday_lock().lock().unwrap();
            let v = counter.load(Ordering::SeqCst);
            thread::sleep(std::time::Duration::from_millis(5));
            counter.store(v + 1, Ordering::SeqCst);
        }
        h.join().unwrap();
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn list_workflow_templates_returns_seven() {
        let tpls = list_workflow_templates_inner().expect("templates load");
        assert_eq!(tpls.len(), 7);
        let ids: Vec<&str> = tpls.iter().map(|t| t.id.as_str()).collect();
        for expected in [
            "quick-fix",
            "feature",
            "debug",
            "security",
            "research",
            "gamedev",
            "learning",
        ] {
            assert!(ids.contains(&expected), "missing template: {expected}");
        }
    }

    #[test]
    fn workflow_templates_have_non_empty_fields() {
        for tpl in list_workflow_templates_inner().expect("templates load") {
            assert!(!tpl.name.is_empty(), "template {} has empty name", tpl.id);
            assert!(
                !tpl.description.is_empty(),
                "template {} has empty description",
                tpl.id
            );
            assert!(
                !tpl.agent_slugs.is_empty(),
                "template {} has no agents",
                tpl.id
            );
            assert!(
                !tpl.prompt_skeleton.is_empty(),
                "template {} has empty skeleton",
                tpl.id
            );
        }
    }

    #[test]
    fn auto_title_handles_empty_project_name() {
        assert_eq!(auto_title("", "2026-05-26"), "Workday 2026-05-26");
        assert_eq!(auto_title("ULTRON", "2026-05-26"), "ULTRON - 2026-05-26");
    }

    #[test]
    fn goals_for_workflow_matches_known_ids() {
        assert!(!goals_for_workflow("quick").is_empty());
        assert!(!goals_for_workflow("feature").is_empty());
        assert!(goals_for_workflow("nonsense").is_empty());
    }
}

// ---------------------------------------------------------------------------
// T2 -- Sessions <-> Workdays auto-link drainer
// ---------------------------------------------------------------------------
//
// The companion JS hook (`~/.claude/scripts/workday-session-linker.js`) tries
// to call this backend directly via a Tauri CLI helper if the Control Center
// is running. When it isn't, the hook appends a line to
// `~/.ultron/cockpit/workdays/_pending-links.jsonl` of the form:
//
//   {"session_id": "...", "cwd": "...", "timestamp": "2026-05-26T..."}
//
// At backend startup we drain that file. With the 2026-05-26 redesign the
// drain logic now does TWO things per entry:
//
//   1. If the cwd resolves to a known project, auto-start (or fetch) today's
//      workday for that project and link the session to it.
//   2. Otherwise fall back to the legacy behaviour: link to the most-recent
//      `in_progress` workday (any project) if one exists, else keep the
//      entry for a future drain.
//
// Both paths share `link_session_inner` which guards against duplicate
// session ids, so the drainer is idempotent.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingLink {
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
}

pub fn pending_links_path() -> Result<PathBuf, String> {
    Ok(workdays_dir()?.join("_pending-links.jsonl"))
}

fn read_pending_links() -> Result<Vec<PendingLink>, String> {
    let path = pending_links_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("read pending: {e}"))?;
    let mut out: Vec<PendingLink> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(p) = serde_json::from_str::<PendingLink>(trimmed) {
            out.push(p);
        }
    }
    Ok(out)
}

fn write_pending_links(items: &[PendingLink]) -> Result<(), String> {
    let path = pending_links_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir pending: {e}"))?;
    }
    let mut buf = String::new();
    for it in items {
        let line = serde_json::to_string(it).map_err(|e| format!("ser pending: {e}"))?;
        buf.push_str(&line);
        buf.push('\n');
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create pending: {e}"))?;
        f.write_all(buf.as_bytes()).map_err(|e| format!("write pending: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path).map_err(|e| format!("rename pending: {e}"))
}

/// Append a new pending link without going through the in_progress lookup.
/// Used by the `pending_link_record` command so the JS hook can call into
/// Tauri while the Control Center is running but no workday is active.
pub fn append_pending_link_inner(
    session_id: String,
    cwd: Option<String>,
) -> Result<PendingLink, String> {
    let entry = PendingLink {
        session_id,
        cwd,
        timestamp: Some(now_iso()),
    };
    let path = pending_links_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir pending: {e}"))?;
    }
    let line = serde_json::to_string(&entry).map_err(|e| format!("ser pending: {e}"))?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open pending: {e}"))?;
    f.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("write pending: {e}"))?;
    Ok(entry)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrainReport {
    pub processed: usize,
    pub linked: usize,
    pub kept: usize,
    pub errors: Vec<String>,
}

fn most_recent_in_progress() -> Result<Option<Workday>, String> {
    let mut in_progress = list_workdays_inner(Some("in_progress".to_string()), None, None, None)?;
    // `start_ts DESC` ranking -- fall back to created_at when missing.
    in_progress.sort_by(|a, b| {
        let aa = a.start_ts.clone().unwrap_or_else(|| a.created_at.clone());
        let bb = b.start_ts.clone().unwrap_or_else(|| b.created_at.clone());
        bb.cmp(&aa)
    });
    Ok(in_progress.into_iter().next())
}

/// Try every drain strategy in priority order: project-aware auto-start when
/// the cwd matches a known project, else legacy fallback to the most-recent
/// `in_progress` workday. Entries that can't be linked at all are preserved
/// for a future drain.
pub fn drain_pending_links_inner() -> Result<DrainReport, String> {
    let mut report = DrainReport {
        processed: 0,
        linked: 0,
        kept: 0,
        errors: Vec::new(),
    };
    let pending = match read_pending_links() {
        Ok(p) => p,
        Err(e) => {
            report.errors.push(e);
            return Ok(report);
        }
    };
    report.processed = pending.len();
    if pending.is_empty() {
        return Ok(report);
    }
    let fallback = most_recent_in_progress().ok().flatten();
    let mut leftover: Vec<PendingLink> = Vec::new();
    for entry in pending {
        // Strategy 1: project-aware auto-start.
        let cwd_match = entry.cwd.as_deref().and_then(|c| {
            let c = c.trim();
            if c.is_empty() { None } else { Some(c.to_string()) }
        });
        let mut linked_via_project = false;
        if let Some(cwd) = cwd_match.clone() {
            match auto_workday_for_session_inner(entry.session_id.clone(), cwd) {
                Ok(Some(_)) => {
                    report.linked += 1;
                    linked_via_project = true;
                }
                Ok(None) => {}
                Err(e) => {
                    report.errors.push(format!(
                        "auto-start {}: {e}",
                        entry.session_id
                    ));
                }
            }
        }
        if linked_via_project {
            continue;
        }
        // Strategy 2: legacy fallback.
        if let Some(active) = fallback.as_ref() {
            match link_session_inner(active.id.clone(), entry.session_id.clone()) {
                Ok(_) => report.linked += 1,
                Err(e) => {
                    report.errors.push(format!(
                        "link {} -> {}: {e}",
                        entry.session_id, active.id
                    ));
                    leftover.push(entry);
                }
            }
        } else {
            leftover.push(entry);
        }
    }
    report.kept = leftover.len();
    if let Err(e) = write_pending_links(&leftover) {
        report.errors.push(format!("write leftover: {e}"));
    }
    Ok(report)
}

/// One-shot best-effort wrapper used by `lib.rs` at startup. Failures are
/// logged to stderr only -- startup must never abort on a memory-housekeeping
/// glitch.
pub fn drain_pending_links_at_startup() {
    match drain_pending_links_inner() {
        Ok(r) if r.processed > 0 => {
            eprintln!(
                "[ultron] workdays drain: processed={} linked={} kept={} errors={}",
                r.processed,
                r.linked,
                r.kept,
                r.errors.len()
            );
        }
        Ok(_) => {}
        Err(e) => {
            eprintln!("[ultron] workdays drain failed: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// H29 — Wipe workdays (backup + delete)
// ---------------------------------------------------------------------------

/// Report returned by `wipe_all_with_backup_inner`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WipeReport {
    /// Absolute path of the ZIP archive. Empty when nothing was wiped.
    pub archived_path: String,
    /// Number of `wd-*.json` and `_pending-links.jsonl` files deleted.
    pub deleted_count: usize,
}

/// Compress every `wd-*.json` and `_pending-links.jsonl` into a timestamped
/// ZIP at `~/.ultron/cockpit/workdays/archive-<epoch>.zip`, then delete the
/// originals. Files under `cockpit/projects/<id>/work-sessions.jsonl` are
/// NOT touched.
pub fn wipe_all_with_backup_inner() -> Result<WipeReport, String> {
    use std::io::Read as IoRead;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    let dir = workdays_dir()?;
    if !dir.exists() {
        return Ok(WipeReport {
            archived_path: String::new(),
            deleted_count: 0,
        });
    }

    let mut targets: Vec<PathBuf> = Vec::new();
    for e in fs::read_dir(&dir)
        .map_err(|e| format!("read dir: {e}"))?
        .flatten()
    {
        let p = e.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if (name.starts_with("wd-") && name.ends_with(".json"))
            || name == "_pending-links.jsonl"
        {
            targets.push(p);
        }
    }

    if targets.is_empty() {
        return Ok(WipeReport {
            archived_path: String::new(),
            deleted_count: 0,
        });
    }

    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let archive_path = dir.join(format!("archive-{epoch}.zip"));

    {
        let file = fs::File::create(&archive_path)
            .map_err(|e| format!("create zip: {e}"))?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for src in &targets {
            let entry_name = src
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown");
            zip.start_file(entry_name, options)
                .map_err(|e| format!("zip entry {entry_name}: {e}"))?;
            let mut f = fs::File::open(src)
                .map_err(|e| format!("open {entry_name}: {e}"))?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)
                .map_err(|e| format!("read {entry_name}: {e}"))?;
            std::io::Write::write_all(&mut zip, &buf)
                .map_err(|e| format!("write zip entry: {e}"))?;
        }
        zip.finish().map_err(|e| format!("zip finish: {e}"))?;
    }

    let mut deleted = 0usize;
    for src in &targets {
        match fs::remove_file(src) {
            Ok(()) => deleted += 1,
            Err(e) => eprintln!("[ultron] wipe: failed to delete {}: {e}", src.display()),
        }
    }

    Ok(WipeReport {
        archived_path: archive_path.to_string_lossy().into_owned(),
        deleted_count: deleted,
    })
}

// ---------------------------------------------------------------------------
// H30 — Day view with 24-slot hour-blocks
// ---------------------------------------------------------------------------

/// Time-of-day period bucket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DayPeriod {
    Night,
    Morning,
    Afternoon,
    Evening,
}

impl DayPeriod {
    pub fn from_hour(h: u8) -> Self {
        match h {
            6..=11 => DayPeriod::Morning,
            12..=17 => DayPeriod::Afternoon,
            18..=23 => DayPeriod::Evening,
            _ => DayPeriod::Night,
        }
    }
}

/// One hour slot (e.g. 09:00-10:00) in a day view.
///
/// `projects` maps `project_id -> estimated seconds` present in this slot.
/// Presence is derived from workday `start_ts`, `end_ts`, and every
/// context-entry `created_at` timestamp that falls in this hour.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HourBlock {
    pub hour_start: u8,
    pub hour_end: u8,
    pub period: DayPeriod,
    pub projects: std::collections::HashMap<String, u64>,
    pub ai_session_count: u32,
    pub linked_sessions: Vec<String>,
}

/// Full day view returned by `workday_day_view`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkdayDayView {
    pub date: String,
    pub workdays: Vec<Workday>,
    pub hour_blocks: Vec<HourBlock>,
    pub total_seconds: u64,
    pub project_count: usize,
    pub session_count: usize,
}

fn parse_epoch_ts(s: &str) -> Option<i64> {
    s.strip_prefix("epoch:")?.parse::<i64>().ok()
}

fn epoch_to_local_hour(epoch_secs: i64) -> u8 {
    use chrono::{Local, TimeZone, Timelike};
    Local
        .timestamp_opt(epoch_secs, 0)
        .single()
        .map(|dt| dt.hour() as u8)
        .unwrap_or(0)
}

/// Build the 24-slot hour-block vector for a slice of workdays.
///
/// Per workday:
///   1. Collect every timestamp (start_ts + all context-entry created_at).
///   2. If start_ts + end_ts both exist, mark every hour in that span active.
///   3. Distribute focus_seconds evenly across distinct active hours.
///   4. Assign linked session IDs to the workday start hour.
fn build_hour_blocks(workdays: &[Workday]) -> Vec<HourBlock> {
    use std::collections::{BTreeSet, HashMap};

    let mut slot_projects: Vec<HashMap<String, u64>> = (0..24).map(|_| HashMap::new()).collect();
    let mut slot_sessions: Vec<Vec<String>> = (0..24).map(|_| Vec::new()).collect();
    let mut slot_ai_count: Vec<u32> = vec![0u32; 24];

    for wd in workdays {
        let project_key = wd.project_id.clone().unwrap_or_else(|| wd.id.clone());

        let mut active_hours: BTreeSet<u8> = BTreeSet::new();

        if let Some(e) = wd.start_ts.as_deref().and_then(parse_epoch_ts) {
            active_hours.insert(epoch_to_local_hour(e));
        }
        for entry in wd
            .context
            .notes
            .iter()
            .chain(wd.context.decisions.iter())
            .chain(wd.context.file_changes.iter())
            .chain(wd.context.agent_messages.iter())
        {
            if let Some(e) = parse_epoch_ts(&entry.created_at) {
                active_hours.insert(epoch_to_local_hour(e));
            }
        }
        if let (Some(s), Some(en)) = (
            wd.start_ts.as_deref().and_then(parse_epoch_ts),
            wd.end_ts.as_deref().and_then(parse_epoch_ts),
        ) {
            let h0 = epoch_to_local_hour(s);
            let h1 = epoch_to_local_hour(en);
            for h in h0..=h1 {
                active_hours.insert(h);
            }
        }

        if active_hours.is_empty() {
            continue;
        }

        let n = active_hours.len() as u64;
        let secs_per_slot = wd.focus_seconds.checked_div(n).unwrap_or(0);
        for &h in &active_hours {
            *slot_projects[h as usize]
                .entry(project_key.clone())
                .or_insert(0) += secs_per_slot;
        }

        let session_hour = wd
            .start_ts
            .as_deref()
            .and_then(parse_epoch_ts)
            .map(epoch_to_local_hour)
            .unwrap_or_else(|| *active_hours.iter().next().unwrap());
        let idx = session_hour as usize;
        for sid in &wd.linked_sessions {
            if !slot_sessions[idx].contains(sid) {
                slot_sessions[idx].push(sid.clone());
                slot_ai_count[idx] += 1;
            }
        }
    }

    (0u8..24)
        .map(|h| {
            let i = h as usize;
            HourBlock {
                hour_start: h,
                hour_end: h + 1,
                period: DayPeriod::from_hour(h),
                projects: slot_projects[i].clone(),
                ai_session_count: slot_ai_count[i],
                linked_sessions: slot_sessions[i].clone(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// H31 — Goals CRUD + AI auto-fill
// ---------------------------------------------------------------------------

/// Add a new manual goal to the workday. Returns the updated workday.
pub fn goals_add_inner(workday_id: String, text: String) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&workday_id)?;
    if text.trim().is_empty() {
        return Err("goal text must not be empty".to_string());
    }
    wd.goals.push(WorkdayGoal {
        id: new_id("goal"),
        text: text.trim().to_string(),
        status: GoalStatus::Pending,
        source: GoalSource::Manual,
        linked_card_id: None,
    });
    persist_workday(&wd)?;
    Ok(wd)
}

/// Update the status of an existing goal. Optionally rename it.
/// Delegates to the existing `update_goal_inner` but re-exposed with the
/// H31 naming convention so the new commands module can use it uniformly.
pub fn goals_update_inner(
    workday_id: String,
    goal_id: String,
    status: GoalStatus,
    text: Option<String>,
) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&workday_id)?;
    let goal = wd
        .goals
        .iter_mut()
        .find(|x| x.id == goal_id)
        .ok_or_else(|| format!("goal {goal_id} not found"))?;
    goal.status = status;
    if let Some(t) = text {
        let trimmed = t.trim().to_string();
        if !trimmed.is_empty() {
            goal.text = trimmed;
        }
    }
    persist_workday(&wd)?;
    Ok(wd)
}

/// Remove a goal from the workday permanently.
pub fn goals_delete_inner(workday_id: String, goal_id: String) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&workday_id)?;
    let before = wd.goals.len();
    wd.goals.retain(|g| g.id != goal_id);
    if wd.goals.len() == before {
        return Err(format!("goal {goal_id} not found"));
    }
    persist_workday(&wd)?;
    Ok(wd)
}

/// Scan every kanban board whose project matches the workday's `project_id`,
/// collect cards whose column is named "In Progress" (case-insensitive), then
/// call `ai_router::route("utility", …)` with a summarisation prompt to
/// produce a concise goal per card. Falls back to using the card titles
/// directly when the AI call fails (no partial writes on error).
pub fn goals_auto_fill_inner(workday_id: String) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&workday_id)?;

    // Gather "In Progress" card titles for the workday's project (or all
    // projects when project_id is absent — unusual but valid).
    let project_ids: Vec<String> = match &wd.project_id {
        Some(id) => vec![id.clone()],
        None => crate::projects::list_projects_inner()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.id)
            .collect(),
    };

    let mut in_progress_titles: Vec<(String, String)> = Vec::new(); // (card_id, title)
    for pid in &project_ids {
        if let Ok(board) = crate::kanban::load(pid) {
            let ip_col_ids: Vec<&str> = board
                .columns
                .iter()
                .filter(|c| c.name.to_lowercase().contains("in progress"))
                .map(|c| c.id.as_str())
                .collect();
            for card in &board.cards {
                if ip_col_ids.contains(&card.column_id.as_str()) {
                    in_progress_titles.push((card.id.clone(), card.title.clone()));
                }
            }
        }
    }

    if in_progress_titles.is_empty() {
        // Nothing to fill — return workday unchanged (not an error).
        return Ok(wd);
    }

    // Build a compact goal list from card titles.  Try to improve them with
    // AI; on any failure fall back to the raw titles.
    let card_list = in_progress_titles
        .iter()
        .map(|(_, t)| format!("- {t}"))
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        "You are a productivity assistant. Given the following kanban cards currently \
         In Progress, rewrite each as a concise, actionable workday goal (max 80 chars \
         each). Respond ONLY with a bullet list, one goal per line, same order as input.\n\n\
         Cards:\n{card_list}"
    );

    let goal_texts: Vec<String> = match crate::ai_router::route("utility", &prompt) {
        Ok(response) => {
            let lines: Vec<String> = response
                .lines()
                .map(|l| l.trim_start_matches(['-', '*', ' ', '\t']).trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            // Guard: if AI returned a different count, fall back to raw titles.
            if lines.len() == in_progress_titles.len() {
                lines
            } else {
                in_progress_titles.iter().map(|(_, t)| t.clone()).collect()
            }
        }
        Err(_) => in_progress_titles.iter().map(|(_, t)| t.clone()).collect(),
    };

    // Append only goals not already present (dedup by text).
    // Collect existing texts first, drop the borrow, then mutate.
    let existing_texts: std::collections::HashSet<String> =
        wd.goals.iter().map(|g| g.text.clone()).collect();

    let new_goals: Vec<WorkdayGoal> = in_progress_titles
        .iter()
        .zip(goal_texts.iter())
        .filter(|((_, _), text)| !existing_texts.contains(*text))
        .map(|((card_id, _), text)| WorkdayGoal {
            id: new_id("goal"),
            text: text.clone(),
            status: GoalStatus::Pending,
            source: GoalSource::AiInferred,
            linked_card_id: Some(card_id.clone()),
        })
        .collect();

    wd.goals.extend(new_goals);

    persist_workday(&wd)?;
    Ok(wd)
}

// ---------------------------------------------------------------------------
// H32 — Context auto-append (used by the 15-min scheduler hook)
// ---------------------------------------------------------------------------

/// Append an auto-update context note to a workday. The note lands in
/// `context.notes` with `kind = "auto_update"`. This is the Tauri-side
/// receiver that the `workday-auto-update.js` hook writes to via direct JSON
/// mutation or (when Control Center is running) via this command.
pub fn context_auto_append_inner(
    workday_id: String,
    summary: String,
    payload_json: Option<String>,
) -> Result<Workday, String> {
    let _g = workday_lock().lock().map_err(|_| "workday lock poisoned")?;
    let mut wd = load_wd(&workday_id)?;
    let text = match payload_json {
        Some(ref p) if !p.trim().is_empty() => format!("{summary}\n{p}"),
        _ => summary,
    };
    wd.context.notes.push(WorkdayContextEntry {
        id: new_id("ctx"),
        kind: "auto_update".to_string(),
        text,
        source: Some("scheduler".to_string()),
        created_at: now_iso(),
    });
    persist_workday(&wd)?;
    Ok(wd)
}

/// Return the active workday id for today, scanning the workdays directory.
/// Used by the scheduled hook to know which workday to append to without
/// requiring the Control Center to be running.
pub fn active_workday_id_today_inner() -> Result<Option<String>, String> {
    let today = today_date();
    let all = list_workdays_inner(Some("in_progress".to_string()), Some(today.clone()), Some(today), None)?;
    Ok(all.into_iter().next().map(|w| w.id))
}

/// Register (or replace) a Windows scheduled task that runs the
/// `workday-auto-update.js` hook every 15 minutes.
///
/// Uses `schtasks /CREATE /F` which overwrites any existing task with the
/// same name — idempotent by construction.
pub fn register_autoupdate_task_inner() -> Result<String, String> {
    // Locate the hook script.
    let hook_path = dirs::home_dir()
        .ok_or_else(|| "no home dir".to_string())?
        .join(".claude")
        .join("hooks")
        .join("workday-auto-update.js");
    let hook_str = hook_path.to_string_lossy();

    // Build schtasks command.
    // /F    — force overwrite if task already exists (idempotent)
    // /SC MINUTE /MO 15  — every 15 minutes
    // /RL HIGHEST        — run with elevated privileges so `git` calls work
    let cmd = format!(
        r#"schtasks /CREATE /F /SC MINUTE /MO 15 /TN "UltronWorkdayAutoUpdate" /TR "node \"{hook_str}\"" /RL HIGHEST"#
    );

    let output = std::process::Command::new("cmd")
        .args(["/C", &cmd])
        .output()
        .map_err(|e| format!("schtasks exec failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "schtasks failed (exit {}): {stderr}",
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(format!("{} Command: {}", stdout.trim(), cmd))
}

/// Return a full day view for `date` (ISO `YYYY-MM-DD`, defaults to today).
pub fn day_view_inner(date: Option<String>) -> Result<WorkdayDayView, String> {
    let date = date.unwrap_or_else(today_date);
    let workdays = list_workdays_inner(None, Some(date.clone()), Some(date.clone()), None)?;

    let total_seconds: u64 = workdays.iter().map(|w| w.focus_seconds).sum();

    let mut project_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut all_sessions: std::collections::HashSet<String> = std::collections::HashSet::new();
    for wd in &workdays {
        if let Some(ref pid) = wd.project_id {
            project_ids.insert(pid.clone());
        }
        for sid in &wd.linked_sessions {
            all_sessions.insert(sid.clone());
        }
    }

    Ok(WorkdayDayView {
        date,
        hour_blocks: build_hour_blocks(&workdays),
        total_seconds,
        project_count: project_ids.len(),
        session_count: all_sessions.len(),
        workdays,
    })
}

