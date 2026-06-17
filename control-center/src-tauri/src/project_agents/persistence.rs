// project_agents/persistence.rs — Roster persistence helpers.
//
// Roster files live at:
//   ~/.ultron/cockpit/projects/<project_id>/agent-roster.json

use std::fs;
use std::path::PathBuf;

use crate::ultron_root;

use super::types::AgentRosterFile;

fn roster_path(project_id: &str) -> Result<PathBuf, String> {
    let root = ultron_root()?;
    Ok(root
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("agent-roster.json"))
}

pub fn roster_load(project_id: &str) -> Result<AgentRosterFile, String> {
    let path = roster_path(project_id)?;
    if !path.exists() {
        return Ok(AgentRosterFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read roster: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse roster: {e}"))
}

pub fn roster_save(project_id: &str, file: &AgentRosterFile) -> Result<(), String> {
    let path = roster_path(project_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(file).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}
