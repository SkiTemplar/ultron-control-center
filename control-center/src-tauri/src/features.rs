// ULTRON Control Center — Feature toggles
//
// The installer writes `~/.ultron/cockpit/features.json` with a flat map of
// booleans (one per togglable area: gaming, personal, schedules, memory,
// plans, projects, mcps, skills, hooks, notifications, usage, sessions).
// When a flag is false, the corresponding sidebar entry is hidden on the
// frontend.
//
// Defaults: all true. If the file is missing or malformed we return the
// default (everything enabled) so a fresh install never surfaces an empty
// sidebar. Partial JSON (only some keys present) is fine — serde fills the
// gaps via `default_true`.
//
// Writes are atomic (tmp + rename) so a crashed save can never leave a
// truncated file on disk.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Features {
    #[serde(default = "default_true")]
    pub gaming: bool,
    #[serde(default = "default_true")]
    pub personal: bool,
    #[serde(default = "default_true")]
    pub schedules: bool,
    #[serde(default = "default_true")]
    pub memory: bool,
    #[serde(default = "default_true")]
    pub plans: bool,
    #[serde(default = "default_true")]
    pub projects: bool,
    #[serde(default = "default_true")]
    pub mcps: bool,
    #[serde(default = "default_true")]
    pub skills: bool,
    #[serde(default = "default_true")]
    pub hooks: bool,
    // v15.4 — added to mirror the installer wizard's expanded toggle set.
    #[serde(default = "default_true")]
    pub notifications: bool,
    #[serde(default = "default_true")]
    pub usage: bool,
    #[serde(default = "default_true")]
    pub sessions: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Features {
    fn default() -> Self {
        Self {
            gaming: true,
            personal: true,
            schedules: true,
            memory: true,
            plans: true,
            projects: true,
            mcps: true,
            skills: true,
            hooks: true,
            notifications: true,
            usage: true,
            sessions: true,
        }
    }
}

fn features_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/cockpit/features.json"))
}

pub fn read_features_inner() -> Features {
    let Some(path) = features_path() else {
        return Features::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return Features::default();
    };
    // Malformed JSON falls back to default. Partial JSON (missing keys) is
    // fine — serde's `default = "default_true"` fills the gaps.
    serde_json::from_str::<Features>(&text).unwrap_or_default()
}

pub fn save_features_inner(features: Features) -> Result<(), String> {
    // Serde already enforces the bool-only invariant: deserialization of a
    // non-bool value into `bool` fails before this function ever runs.
    let path = features_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir cockpit: {}", e))?;
        }
    }
    let serialized =
        serde_json::to_string_pretty(&features).map_err(|e| format!("serialize: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn read_features() -> Features {
    read_features_inner()
}

#[tauri::command]
pub fn save_features(features: Features) -> Result<(), String> {
    save_features_inner(features)
}
