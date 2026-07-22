// Control Center — Feature toggles
//
// The installer writes `~/.ultron/cockpit/features.json` with a flat map of
// booleans (one per togglable area: memory, plans, projects, mcps, skills,
// hooks, notifications, usage, sessions). When a flag is false, the
// corresponding sidebar entry is hidden on the frontend.
//
// v2.1: `gaming` and `personal` were dropped; 2026-07: `schedules` too (no
// tenía zona/consumidor). We deserialize with `deny_unknown_fields = false`
// (serde default) so old features.json files still parse — extra keys like
// a leftover `schedules` are silently ignored.
//
// Defaults: all true. If the file is missing or malformed we return the
// default (everything enabled) so a fresh install never surfaces an empty
// sidebar.
//
// Writes are atomic (tmp + rename) so a crashed save can never leave a
// truncated file on disk.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Features {
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
    // Default false = bypass enabled. Opt-out when true.
    #[serde(default = "default_false")]
    pub claude_safe_mode: bool,
    // card-vis-notif-session-error: notificar (OS + toast) cuando una sesion PTY
    // sale con codigo > 0. Default on.
    #[serde(default = "default_true")]
    pub errors_immediate_notify: bool,
    // card-ux-projects-dashboard-minimalista: nuevo dashboard de proyecto tipo IDE
    // (paneles) detras de flag. Default OFF (opt-in) hasta validacion visual.
    #[serde(default = "default_false")]
    pub projects_dashboard_v2: bool,
}

fn default_true() -> bool {
    true
}

fn default_false() -> bool {
    false
}

impl Default for Features {
    fn default() -> Self {
        Self {
            memory: true,
            plans: true,
            projects: true,
            mcps: true,
            skills: true,
            hooks: true,
            notifications: true,
            usage: true,
            sessions: true,
            claude_safe_mode: false,
            errors_immediate_notify: true,
            projects_dashboard_v2: false,
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

// save_features/save_features_inner eliminados 2026-07-20 (audit cat8): la
// sección Settings→Features nunca se construyó y el comando era inalcanzable.
// Este módulo ahora es solo-lectura; features.json lo escribe el installer.

#[tauri::command]
pub fn read_features() -> Features {
    read_features_inner()
}
