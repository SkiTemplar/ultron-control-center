// ULTRON Control Center 2.0 — Open tabs persistence
//
// Stores the list of open project tabs at `~/.ultron/cockpit/open-tabs.json`.
// Used to restore the tab strip across app restarts.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OpenTab {
    pub id: String,         // "home" | project_id
    pub kind: String,       // "home" | "project"
    pub title: String,
    #[serde(default)]
    pub order: u32,
}

pub fn tabs_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home
        .join(".ultron")
        .join("cockpit")
        .join("open-tabs.json"))
}

pub fn load() -> Result<Vec<OpenTab>, String> {
    let path = tabs_path()?;
    if !path.exists() {
        return Ok(vec![OpenTab {
            id: "home".into(),
            kind: "home".into(),
            title: "Projects".into(),
            order: 0,
        }]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let tabs: Vec<OpenTab> =
        serde_json::from_str(&raw).map_err(|e| format!("parse open-tabs.json: {e}"))?;
    if tabs.iter().any(|t| t.id == "home") {
        Ok(tabs)
    } else {
        let mut prepended = vec![OpenTab {
            id: "home".into(),
            kind: "home".into(),
            title: "Projects".into(),
            order: 0,
        }];
        prepended.extend(tabs);
        Ok(prepended)
    }
}

pub fn save(tabs: &[OpenTab]) -> Result<(), String> {
    let path = tabs_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(tabs).map_err(|e| format!("serialize: {e}"))?;
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(json.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}
