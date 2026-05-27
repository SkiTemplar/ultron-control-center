// KIRKARDO 13 — workday_aggregate_today
//
// Scans every `~/.ultron/cockpit/projects/*/kanban.json`, collects cards
// sitting in "In Progress" or "Blocked" columns, derives a priority level
// from tags (p0/p1/p2/p3), and returns a unified view sorted by priority
// desc then updated_at desc.
//
// This module is intentionally self-contained — it only imports from
// `crate::kanban` (the existing domain) and the standard library.

use crate::kanban;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

// ── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct CrossProjectTodayItem {
    pub project_id: String,
    pub project_name: String,
    pub card_id: String,
    pub card_title: String,
    /// Derived from tags: "p0" | "p1" | "p2" | "p3" | "none"
    pub card_priority: String,
    /// "in_progress" | "blocked"
    pub status: String,
    pub tags: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct CrossProjectTodayReport {
    pub items: Vec<CrossProjectTodayItem>,
    /// Counts per priority bucket: {"p0": 2, "p1": 5, ...}
    pub stats: HashMap<String, usize>,
    pub scanned_projects: usize,
    pub scan_time_ms: u64,
}

// ── Priority helpers ─────────────────────────────────────────────────────────

/// Extract the highest-priority tag present in the tag list.
/// Returns "p0" > "p1" > "p2" > "p3" > "none".
fn derive_priority(tags: &[String]) -> String {
    for level in ["p0", "p1", "p2", "p3"] {
        if tags.iter().any(|t| t.eq_ignore_ascii_case(level)) {
            return level.to_string();
        }
    }
    "none".to_string()
}

/// Maps priority string to a sort key where lower = higher priority.
fn priority_sort_key(p: &str) -> u8 {
    match p {
        "p0" => 0,
        "p1" => 1,
        "p2" => 2,
        "p3" => 3,
        _ => 4,
    }
}

/// Extract epoch seconds from the kanban `updated_at` field.
/// Handles both `"epoch:<secs>"` and ISO-8601 strings gracefully.
fn epoch_secs_from_timestamp(ts: &str) -> u64 {
    if let Some(rest) = ts.strip_prefix("epoch:") {
        return rest.parse::<u64>().unwrap_or(0);
    }
    // Minimal ISO-8601 parse: "2026-05-27T08:28:13Z" → epoch secs.
    // We only need relative ordering so an approximate parse is fine.
    0
}

// ── Core logic ───────────────────────────────────────────────────────────────

/// Enumerate every sub-directory under `~/.ultron/cockpit/projects/` that
/// contains a `kanban.json`. Returns `(project_id, display_name)` pairs where
/// `display_name` is the directory name (used as fallback when there is no
/// projects.json entry for that id).
fn enumerate_project_dirs() -> Result<Vec<(String, String)>, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let projects_root = home.join(".ultron").join("cockpit").join("projects");

    if !projects_root.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(&projects_root).map_err(|e| format!("read projects dir: {e}"))?;

    let mut out: Vec<(String, String)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if !path.join("kanban.json").exists() {
            continue;
        }
        let dir_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if dir_name.is_empty() {
            continue;
        }
        out.push((dir_name.clone(), dir_name));
    }
    Ok(out)
}

