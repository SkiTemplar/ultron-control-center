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

#[cfg(test)]
mod tests {
    use super::super::types::RosterEntry;
    use super::*;

    #[test]
    fn roster_roundtrip_and_missing_project() {
        let pid = format!("test-roster-{}", std::process::id());
        let file = AgentRosterFile {
            entries: vec![RosterEntry {
                name: "debugger".into(),
                reason: "bugs del stack".into(),
                suggested_role: "QA".into(),
            }],
        };
        roster_save(&pid, &file).expect("save");
        let loaded = roster_load(&pid).expect("load");
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(loaded.entries[0].name, "debugger");
        assert_eq!(loaded.entries[0].reason, "bugs del stack");
        assert_eq!(loaded.entries[0].suggested_role, "QA");

        // Contract: a project without agent-roster.json yields Ok with an
        // empty default roster, never Err (persistence.rs early-return).
        let missing =
            roster_load("proyecto-que-no-existe-xyz").expect("missing roster must be Ok(default)");
        assert!(missing.entries.is_empty());

        // Cleanup: remove only the test project dir created above.
        if let Some(home) = dirs::home_dir() {
            let _ = fs::remove_dir_all(
                home.join(".ultron")
                    .join("cockpit")
                    .join("projects")
                    .join(&pid),
            );
        }
    }
}
