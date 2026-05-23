// ULTRON Control Center 2.0 — Per-project notes domain.
//
// Free-form markdown notes scoped to a single project. Persisted at
// `~/.ultron/cockpit/projects/<project_id>/notes.md`. Atomic writes via
// tmp + rename to match the kanban/projects write discipline.
//
// The body is opaque to us: the renderer is in the frontend (src/lib/markdown.tsx).
// We only sanitise the project_id (the directory name) — never the body.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// Cap the notes file to a sane size so a runaway editor (or a paste from
/// a giant log) doesn't bloat the cockpit directory. 1 MiB is well above
/// any human-authored notes file we expect.
const MAX_NOTES_BYTES: usize = 1024 * 1024;

fn is_safe_project_id(project_id: &str) -> bool {
    !project_id.is_empty()
        && project_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Returns `~/.ultron/cockpit/projects/<project_id>/notes.md` or an error
/// when HOME is missing or the project id contains unsafe characters.
pub fn notes_path(project_id: &str) -> Result<PathBuf, String> {
    if !is_safe_project_id(project_id) {
        return Err(format!("invalid project id '{}'", project_id));
    }
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    Ok(home
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("notes.md"))
}

pub fn load_inner(project_id: &str) -> Result<String, String> {
    let path = notes_path(project_id)?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))
}

pub fn save_inner(project_id: &str, body: &str) -> Result<(), String> {
    if body.len() > MAX_NOTES_BYTES {
        return Err(format!(
            "notes too large ({} bytes, max {})",
            body.len(),
            MAX_NOTES_BYTES
        ));
    }
    let path = notes_path(project_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let tmp = path.with_extension("md.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {}", e))?;
        f.write_all(body.as_bytes()).map_err(|e| format!("write tmp: {}", e))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_project_id() {
        assert!(notes_path("../escape").is_err());
        assert!(notes_path("foo/bar").is_err());
        assert!(notes_path("").is_err());
        assert!(notes_path("ok-id_1.2").is_ok());
    }

    #[test]
    fn rejects_oversize_body() {
        let big = "x".repeat(MAX_NOTES_BYTES + 1);
        let res = save_inner("nope", &big);
        assert!(res.is_err());
    }
}