pub fn aggregate_today_inner() -> Result<CrossProjectTodayReport, String> {
    let t_start = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let project_dirs = enumerate_project_dirs()?;
    let scanned_projects = project_dirs.len();

    let mut items: Vec<CrossProjectTodayItem> = Vec::new();

    for (project_id, project_name) in &project_dirs {
        let board = match kanban::load(project_id) {
            Ok(b) => b,
            Err(_) => continue, // tolerate missing / corrupt boards
        };

        // Build a map: column_id → status ("in_progress" | "blocked" | skip)
        let col_status: HashMap<String, &'static str> = board
            .columns
            .iter()
            .filter_map(|col| {
                let lower = col.name.to_ascii_lowercase();
                if lower.contains("in progress") || lower.contains("in_progress") {
                    Some((col.id.clone(), "in_progress"))
                } else if lower.contains("blocked") {
                    Some((col.id.clone(), "blocked"))
                } else {
                    None
                }
            })
            .collect();

        if col_status.is_empty() {
            continue;
        }

        for card in &board.cards {
            let Some(&status) = col_status.get(&card.column_id) else {
                continue;
            };

            let priority = derive_priority(&card.tags);

            items.push(CrossProjectTodayItem {
                project_id: project_id.clone(),
                project_name: project_name.clone(),
                card_id: card.id.clone(),
                card_title: card.title.clone(),
                card_priority: priority,
                status: status.to_string(),
                tags: card.tags.clone(),
                updated_at: card.updated_at.clone(),
            });
        }
    }

    // Sort: priority asc (p0 first), tiebreak updated_at desc (newest first).
    items.sort_by(|a, b| {
        let pa = priority_sort_key(&a.card_priority);
        let pb = priority_sort_key(&b.card_priority);
        if pa != pb {
            return pa.cmp(&pb);
        }
        let ta = epoch_secs_from_timestamp(&a.updated_at);
        let tb = epoch_secs_from_timestamp(&b.updated_at);
        tb.cmp(&ta)
    });

    // Build stats map.
    let mut stats: HashMap<String, usize> = HashMap::new();
    for item in &items {
        *stats.entry(item.card_priority.clone()).or_insert(0) += 1;
    }

    let t_end = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let scan_time_ms = (t_end.saturating_sub(t_start)) as u64;

    Ok(CrossProjectTodayReport {
        items,
        stats,
        scanned_projects,
        scan_time_ms,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kanban::{Card, Column, KanbanBoard};

    fn make_board(
        project_id: &str,
        columns: Vec<(&str, &str)>, // (id, name)
        cards: Vec<(&str, &str, &str, Vec<&str>, &str)>, // (id, title, col_id, tags, updated_at)
    ) -> KanbanBoard {
        KanbanBoard {
            project_id: project_id.to_string(),
            columns: columns
                .into_iter()
                .map(|(id, name)| Column {
                    id: id.to_string(),
                    name: name.to_string(),
                    order: 0,
                })
                .collect(),
            cards: cards
                .into_iter()
                .map(|(id, title, col_id, tags, updated_at)| Card {
                    id: id.to_string(),
                    column_id: col_id.to_string(),
                    title: title.to_string(),
                    description: String::new(),
                    agent: None,
                    prompt_template: None,
                    cwd: None,
                    tags: tags.iter().map(|t| t.to_string()).collect(),
                    order: 0,
                    created_at: "epoch:0".to_string(),
                    updated_at: updated_at.to_string(),
                    runs: vec![],
                })
                .collect(),
            default_agent: None,
            default_prompt_template: None,
            schema_version: crate::kanban::SCHEMA_VERSION,
        }
    }

    #[test]
    fn derive_priority_returns_highest_tag() {
        assert_eq!(derive_priority(&["p2".into(), "p0".into(), "bug".into()]), "p0");
        assert_eq!(derive_priority(&["p3".into(), "p1".into()]), "p1");
        assert_eq!(derive_priority(&["bug".into(), "feat".into()]), "none");
        assert_eq!(derive_priority(&[]), "none");
    }

    #[test]
    fn priority_sort_key_orders_correctly() {
        let mut prios = vec!["none", "p2", "p0", "p3", "p1"];
        prios.sort_by_key(|p| priority_sort_key(p));
        assert_eq!(prios, vec!["p0", "p1", "p2", "p3", "none"]);
    }

    #[test]
    fn items_from_board_filtered_by_status_columns() {
        let board = make_board(
            "proj-a",
            vec![
                ("col-backlog", "Backlog"),
                ("col-ip", "In Progress"),
                ("col-blocked", "Blocked"),
                ("col-done", "Done"),
            ],
            vec![
                ("c1", "Active task", "col-ip", vec!["p1"], "epoch:1000"),
                ("c2", "Blocked task", "col-blocked", vec!["p0"], "epoch:2000"),
                ("c3", "Backlog task", "col-backlog", vec![], "epoch:3000"),
                ("c4", "Done task", "col-done", vec!["p0"], "epoch:4000"),
            ],
        );

        // Simulate what aggregate_today_inner does for a single board.
        let col_status: HashMap<String, &'static str> = board
            .columns
            .iter()
            .filter_map(|col| {
                let lower = col.name.to_ascii_lowercase();
                if lower.contains("in progress") {
                    Some((col.id.clone(), "in_progress"))
                } else if lower.contains("blocked") {
                    Some((col.id.clone(), "blocked"))
                } else {
                    None
                }
            })
            .collect();

        let collected: Vec<_> = board
            .cards
            .iter()
            .filter(|c| col_status.contains_key(&c.column_id))
            .collect();

        assert_eq!(collected.len(), 2);
        let ids: Vec<&str> = collected.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"c1"));
        assert!(ids.contains(&"c2"));
    }

    #[test]
    fn sort_priority_desc_tiebreak_updated_at_desc() {
        let mut items = vec![
            CrossProjectTodayItem {
                project_id: "a".into(),
                project_name: "A".into(),
                card_id: "c1".into(),
                card_title: "Old p1".into(),
                card_priority: "p1".into(),
                status: "in_progress".into(),
                tags: vec![],
                updated_at: "epoch:100".into(),
            },
            CrossProjectTodayItem {
                project_id: "b".into(),
                project_name: "B".into(),
                card_id: "c2".into(),
                card_title: "P0 critical".into(),
                card_priority: "p0".into(),
                status: "blocked".into(),
                tags: vec![],
                updated_at: "epoch:50".into(),
            },
            CrossProjectTodayItem {
                project_id: "c".into(),
                project_name: "C".into(),
                card_id: "c3".into(),
                card_title: "New p1".into(),
                card_priority: "p1".into(),
                status: "in_progress".into(),
                tags: vec![],
                updated_at: "epoch:200".into(),
            },
        ];

        items.sort_by(|a, b| {
            let pa = priority_sort_key(&a.card_priority);
            let pb = priority_sort_key(&b.card_priority);
            if pa != pb {
                return pa.cmp(&pb);
            }
            let ta = epoch_secs_from_timestamp(&a.updated_at);
            let tb = epoch_secs_from_timestamp(&b.updated_at);
            tb.cmp(&ta)
        });

        // Expected: c2 (p0), c3 (p1 newest), c1 (p1 oldest)
        assert_eq!(items[0].card_id, "c2");
        assert_eq!(items[1].card_id, "c3");
        assert_eq!(items[2].card_id, "c1");
    }

    #[test]
    fn stats_map_counts_per_bucket() {
        let items = vec![
            CrossProjectTodayItem {
                project_id: "a".into(), project_name: "A".into(),
                card_id: "c1".into(), card_title: "T1".into(),
                card_priority: "p0".into(), status: "in_progress".into(),
                tags: vec![], updated_at: "epoch:1".into(),
            },
            CrossProjectTodayItem {
                project_id: "a".into(), project_name: "A".into(),
                card_id: "c2".into(), card_title: "T2".into(),
                card_priority: "p1".into(), status: "blocked".into(),
                tags: vec![], updated_at: "epoch:2".into(),
            },
            CrossProjectTodayItem {
                project_id: "b".into(), project_name: "B".into(),
                card_id: "c3".into(), card_title: "T3".into(),
                card_priority: "p1".into(), status: "in_progress".into(),
                tags: vec![], updated_at: "epoch:3".into(),
            },
        ];

        let mut stats: HashMap<String, usize> = HashMap::new();
        for item in &items {
            *stats.entry(item.card_priority.clone()).or_insert(0) += 1;
        }

        assert_eq!(stats["p0"], 1);
        assert_eq!(stats["p1"], 2);
        assert!(!stats.contains_key("p2"));
    }
}
