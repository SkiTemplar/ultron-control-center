// kanban/archive.rs — kanban archive (named groups for archived Done cards).
//
// Archives live under
//   ~/.ultron/cockpit/projects/<project_id>/archives/<name>.json
// One archive = one named group (e.g. "2026-05-sprint", "v15-cleanup"). The
// frontend "Archive Done" toolbar button writes a new archive containing every
// card currently in any Done/Complete column, then strips those cards from the
// live board.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use super::board_io::{is_done_column, load, now_iso, save};
use super::types_model::{kanban_lock, ArchivedCard, KanbanArchive, KanbanArchiveSummary};

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
/// existing archive -- we append the new batch instead of clobbering it.
pub fn archive_done(project_id: &str, archive_name: &str) -> Result<KanbanArchive, String> {
    let _g = kanban_lock()
        .lock()
        .map_err(|_| "kanban lock poisoned".to_string())?;
    let safe = sanitise_archive_name(archive_name);
    if safe.is_empty() {
        return Err("archive name is empty after sanitisation".into());
    }
    let mut board = load(project_id)?;
    // Resolve the set of Done-ish column ids on the live board using the
    // canonical role when available, falling back to name-based heuristics.
    let done_col_ids: std::collections::HashSet<String> = board
        .columns
        .iter()
        .filter(|c| is_done_column(c))
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
    let path = archive_path(project_id, &safe)?;
    let mut archive = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("read existing archive: {e}"))?;
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
    // Persist the archive atomically -- tmp + rename, same envelope as `save`.
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir archives: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&archive).map_err(|e| format!("serialize: {e}"))?;
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create archive tmp: {e}"))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("write archive tmp: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path).map_err(|e| format!("rename archive: {e}"))?;
    // Strip the archived cards from the live board.
    board.cards.retain(|c| !done_col_ids.contains(&c.column_id));
    save(&board)?;
    Ok(archive)
}

/// List archive summaries (no card payload -- keeps the grid light).
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
    // Newest first -- archived_at is "epoch:<secs>" so lexicographic-desc is
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
