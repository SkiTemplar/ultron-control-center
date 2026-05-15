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
    let mode = raw
        .get("mode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            raw.get("MODE")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    Ok(ModeInfo { mode, raw })
}

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
