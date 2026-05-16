// ULTRON Control Center — Mode (LOW/MEDIUM/HIGH/ULTRA) read/write.
//
// The hook system stores the current/next session mode in
// `~/.ultron/.tmp/current-session.json`. Reading is just JSON parsing.
// Writing stages a different mode by editing the same file — the hooks
// pick it up on next SessionStart.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
pub struct ModeInfo {
    pub mode: Option<String>,
    /// What auto-detect would pick if the user hit "Reset to autodetect" now.
    /// v15.2 F7: the mode-trigger.py hook returns MEDIUM as its baseline and
    /// only escalates to HIGH/ULTRA when the user's prompt matches an
    /// auto-promote keyword. We surface MEDIUM here so the Settings UI can
    /// say "Default (autodetect would pick): MEDIUM".
    pub autodetect_default: String,
    /// True when the on-disk mode field is literally "auto" (i.e. the user
    /// asked the hooks to redetect on the next session).
    pub is_auto: bool,
    pub raw: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
pub struct ModeSetResult {
    pub success: bool,
    pub mode: String,
    pub path: String,
}

fn session_file() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/.tmp/current-session.json"))
}

pub fn get_mode_inner() -> Result<ModeInfo, String> {
    let path = session_file().ok_or_else(|| "no HOME".to_string())?;
    let raw_text = fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let raw: serde_json::Value = serde_json::from_str(&raw_text).unwrap_or(serde_json::json!({}));
    let raw_mode = raw
        .get("mode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            raw.get("MODE")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    let is_auto = matches!(raw_mode.as_deref(), Some(s) if s.eq_ignore_ascii_case("auto"));
    // When the on-disk mode is "auto" or missing the UI should display the
    // resolved label rather than the literal "auto" sentinel.
    let mode = match raw_mode.as_deref() {
        None => None,
        Some(s) if s.eq_ignore_ascii_case("auto") => None,
        Some(_) => raw_mode,
    };
    Ok(ModeInfo {
        mode,
        autodetect_default: "MEDIUM".to_string(),
        is_auto,
        raw,
    })
}

/// Write `mode: "auto"` to current-session.json so the next SessionStart hook
/// runs the autodetect path instead of honouring a stored override. v15.2 F7.
pub fn reset_mode_to_autodetect_inner() -> Result<ModeSetResult, String> {
    let path = session_file().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir tmp: {}", e))?;
        }
    }
    let mut doc: serde_json::Value = match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or(serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    };
    if !doc.is_object() {
        doc = serde_json::json!({});
    }
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("mode".to_string(), serde_json::Value::String("auto".into()));
        // Keep the legacy MODE key in sync so older hooks reading MODE also
        // observe the autodetect sentinel.
        obj.insert("MODE".to_string(), serde_json::Value::String("auto".into()));
    }
    let serialized =
        serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(ModeSetResult {
        success: true,
        mode: "auto".to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

// LIB_RS_WIRING (v15.2 F7):
//   Register one new command in `src-tauri/src/lib.rs` so the frontend can
//   call it via `invoke("reset_mode_to_autodetect")`.
//
//   1. Add a Tauri command wrapper next to `set_ultron_mode`:
//
//        #[tauri::command]
//        async fn reset_mode_to_autodetect() -> Result<mode::ModeSetResult, String> {
//            mode::reset_mode_to_autodetect_inner()
//        }
//
//   2. Add `reset_mode_to_autodetect` to the `tauri::generate_handler![...]`
//      list (same list that already contains `get_ultron_mode` /
//      `set_ultron_mode`).
//
//   The `ModeInfo` struct gained two fields (`autodetect_default`, `is_auto`)
//   — they're additive, so the existing `get_ultron_mode` wrapper does not
//   need any change.

#[derive(Debug, Deserialize)]
pub struct ModeSetPayload {
    pub mode: String,
}

pub fn set_mode_inner(payload: ModeSetPayload) -> Result<ModeSetResult, String> {
    let normalized = payload.mode.trim().to_uppercase();
    if !matches!(normalized.as_str(), "LOW" | "MEDIUM" | "HIGH" | "ULTRA") {
        return Err(format!(
            "invalid mode '{}', expected LOW/MEDIUM/HIGH/ULTRA",
            payload.mode
        ));
    }

    let path = session_file().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir tmp: {}", e))?;
        }
    }

    // Preserve any unknown keys the hooks might rely on — merge in place.
    let mut doc: serde_json::Value = match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or(serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    };
    if !doc.is_object() {
        doc = serde_json::json!({});
    }
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("mode".to_string(), serde_json::Value::String(normalized.clone()));
        // Mirror under the legacy MODE key for any hook that still reads it.
        obj.insert("MODE".to_string(), serde_json::Value::String(normalized.clone()));
    }

    let serialized =
        serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;

    Ok(ModeSetResult {
        success: true,
        mode: normalized,
        path: path.to_string_lossy().to_string(),
    })
}
