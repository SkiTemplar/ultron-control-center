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

use serde::Deserialize as _Deserialize;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize, Clone)]
pub struct ProjectActionResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

fn ultron_ps1_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/scripts/cockpit/ultron.ps1"))
}

/// Spawn `ultron.ps1 open <id>` and return the result. Validates id against
/// a tight charset on the Rust side so the capability layer just needs the
/// generic shape.
pub async fn open_project_inner(
    app: &tauri::AppHandle,
    id: String,
) -> Result<ProjectActionResult, String> {
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!("invalid project id '{}'", id));
    }
    let ps = ultron_ps1_path().ok_or_else(|| "no HOME".to_string())?;
    let ps_str = ps.to_string_lossy().to_string();
    let output = app
        .shell()
        .command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &ps_str,
            "open",
            &id,
        ])
        .output()
        .await
        .map_err(|e| format!("spawn ps: {}", e))?;
    Ok(ProjectActionResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
}

/// Run `ultron.ps1 scan` and return the rescanned project list.
pub async fn scan_projects_inner(app: &tauri::AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let ps = ultron_ps1_path().ok_or_else(|| "no HOME".to_string())?;
    let ps_str = ps.to_string_lossy().to_string();
    let _output = app
        .shell()
        .command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &ps_str,
            "scan",
        ])
        .output()
        .await
        .map_err(|e| format!("spawn ps: {}", e))?;
    // Re-read the registry — the scan rewrites projects.json
    list_projects_inner()
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
