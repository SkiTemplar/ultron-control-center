// ULTRON Control Center — MCP discovery & health module.
//
// Resolves a unified MCP view by joining three sources:
//   1. ~/.claude/settings.json mcpServers       (configured MCPs)
//   2. ~/.ultron/.tmp/mcp-health.json           (last probe results)
//   3. ~/.ultron/config/mcp-fallbacks.yaml      (fallback messages, severity,
//                                                expected_offline flag)
//
// Frontend uses this for the MCPs tab cards. Mutating settings.json is
// intentionally out of scope here — disable is handled in the UI via a
// localStorage hide list. Doing the write-through requires a Claude
// Code restart, which is a deliberate user choice we don't want to
// trigger from a card button click.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shape returned to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct McpInfo {
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args_preview: Option<String>,
    pub url: Option<String>,
    /// "ok" | "degraded" | "missing" | "unknown"
    pub status: String,
    pub last_checked: Option<String>,
    pub fallback_message: Option<String>,
    pub alert_severity: Option<String>,
    pub expected_offline: bool,
}

// ---------------------------------------------------------------------------
// settings.json parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SettingsRoot {
    #[serde(rename = "mcpServers", default)]
    mcp_servers: BTreeMap<String, McpServerCfg>,
}

#[derive(Debug, Deserialize)]
struct McpServerCfg {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default, rename = "type")]
    transport: Option<String>,
}

fn settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/settings.json"))
}

fn parse_settings() -> Result<SettingsRoot, String> {
    let path = settings_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("read settings: {}", e))?;
    serde_json::from_str::<SettingsRoot>(&raw).map_err(|e| format!("parse settings: {}", e))
}

// ---------------------------------------------------------------------------
// mcp-health.json
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct HealthDoc {
    checked_at: Option<String>,
    #[serde(default)]
    results: BTreeMap<String, String>,
}

fn read_health() -> HealthDoc {
    let Some(home) = dirs::home_dir() else {
        return HealthDoc { checked_at: None, results: BTreeMap::new() };
    };
    let path = home.join(".ultron/.tmp/mcp-health.json");
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<HealthDoc>(&raw)
            .unwrap_or(HealthDoc { checked_at: None, results: BTreeMap::new() }),
        Err(_) => HealthDoc { checked_at: None, results: BTreeMap::new() },
    }
}

// ---------------------------------------------------------------------------
// mcp-fallbacks.yaml — handwritten parser (no yaml crate dep)
//
// The schema is shallow and stable. Parsing rule:
//   - Each entry starts with "- mcp_name: <name>"
//   - Following indented lines are scalar key/value until next "- mcp_name"
//   - fallback_message may be multi-line — we capture the line as-is.
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct FallbackEntry {
    fallback_message: Option<String>,
    alert_severity: Option<String>,
    expected_offline: bool,
}

fn parse_fallbacks() -> BTreeMap<String, FallbackEntry> {
    let mut out: BTreeMap<String, FallbackEntry> = BTreeMap::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let path = home.join(".ultron/config/mcp-fallbacks.yaml");
    let Ok(raw) = fs::read_to_string(&path) else {
        return out;
    };

    let mut current_name: Option<String> = None;
    let mut current_entry = FallbackEntry::default();

    for line in raw.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("- mcp_name:") {
            // Flush previous
            if let Some(name) = current_name.take() {
                out.insert(name, std::mem::take(&mut current_entry));
            }
            current_name = Some(rest.trim().trim_matches('"').to_string());
            continue;
        }
        let (key, value) = match trimmed.split_once(':') {
            Some(kv) => kv,
            None => continue,
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        match key {
            "fallback_message" => {
                current_entry.fallback_message = Some(value.to_string());
            }
            "alert_severity" => {
                // Strip trailing inline comment
                let v = value.split('#').next().unwrap_or(value).trim();
                current_entry.alert_severity = Some(v.to_string());
            }
            "expected_offline" => {
                current_entry.expected_offline = value.eq_ignore_ascii_case("true");
            }
            _ => {}
        }
    }
    if let Some(name) = current_name.take() {
        out.insert(name, current_entry);
    }
    out
}

// ---------------------------------------------------------------------------
// Public command
// ---------------------------------------------------------------------------

pub fn list_mcps_inner() -> Result<Vec<McpInfo>, String> {
    let settings = parse_settings()?;
    let health = read_health();
    let fallbacks = parse_fallbacks();

    let mut out: Vec<McpInfo> = Vec::new();
    for (name, cfg) in settings.mcp_servers.iter() {
        let transport = if cfg.transport.as_deref() == Some("sse") {
            "sse".to_string()
        } else if cfg.url.is_some() {
            "http".to_string()
        } else {
            "stdio".to_string()
        };
        let args_preview = if cfg.args.is_empty() {
            None
        } else {
            Some(cfg.args.join(" "))
        };
        let status = health
            .results
            .get(name)
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        let fb = fallbacks.get(name).cloned().unwrap_or_default();

        out.push(McpInfo {
            name: name.clone(),
            transport,
            command: cfg.command.clone(),
            args_preview,
            url: cfg.url.clone(),
            status,
            last_checked: health.checked_at.clone(),
            fallback_message: fb.fallback_message,
            alert_severity: fb.alert_severity,
            expected_offline: fb.expected_offline,
        });
    }
    Ok(out)
}
