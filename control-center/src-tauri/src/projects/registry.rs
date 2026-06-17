// projects/registry.rs — Registry I/O helpers: load, atomic write, path helpers.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Process-wide write lock
// ---------------------------------------------------------------------------
//
// Every mutator does a load-all -> modify -> atomic_write cycle. Without a
// lock, two concurrent Tauri commands (e.g. `create_project` racing with
// `update_project`) both read the same baseline and the second writer
// clobbers the first writer's change — silent data loss. The lock is held
// across the whole read-modify-write so the operation is atomic from the
// caller's point of view. Same pattern as `sessions_tags::SESSIONS_TAGS_WRITE_LOCK`
// and `kg::kg_write_lock`. Pure reads (`list_projects_inner`, `load_items_for`)
// are excluded intentionally.
static PROJECTS_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn projects_lock() -> &'static Mutex<()> {
    PROJECTS_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn registry_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/cockpit/projects.json"))
}

/// Path to the Python project launcher (scripts/cockpit/launch_project.py).
/// v15.4: replaces the legacy `ultron.ps1 open <id>` hop.
pub(crate) fn launch_project_py_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/scripts/cockpit/launch_project.py"))
}

/// Tmp-file + rename atomic write. Used everywhere we touch projects.json
/// so a crash between two writes never leaves the registry truncated.
pub(crate) fn atomic_write(registry: &PathBuf, content: &str) -> Result<(), String> {
    let tmp = registry.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, registry).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

pub(crate) fn load_registry_mut() -> Result<(PathBuf, serde_json::Value), String> {
    let registry = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/cockpit/projects.json");
    let raw =
        std::fs::read_to_string(&registry).map_err(|e| format!("read projects.json: {}", e))?;
    let root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    Ok((registry, root))
}

pub(crate) fn find_entry_mut<'a>(
    root: &'a mut serde_json::Value,
    id: &str,
) -> Result<&'a mut serde_json::Value, String> {
    let projects = root
        .get_mut("projects")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "projects.json has no projects[]".to_string())?;
    projects
        .iter_mut()
        .find(|v| v.get("id").and_then(|x| x.as_str()) == Some(id))
        .ok_or_else(|| format!("project '{}' not found", id))
}

/// CC-08 hardening: defensive sanity check before a path string is
/// interpolated into a PowerShell `-Command` argument. PowerShell
/// single-quoted strings are *literal* (so `;`, `` ` ``, `$`, `&`, `|`
/// inside them don't dispatch), but a malformed projects.json that
/// somehow contains a NUL byte, embedded newline, or path-traversal
/// segment is still pathological — we reject it instead of hoping PS
/// does the right thing.
pub(crate) fn path_ps_safe(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("path is empty".into());
    }
    // Any control char (NUL / CR / LF / etc) is automatic-reject — they
    // would let the path break out of the single-quoted PS payload.
    if path.chars().any(|c| c.is_control()) {
        return Err("path contains control characters".into());
    }
    // Path-traversal sentinel — projects.json must hold canonical
    // absolute paths, not relative `..\..\..` chains.
    if path.contains("..\\") || path.contains("../") {
        return Err("path traversal segments are not allowed".into());
    }
    Ok(())
}

/// Slugify a free-form name into a registry-safe id.
pub(crate) fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}
