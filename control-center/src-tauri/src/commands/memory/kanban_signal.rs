// commands/memory/kanban_signal.rs — derive a LIVE next-action from project state
//
// SessionStart's `next_action` used to be `open_tasks.first()` — the highest
// `importance` ACTIVE memory Task. Memory rots (no done/stale state) so it kept
// surfacing weeks-old or already-done notes. Root fix: derive the action from
// LIVE state — the project's kanban (In-Progress card, else Backlog top) — and
// keep memory only as a last-resort fallback with recency + "already done" gates.
//
// Pure helpers (text/recency gates, card selection over parsed JSON) are unit
// tested with fixtures; the only IO is reading `kanban.json` and is isolated.

use serde_json::Value;
use std::path::Path;

const RECENCY_GATE_SECS: i64 = 14 * 24 * 60 * 60; // 14 days

/// Phrases that mark a task as ALREADY DONE / in the past. A memory Task whose
/// text matches must NOT be surfaced as the next action (it rots forever
/// otherwise: "commit y vigilar CI" stays #1 long after the commit landed).
const COMPLETED_MARKERS: &[&str] = &[
    "se ha realizado",
    "se ha hecho",
    "ya hecho",
    "ya esta hecho",
    "ya está hecho",
    "hecho:",
    "commit hecho",
    "commit y push hecho",
    "se vigilara",
    "se vigilará",
    "completado",
    "completada",
    "resuelto",
    "resuelta",
    "cerrado",
    "cerrada",
    "[done]",
    "(done)",
];

/// True when the text reads as an already-completed / past action and so must
/// be excluded from `next_action`. Case-insensitive substring match.
pub fn is_completed_text(summary: &str) -> bool {
    let lower = summary.to_lowercase();
    COMPLETED_MARKERS.iter().any(|m| lower.contains(m))
}

/// True when `updated_at` (epoch secs) is within the recency window relative to
/// `now` (epoch secs). Stale memory must not drive the next action.
pub fn is_recent(updated_at: i64, now: i64) -> bool {
    now.saturating_sub(updated_at) <= RECENCY_GATE_SECS
}

/// A memory Task is eligible to be the `next_action` only if it is both recent
/// AND not phrased as already-done.
pub fn memory_task_eligible(summary: &str, updated_at: i64, now: i64) -> bool {
    is_recent(updated_at, now) && !is_completed_text(summary)
}

/// Column ids with the given `role`, ordered by their `order` field (lowest
/// first). Pure over the columns array so it is testable without IO.
fn ordered_col_ids(columns: &[Value], role: &str) -> Vec<String> {
    let mut cols: Vec<(&Value, i64)> = columns
        .iter()
        .filter(|c| c.get("role").and_then(|r| r.as_str()) == Some(role))
        .map(|c| {
            (
                c,
                c.get("order").and_then(|o| o.as_i64()).unwrap_or(i64::MAX),
            )
        })
        .collect();
    cols.sort_by_key(|(_, ord)| *ord);
    cols.into_iter()
        .filter_map(|(c, _)| c.get("id").and_then(|i| i.as_str()).map(String::from))
        .collect()
}

/// Titles of every card in the given columns, ordered by column then by the
/// card's `order`. Empty when no card has a title.
fn ordered_card_titles(cards: &[Value], col_ids: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for cid in col_ids {
        let mut in_col: Vec<&Value> = cards
            .iter()
            .filter(|card| card.get("column_id").and_then(|c| c.as_str()) == Some(cid.as_str()))
            .collect();
        in_col.sort_by_key(|card| {
            card.get("order")
                .and_then(|o| o.as_i64())
                .unwrap_or(i64::MAX)
        });
        for card in in_col {
            if let Some(t) = card.get("title").and_then(|t| t.as_str()) {
                out.push(t.to_string());
            }
        }
    }
    out
}

/// Pick the live next-action title from an already-parsed kanban document.
/// Order: first In-Progress (role == "doing") card by column order, else the
/// top Backlog (role == "todo") card. Returns the card title.
///
/// Pure over the parsed JSON so it is testable from a fixture without IO.
pub fn next_action_from_kanban(doc: &Value) -> Option<String> {
    let columns = doc.get("columns")?.as_array()?;
    let cards = doc.get("cards")?.as_array()?;
    ordered_card_titles(cards, &ordered_col_ids(columns, "doing"))
        .into_iter()
        .next()
        .or_else(|| {
            ordered_card_titles(cards, &ordered_col_ids(columns, "todo"))
                .into_iter()
                .next()
        })
}

/// Live OPEN TASKS for the resume: titles of In-Progress (role "doing") then
/// Backlog (role "todo") cards, ordered, capped at `limit`. Memory Tasks rot
/// (no done/stale state), so the kanban is the live source — the same fix that
/// moved `next_action` off memory. Done/archived cards never appear.
pub fn open_tasks_from_kanban(doc: &Value, limit: usize) -> Vec<String> {
    let columns = match doc.get("columns").and_then(|c| c.as_array()) {
        Some(c) => c,
        None => return Vec::new(),
    };
    let cards = match doc.get("cards").and_then(|c| c.as_array()) {
        Some(c) => c,
        None => return Vec::new(),
    };
    let mut out = ordered_card_titles(cards, &ordered_col_ids(columns, "doing"));
    out.extend(ordered_card_titles(
        cards,
        &ordered_col_ids(columns, "todo"),
    ));
    out.truncate(limit);
    out
}

