//! Path resolution and filesystem utilities shared across library sub-modules.

use std::path::{Path, PathBuf};

use super::types::TargetScope;

pub(super) fn claude_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home.join(".claude"))
}

pub(super) fn project_root(project_id: &str) -> Result<PathBuf, String> {
    let projects = crate::projects::list_projects_inner()?;
    projects
        .into_iter()
        .find(|p| p.id == project_id)
        .and_then(|p| p.path.map(PathBuf::from))
        .ok_or_else(|| format!("project not found or has no path: {project_id}"))
}

pub(super) fn resolve_agent_target(
    name: &str,
    scope: TargetScope,
    project_id: Option<&str>,
) -> Result<PathBuf, String> {
    let base = match scope {
        TargetScope::Global => claude_root()?,
        TargetScope::Project => {
            let pid = project_id
                .ok_or_else(|| "target_project_id required for project scope".to_string())?;
            project_root(pid)?.join(".claude")
        }
    };
    Ok(base.join("agents").join(format!("{}.md", name)))
}

pub(super) fn resolve_skill_dir(
    name: &str,
    scope: TargetScope,
    project_id: Option<&str>,
) -> Result<PathBuf, String> {
    let base = match scope {
        TargetScope::Global => claude_root()?,
        TargetScope::Project => {
            let pid = project_id
                .ok_or_else(|| "target_project_id required for project scope".to_string())?;
            project_root(pid)?.join(".claude")
        }
    };
    Ok(base.join("skills").join(name))
}

pub(super) fn is_kebab(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
}

/// tmp + rename atomic write — same discipline as the rest of the
/// crate (see `projects::atomic_write`).
pub(super) fn atomic_write_bytes(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = target.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, target).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

pub(super) fn ultron_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron"))
        .ok_or_else(|| "No HOME dir".to_string())
}
