// ULTRON Control Center — Project Context aggregator (v2.9.5)
//
// Loads a rich snapshot for the per-project "Context" sub-tab:
//   - CLAUDE.md content (with path detection across 3 candidate locations)
//   - Mem0 memories searched by project name
//   - KG entities related to the project
//   - Active bug cards from the kanban board
//   - decision.jsonl records (optional)
//   - Git summary (branch + last 10 commits)
//   - Next steps (In Progress kanban cards)
//
// All operations are best-effort: a missing Mem0 key or absent git repo
// returns None/empty rather than failing the whole command. The frontend
// renders each section independently and shows actionable empty states.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

// ---------------------------------------------------------------------------
// Public payload types — serialised directly to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectContextPayload {
    /// Raw markdown content (None = file does not exist yet)
    pub claude_md: Option<String>,
    /// Absolute path where CLAUDE.md was found or would be created
    pub claude_md_path: Option<String>,
    /// Memories retrieved from Mem0 (up to 5 most recent)
    pub mem0_entries: Vec<Mem0Entry>,
    /// KG entities whose observations/relations mention this project
    pub kg_entities: Vec<KgEntitySnap>,
    /// Kanban cards tagged "bug" in non-Done columns
    pub recent_bugs: Vec<KanbanCardSnap>,
    /// Entries from decisions.jsonl (may be empty if file absent)
    pub recent_decisions: Vec<DecisionRecordSnap>,
    /// Git branch + last 10 commits (None if not a git repo)
    pub git_summary: Option<GitSummary>,
    /// In-Progress kanban cards (title only)
    pub next_steps: Vec<String>,
    /// Human-readable explanation when Mem0 is not configured
    pub mem0_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mem0Entry {
    pub id: String,
    pub memory: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KgEntitySnap {
    pub name: String,
    pub entity_type: String,
    /// First two observations for context
    pub observations: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KanbanCardSnap {
    pub id: String,
    pub title: String,
    pub column_name: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DecisionRecordSnap {
    pub title: Option<String>,
    pub date: Option<String>,
    pub status: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitSummary {
    pub branch: String,
    pub commits: Vec<String>,
}

// ---------------------------------------------------------------------------
// CLAUDE.md resolution
// ---------------------------------------------------------------------------

/// Candidate locations searched in priority order.
/// Returns (path, exists) for the first match; if none exist returns the
/// preferred creation location with exists=false.
pub fn resolve_claude_md(project_path: &str) -> (PathBuf, bool) {
    let root = Path::new(project_path);
    let candidates = [
        root.join("CLAUDE.md"),
        root.join(".claude").join("CLAUDE.md"),
        root.join(".github").join("CLAUDE.md"),
    ];
    for c in &candidates {
        if c.exists() {
            return (c.clone(), true);
        }
    }
    // Default creation target: <root>/CLAUDE.md
    (candidates[0].clone(), false)
}

fn load_claude_md(project_path: &str) -> (Option<String>, Option<String>) {
    let (path, exists) = resolve_claude_md(project_path);
    let path_str = path.to_string_lossy().into_owned();
    if !exists {
        return (None, Some(path_str));
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => (Some(content), Some(path_str)),
        Err(_) => (None, Some(path_str)),
    }
}

// ---------------------------------------------------------------------------
// Git summary
// ---------------------------------------------------------------------------

fn load_git_summary(project_path: &str) -> Option<GitSummary> {
    // branch
    let branch_out = Command::new("git")
        .args(["-C", project_path, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !branch_out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();

    // last 10 commits oneline
    let log_out = Command::new("git")
        .args(["-C", project_path, "log", "--oneline", "-10"])
        .output()
        .ok()?;
    let commits = String::from_utf8_lossy(&log_out.stdout)
        .lines()
        .map(|l| l.to_string())
        .collect();

    Some(GitSummary { branch, commits })
}

// ---------------------------------------------------------------------------
// KG entities
// ---------------------------------------------------------------------------

fn load_kg_entities(project_name: &str, project_path: &str) -> Vec<KgEntitySnap> {
    let graph = match crate::kg::read_graph_inner() {
        Ok(g) => g,
        Err(_) => return vec![],
    };
    let name_lc = project_name.to_lowercase();
    let path_lc = project_path.to_lowercase();

    graph
        .entities
        .into_iter()
        .filter(|e| {
            let obs_match = e.observations.iter().any(|o| {
                o.to_lowercase().contains(&name_lc) || o.to_lowercase().contains(&path_lc)
            });
            let name_match = e.name.to_lowercase().contains(&name_lc);
            obs_match || name_match
        })
        .map(|e| KgEntitySnap {
            name: e.name,
            entity_type: e.entity_type,
            observations: e.observations.into_iter().take(2).collect(),
        })
        .take(10)
        .collect()
}

// ---------------------------------------------------------------------------
// Kanban helpers
// ---------------------------------------------------------------------------

fn load_kanban_bugs_and_steps(project_id: &str) -> (Vec<KanbanCardSnap>, Vec<String>) {
    let board = match crate::kanban::load(project_id) {
        Ok(b) => b,
        Err(_) => return (vec![], vec![]),
    };

    // Build column_id → name map
    let col_name: std::collections::HashMap<String, String> = board
        .columns
        .iter()
        .map(|c| (c.id.clone(), c.name.clone()))
        .collect();

    // "Done" column ids (case-insensitive match)
    let done_ids: std::collections::HashSet<String> = board
        .columns
        .iter()
        .filter(|c| c.name.to_lowercase() == "done")
        .map(|c| c.id.clone())
        .collect();

    // "In Progress" column ids
    let in_progress_ids: std::collections::HashSet<String> = board
        .columns
        .iter()
        .filter(|c| c.name.to_lowercase().contains("progress"))
        .map(|c| c.id.clone())
        .collect();

    let mut bugs: Vec<KanbanCardSnap> = Vec::new();
    let mut next_steps: Vec<String> = Vec::new();

    for card in &board.cards {
        let is_done = done_ids.contains(&card.column_id);
        let is_in_progress = in_progress_ids.contains(&card.column_id);
        let col_name_str = col_name.get(&card.column_id).cloned().unwrap_or_default();

        if !is_done && card.tags.iter().any(|t| t.to_lowercase() == "bug") {
            bugs.push(KanbanCardSnap {
                id: card.id.clone(),
                title: card.title.clone(),
                column_name: col_name_str.clone(),
                tags: card.tags.clone(),
            });
        }

        if is_in_progress {
            next_steps.push(card.title.clone());
        }
    }

    bugs.sort_by(|a, b| a.column_name.cmp(&b.column_name));
    (bugs, next_steps)
}

// ---------------------------------------------------------------------------
// decisions.jsonl
// ---------------------------------------------------------------------------

fn load_decisions(project_id: &str) -> Vec<DecisionRecordSnap> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return vec![],
    };
    let path = home
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("decisions.jsonl");

    if !path.exists() {
        return vec![];
    }

    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return vec![],
    };

    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let v: serde_json::Value = serde_json::from_str(line).ok()?;
            Some(DecisionRecordSnap {
                title: v
                    .get("title")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                date: v
                    .get("date")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                status: v
                    .get("status")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                summary: v
                    .get("summary")
                    .or_else(|| v.get("context"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
            })
        })
        .rev() // most recent first
        .take(10)
        .collect()
}

// ---------------------------------------------------------------------------
// Mem0 — search by project name
// ---------------------------------------------------------------------------

async fn load_mem0_entries(
    project_name: &str,
    project_id: &str,
) -> (Vec<Mem0Entry>, Option<String>) {
    // Try search by project name first (most relevant), fall back to list_all by project_id.
    // Both operations are best-effort — a missing API key returns empty + error message.
    let search_result = crate::mem0::search_inner(
        project_name.to_string(),
        Some(project_id.to_string()),
        Some(20),
    )
    .await;

    match search_result {
        Ok(memories) => {
            let entries: Vec<Mem0Entry> = memories
                .into_iter()
                .filter(|m| !m.memory.is_empty())
                .take(5)
                .map(|m| Mem0Entry {
                    id: m.id,
                    memory: m.memory,
                    created_at: m.created_at,
                })
                .collect();
            (entries, None)
        }
        Err(e) => {
            // Surface the error but don't fail the whole command
            (vec![], Some(e))
        }
    }
}

// ---------------------------------------------------------------------------
// Main aggregator entry point
// ---------------------------------------------------------------------------

pub async fn load_inner(
    project_id: String,
    project_name: String,
    project_path: String,
) -> Result<ProjectContextPayload, String> {
    // All sections run concurrently where possible. Mem0 is async;
    // the rest are sync blocking calls wrapped to not block the executor.

    let path_clone = project_path.clone();
    let id_clone = project_id.clone();
    let name_clone = project_name.clone();

    // Spawn sync work onto the blocking thread pool
    let sync_handle = tauri::async_runtime::spawn_blocking(move || {
        let (claude_md, claude_md_path) = load_claude_md(&path_clone);
        let git_summary = load_git_summary(&path_clone);
        let kg_entities = load_kg_entities(&name_clone, &path_clone);
        let (recent_bugs, next_steps) = load_kanban_bugs_and_steps(&id_clone);
        let recent_decisions = load_decisions(&id_clone);
        (
            claude_md,
            claude_md_path,
            git_summary,
            kg_entities,
            recent_bugs,
            next_steps,
            recent_decisions,
        )
    });

    // Await both: sync first (cheap, local FS), then Mem0 (network, may be slow)
    let (
        claude_md,
        claude_md_path,
        git_summary,
        kg_entities,
        recent_bugs,
        mut next_steps,
        recent_decisions,
    ) = sync_handle
        .await
        .map_err(|e| format!("blocking task panicked: {e}"))?;

    let (mem0_entries, mem0_error) = load_mem0_entries(&project_name, &project_id).await;

    // Append Mem0 next_steps suggestions (search "next_steps" on global user)
    // — done lazily here from the already-fetched mem0_entries to avoid an extra
    // network call. If a memory contains "next step" keywords, surface it.
    let mem0_next: Vec<String> = mem0_entries
        .iter()
        .filter(|m| {
            let lc = m.memory.to_lowercase();
            lc.contains("next step") || lc.contains("próximo") || lc.contains("pendiente")
        })
        .map(|m| {
            // Truncate long memories to 80 chars for the next-steps strip
            if m.memory.len() > 80 {
                format!("{}…", &m.memory[..80])
            } else {
                m.memory.clone()
            }
        })
        .take(3)
        .collect();

    next_steps.extend(mem0_next);

    // Normalise project path for display (strip Windows \\?\ prefix)
    let claude_md_path_display =
        claude_md_path.map(|p| p.strip_prefix(r"\\?\").unwrap_or(&p).to_string());

    Ok(ProjectContextPayload {
        claude_md,
        claude_md_path: claude_md_path_display,
        mem0_entries,
        kg_entities,
        recent_bugs,
        recent_decisions,
        git_summary,
        next_steps,
        mem0_error,
    })
}

// ---------------------------------------------------------------------------
// CLAUDE.md creator — generates a starter template
// ---------------------------------------------------------------------------

pub fn create_claude_md_stub(project_path: &str, project_name: &str) -> Result<String, String> {
    let (path, exists) = resolve_claude_md(project_path);
    if exists {
        return Err("CLAUDE.md already exists".to_string());
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }

    let content = format!(
        "# {name}\n\
        \n\
        ## Project overview\n\
        \n\
        <!-- Describe what this project does in 2-3 sentences -->\n\
        \n\
        ## Stack\n\
        \n\
        <!-- List main technologies: language, frameworks, databases -->\n\
        \n\
        ## Key entry points\n\
        \n\
        <!-- Where does the main logic live? e.g. src/main.rs, src/index.ts -->\n\
        \n\
        ## Common commands\n\
        \n\
        ```bash\n\
        # build\n\
        # test\n\
        # run\n\
        ```\n\
        \n\
        ## Conventions\n\
        \n\
        <!-- Style rules, naming conventions, patterns an agent should know -->\n\
        \n\
        ## Project path\n\
        \n\
        `{path}`\n",
        name = project_name,
        path = project_path,
    );

    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, &content).map_err(|e| format!("write: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;

    Ok(content)
}
