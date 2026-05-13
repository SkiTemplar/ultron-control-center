// ULTRON Control Center — Projects module.
//
// Reads ~/.ultron/cockpit/projects.json (registry built by
// scripts/cockpit/scan_projects.py). Exposes a flat list with the fields
// the UI needs for the workspace picker + future Projects tab.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
pub struct ProjectInfo {
    pub id: String,
    pub name: Option<String>,
    pub path: Option<String>,
    pub ide: Option<String>,
    pub language: Option<String>,
    pub type_: Option<String>,
    pub status: Option<String>,
    pub last_active: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ProjectsRoot {
    #[serde(default)]
    projects: Vec<RegEntry>,
}

#[derive(Debug, Deserialize)]
struct RegEntry {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    ide: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default, rename = "type")]
    type_: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    last_active: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

fn registry_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/cockpit/projects.json"))
}

pub fn list_projects_inner() -> Result<Vec<ProjectInfo>, String> {
    let path = registry_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read projects.json: {} ({})", e, path.display()))?;
    let root: ProjectsRoot =
        serde_json::from_str(&raw).map_err(|e| format!("parse projects.json: {}", e))?;

    let mut out: Vec<ProjectInfo> = Vec::with_capacity(root.projects.len());
    for p in root.projects.into_iter() {
        out.push(ProjectInfo {
            id: p.id,
            name: p.name,
            path: p.path,
            ide: p.ide,
            language: p.language,
            type_: p.type_,
            status: p.status,
            last_active: p.last_active,
            tags: p.tags,
        });
    }
    // Sort by last_active desc (ISO yyyy-mm-dd compares lexicographically).
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(out)
}