/// Read `<root>/cockpit/projects/<project>/kanban.json` and derive the live
/// next-action. Returns `None` if there is no kanban for the project (caller
/// falls back to memory). IO is isolated here.
pub fn kanban_next_action(root: &Path, project: &str) -> Option<String> {
    let path = root
        .join("cockpit")
        .join("projects")
        .join(project)
        .join("kanban.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&raw).ok()?;
    next_action_from_kanban(&doc)
}

/// Read the project's kanban and return its LIVE open-task titles (capped).
/// `None` when there is no kanban for the project or it has no live cards — the
/// caller then falls back to eligible (recent + not-done) memory tasks.
pub fn kanban_open_tasks(root: &Path, project: &str, limit: usize) -> Option<Vec<String>> {
    let path = root
        .join("cockpit")
        .join("projects")
        .join(project)
        .join("kanban.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let tasks = open_tasks_from_kanban(&doc, limit);
    if tasks.is_empty() {
        None
    } else {
        Some(tasks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kanban(cards: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "project_id": "ultron",
            "columns": [
                {"id": "c-back", "name": "Backlog", "order": 0, "role": "todo"},
                {"id": "c-doing", "name": "In Progress", "order": 1, "role": "doing"},
                {"id": "c-done", "name": "Done", "order": 4, "role": "done"}
            ],
            "cards": cards
        })
    }

    #[test]
    fn next_action_prefers_in_progress_card() {
        let doc = kanban(serde_json::json!([
            {"id": "b1", "column_id": "c-back", "title": "Backlog top", "order": 0},
            {"id": "d1", "column_id": "c-doing", "title": "Fix session resume", "order": 0},
            {"id": "z1", "column_id": "c-done", "title": "old done card", "order": 0}
        ]));
        assert_eq!(
            next_action_from_kanban(&doc).as_deref(),
            Some("Fix session resume"),
            "In-Progress card must win over Backlog and Done"
        );
    }

    #[test]
    fn next_action_falls_back_to_backlog_top_when_no_in_progress() {
        let doc = kanban(serde_json::json!([
            {"id": "b2", "column_id": "c-back", "title": "Second", "order": 1},
            {"id": "b1", "column_id": "c-back", "title": "First backlog", "order": 0}
        ]));
        assert_eq!(
            next_action_from_kanban(&doc).as_deref(),
            Some("First backlog"),
            "lowest-order Backlog card when no In-Progress exists"
        );
    }

    #[test]
    fn next_action_none_when_only_done() {
        let doc = kanban(serde_json::json!([
            {"id": "z1", "column_id": "c-done", "title": "done", "order": 0}
        ]));
        assert_eq!(next_action_from_kanban(&doc), None);
    }

    // Caso negativo (Kirkardo 7): una task "completada/pasado" NUNCA es elegible.
    #[test]
    fn completed_past_text_is_not_eligible() {
        let now = 1_000_000_000;
        assert!(is_completed_text("commit hecho, se vigilara CI"));
        assert!(!memory_task_eligible(
            "commit hecho, se vigilara CI",
            now,
            now
        ));
        assert!(memory_task_eligible("Implementar fix del resume", now, now));
    }

    // Caso negativo: una task vieja (fuera de 14 días) no es elegible.
    #[test]
    fn stale_task_is_not_eligible() {
        let now = 100_000_000;
        let old = now - (20 * 24 * 60 * 60);
        assert!(!is_recent(old, now));
        assert!(!memory_task_eligible("tarea valida pero vieja", old, now));
    }

    // open_tasks salen del kanban VIVO: In-Progress primero, luego Backlog, y
    // las cards Done NUNCA aparecen (el bug que pudria el resume con memoria).
    #[test]
    fn open_tasks_lists_live_cards_doing_then_backlog_excluding_done() {
        let doc = kanban(serde_json::json!([
            {"id": "d1", "column_id": "c-doing", "title": "En curso", "order": 0},
            {"id": "b2", "column_id": "c-back", "title": "Backlog dos", "order": 1},
            {"id": "b1", "column_id": "c-back", "title": "Backlog uno", "order": 0},
            {"id": "z1", "column_id": "c-done", "title": "Tarea hecha", "order": 0}
        ]));
        let tasks = open_tasks_from_kanban(&doc, 8);
        assert_eq!(tasks, vec!["En curso", "Backlog uno", "Backlog dos"]);
        assert!(
            !tasks.iter().any(|t| t == "Tarea hecha"),
            "las cards Done jamas son open_tasks"
        );
    }

    // Caso negativo: el limite recorta la lista (resume acotado).
    #[test]
    fn open_tasks_respects_limit() {
        let doc = kanban(serde_json::json!([
            {"id": "b1", "column_id": "c-back", "title": "a", "order": 0},
            {"id": "b2", "column_id": "c-back", "title": "b", "order": 1},
            {"id": "b3", "column_id": "c-back", "title": "c", "order": 2}
        ]));
        assert_eq!(open_tasks_from_kanban(&doc, 2), vec!["a", "b"]);
    }
}
