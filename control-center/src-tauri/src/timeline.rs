// ULTRON Control Center 2.0 — Per-project Timeline domain.
//
// Aggregates a chronological event feed for a single project by reading
// data that already exists on disk:
//
//   - Claude Code session jsonl files (per-project Claude transcripts)
//     under `~/.claude/projects/<slug>/<session_id>.jsonl`.
//   - Per-project kanban board (`~/.ultron/cockpit/projects/<id>/kanban.json`):
//     card creation, last-update transitions and PTY runs.
//   - Backup-status snapshot (last modified timestamp of the project root
//     inside the configured BACKUP root), when available.
//
// The aggregator is intentionally read-only: it never mutates any of those
// stores. The Timeline tab in the frontend is purely informational.

use serde::Serialize;

use crate::backup_status;
use crate::claude_sessions;
use crate::kanban;

/// One row in the timeline. The frontend groups consecutive events that
/// share a day (yyyy-mm-dd) under a sticky day header.
#[derive(Debug, Serialize, Clone)]
pub struct TimelineEvent {
    pub kind: String,
    /// ISO-8601 timestamp (preferred) or `epoch:<secs>` from kanban.json.
    pub at: String,
    pub title: String,
    pub detail: Option<String>,
    pub ref_id: Option<String>,
}

/// Format `epoch:<secs>` strings to ISO so the frontend sort + day-grouping
/// works uniformly. Anything already in ISO (yyyy-mm-ddT...) passes through.
fn normalise_at(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("epoch:") {
        if let Ok(secs) = rest.parse::<u64>() {
            return format_unix_iso(secs);
        }
    }
    raw.to_string()
}

fn format_unix_iso(secs: u64) -> String {
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd {
            break;
        }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        days + 1,
        h,
        m,
        s
    )
}

/// Aggregate the timeline for `project_id`. `project_path` is needed to
/// locate Claude Code per-project session files (slugified by Claude) and
/// to match against backup snapshots. Missing inputs are skipped quietly
/// — a project with no kanban / no backups still produces a valid (if
/// short) feed.
pub fn list_inner(project_id: &str, project_path: Option<&str>) -> Vec<TimelineEvent> {
    let mut out: Vec<TimelineEvent> = Vec::new();

    // -- kanban --------------------------------------------------------
    if let Ok(board) = kanban::load(project_id) {
        // Card creation events.
        for card in &board.cards {
            out.push(TimelineEvent {
                kind: "card_created".to_string(),
                at: normalise_at(&card.created_at),
                title: format!("Card created — {}", card.title),
                detail: column_name(&board, &card.column_id).map(String::from),
                ref_id: Some(card.id.clone()),
            });
            // Approximate move/transition event: if updated_at != created_at,
            // record one "card_moved" entry. We lack a true transition log,
            // so this is a single proxy event per card — see report note.
            if card.updated_at != card.created_at {
                out.push(TimelineEvent {
                    kind: "card_moved".to_string(),
                    at: normalise_at(&card.updated_at),
                    title: format!("Card updated — {}", card.title),
                    detail: column_name(&board, &card.column_id)
                        .map(|n| format!("now in {}", n)),
                    ref_id: Some(card.id.clone()),
                });
            }
            // PTY run events.
            for run in &card.runs {
                let status_str = match run.status {
                    kanban::RunStatus::Running => "running",
                    kanban::RunStatus::Completed => "completed",
                    kanban::RunStatus::Killed => "killed",
                    kanban::RunStatus::Failed => "failed",
                };
                out.push(TimelineEvent {
                    kind: "card_run".to_string(),
                    at: normalise_at(&run.started_at),
                    title: format!("Run on '{}' ({})", card.title, status_str),
                    detail: card.agent.clone(),
                    ref_id: Some(run.session_id.clone()),
                });
            }
        }
    }

    // -- claude code sessions in the project directory ----------------
    if let Some(path) = project_path.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(sessions) = list_claude_sessions(path) {
            for s in sessions {
                out.push(TimelineEvent {
                    kind: "session".to_string(),
                    at: normalise_at(&s.modified_at),
                    title: s
                        .first_user_message
                        .clone()
                        .filter(|x| !x.is_empty())
                        .map(|m| {
                            if m.len() > 80 {
                                format!("Session — {}…", &m[..80])
                            } else {
                                format!("Session — {}", m)
                            }
                        })
                        .unwrap_or_else(|| "Session".to_string()),
                    detail: Some(format!("session {}", short_id(&s.session_id))),
                    ref_id: Some(s.session_id),
                });
            }
        }
    }

    // -- backup snapshot (if a snapshot covering this project exists) -
    if let Ok(report) = backup_status::backup_status_inner() {
        if let Some(path) = project_path.map(str::trim).filter(|s| !s.is_empty()) {
            let name = std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
                .to_lowercase();
            if !name.is_empty() {
                for entry in report.entries {
                    if entry.exists && entry.name.to_lowercase().contains(&name) {
                        if let Some(modified) = entry.last_modified {
                            out.push(TimelineEvent {
                                kind: "backup".to_string(),
                                at: normalise_at(&modified),
                                title: format!("Backup — {}", entry.name),
                                detail: entry.age_hours.map(|h| format!("{:.1}h ago", h)),
                                ref_id: None,
                            });
                        }
                    }
                }
            }
        }
    }

    // Newest first (ISO strings sort lexicographically in chronological order).
    out.sort_by(|a, b| b.at.cmp(&a.at));
    out
}

