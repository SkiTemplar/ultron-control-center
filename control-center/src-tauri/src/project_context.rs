// ULTRON Control Center — Project Context aggregator (v2.9.5)
//
// Loads a rich snapshot for the per-project "Context" sub-tab:
//   - CLAUDE.md content (with path detection across 3 candidate locations)
//   - KG entities related to the project
//   - Active bug cards from the kanban board
//   - decision.jsonl records (optional)
//   - Git summary (branch + last 10 commits)
//   - Next steps (In Progress kanban cards)
//
// All operations are best-effort: an absent git repo or missing file
// returns None/empty rather than failing the whole command. The frontend
// renders each section independently and shows actionable empty states.

use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Public payload types — serialised directly to the frontend
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Git summary
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// KG entities
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Kanban helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// decisions.jsonl
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main aggregator entry point
// ---------------------------------------------------------------------------

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
