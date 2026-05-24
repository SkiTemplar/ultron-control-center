// ULTRON Control Center — Workdays (jornadas de trabajo)
//
// v2.5.3 SKELETON — USER wants a higher-level concept than raw Claude/Codex
// sessions: a "jornada de trabajo" that aggregates time spent, the type of
// work (coding / research / admin / meeting), the project worked on, agents
// used, and kanban changes made during the day.
//
// Implementation is staged:
//   1. THIS COMMIT — stub command + serializable struct so the frontend can
//      render a placeholder sub-tab without breaking when the user inevitably
//      asks for the real thing.
//   2. NEXT SESSION (card-v27-inv-workdays) — backend that derives Workday
//      entries from:
//        - claude session jsonl files (~/.claude/projects/<slug>/<id>.jsonl)
//        - codex/gemini session logs
//        - kanban runs / status transitions
//        - active project (terminal layout focused tab)
//        - manual annotations (`workday_annotate`)
//      and groups them per local-day with computed duration + summary.
//
// The shape below is intentionally conservative so the frontend can model
// the UI before the backend can guarantee any field. All optional.

use serde::{Deserialize, Serialize};

/// One "jornada de trabajo" — a focused block of work in a single local day.
/// Aggregates sessions + kanban activity for a single project (or "general"
/// when no single project dominates).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workday {
    /// Stable id (`workday-<yyyymmdd>-<short>`).
    pub id: String,
    /// Local ISO date (YYYY-MM-DD).
    pub date: String,
    /// Coarse classification — one of "coding", "research", "admin",
    /// "meeting", "mixed". Derived heuristically; user can override.
    pub kind: String,
    /// Project id (from `projects.json`) or `null` if cross-project.
    pub project_id: Option<String>,
    /// Human title — e.g. "ultron control-center · v2.6 feedback sweep".
    pub title: String,
    /// Minutes of recorded activity. Derived from session timestamps.
    pub minutes: u32,
    /// Number of underlying provider sessions counted in this workday.
    pub session_count: u32,
    /// Distinct agents / personas invoked (Terry, Don Claudio, Tolkien, …).
    pub agents_used: Vec<String>,
    /// Kanban cards touched during the workday.
    pub kanban_changes: u32,
    /// Auto-generated summary (one or two sentences). May be empty.
    pub summary: String,
}

/// Stub — returns an empty Vec. The frontend renders the "Coming soon"
/// state when the list is empty. Wire the actual aggregator in the
/// follow-up session referenced by `card-v27-inv-workdays`.
pub fn workday_list_inner(_limit: Option<usize>) -> Result<Vec<Workday>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn workday_list(limit: Option<usize>) -> Result<Vec<Workday>, String> {
    tauri::async_runtime::spawn_blocking(move || workday_list_inner(limit))
        .await
        .map_err(|e| e.to_string())?
}