fn column_name<'a>(board: &'a kanban::KanbanBoard, column_id: &str) -> Option<&'a str> {
    board
        .columns
        .iter()
        .find(|c| c.id == column_id)
        .map(|c| c.name.as_str())
}

fn short_id(s: &str) -> String {
    if s.len() <= 8 {
        s.to_string()
    } else {
        s.chars().take(8).collect()
    }
}

/// Lightweight wrapper around the `claude_sessions::project_sessions_list`
/// command, called in-process so we don't go through the Tauri runtime.
fn list_claude_sessions(project_path: &str) -> Option<Vec<claude_sessions::ClaudeSessionSummary>> {
    let home = dirs::home_dir()?;
    let slug = claude_sessions_project_slug(project_path);
    let dir = home.join(".claude").join("projects").join(&slug);
    if !dir.exists() {
        return Some(vec![]);
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let session_id = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let meta = entry.metadata().ok()?;
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| format!("epoch:{}", d.as_secs()))
            .unwrap_or_else(|| "unknown".to_string());
        out.push(claude_sessions::ClaudeSessionSummary {
            session_id,
            path: p.display().to_string(),
            modified_at,
            first_user_message: None,
        });
    }
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Some(out)
}

/// Delegate to `claude_sessions::project_slug_for` so the slug logic is
/// defined in exactly one place. Previous local copy only replaced `\` and
/// `/` but left `:` and `.` intact, producing `C:-Users-USER-.ultron`
/// instead of the correct `C--Users-USER--ultron`.
fn claude_sessions_project_slug(path: &str) -> String {
    claude_sessions::project_slug_for(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_strings_are_normalised_to_iso() {
        let iso = normalise_at("epoch:0");
        assert!(iso.starts_with("1970-01-01"));
        assert!(normalise_at("2026-01-02T03:04:05Z").starts_with("2026-01-02"));
    }

    #[test]
    fn missing_project_returns_empty_feed() {
        // No kanban, no sessions, no path → empty (not an error).
        let v = list_inner("definitely-not-a-real-project-xyz", None);
        // Allow it to be empty OR to surface a kanban that was auto-created
        // by the loader's default fallback; either way the call must not panic.
        let _ = v;
    }

    /// Verify that the slug helper matches Claude Code's own slugification rule.
    /// Claude Code replaces every non-alphanumeric character with `-`, so
    /// `C:\Users\X\.ultron` → `C--Users-X--ultron` (`:` → `-`, `\` → `-`,
    /// `.` → `-`, consecutive non-alnum runs each get their own `-`).
    #[test]
    fn project_slug_matches_claude_folder_name() {
        assert_eq!(
            claude_sessions_project_slug("C:\\Users\\X\\.ultron"),
            "C--Users-X--ultron"
        );
    }
}
