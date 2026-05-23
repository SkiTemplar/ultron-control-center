//! Control Center 2.0 — ECC plugin cache introspection.
//!
//! Reads `~/.claude/plugins/cache/ecc/ecc/<version>/` and reports:
//! - latest installed version,
//! - last-update mtime,
//! - counts of skills/agents/hooks/MCPs in that version dir.

use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub root: Option<String>,
    pub last_update_iso: Option<String>,
    pub skills_count: usize,
    pub agents_count: usize,
    pub hooks_count: usize,
    pub mcp_servers_count: usize,
}

pub fn read_plugin_info_inner() -> Result<PluginInfo, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let base = home
        .join(".claude")
        .join("plugins")
        .join("cache")
        .join("ecc")
        .join("ecc");
    if !base.exists() {
        return Ok(PluginInfo {
            installed: false,
            version: None,
            root: None,
            last_update_iso: None,
            skills_count: 0,
            agents_count: 0,
            hooks_count: 0,
            mcp_servers_count: 0,
        });
    }
    // Pick the latest version dir by mtime (NOT by lexical version — RC pre-releases
    // sort lower than stable but we want the most-recently-installed).
    let mut versions: Vec<(PathBuf, SystemTime)> = std::fs::read_dir(&base)
        .map_err(|e| format!("read base: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let p = e.path();
            let m = e.metadata().ok()?.modified().ok()?;
            Some((p, m))
        })
        .collect();
    versions.sort_by(|a, b| b.1.cmp(&a.1));
    let Some((root, mtime)) = versions.into_iter().next() else {
        return Ok(PluginInfo {
            installed: false,
            version: None,
            root: Some(base.display().to_string()),
            last_update_iso: None,
            skills_count: 0,
            agents_count: 0,
            hooks_count: 0,
            mcp_servers_count: 0,
        });
    };

    let version = root
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());

    let skills_count = count_subdirs_with(&root.join("skills"), "SKILL.md");
    let agents_count = count_files_matching(&root.join("agents"), "md");
    let hooks_count = count_files_matching(&root.join("hooks"), "json");
    let mcp_servers_count = count_mcp_servers(&root);

    let last_update_iso = mtime_to_iso(mtime);

    Ok(PluginInfo {
        installed: true,
        version,
        root: Some(root.display().to_string()),
        last_update_iso,
        skills_count,
        agents_count,
        hooks_count,
        mcp_servers_count,
    })
}

fn count_subdirs_with(dir: &std::path::Path, child: &str) -> usize {
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir() && e.path().join(child).exists())
                .count()
        })
        .unwrap_or(0)
}

fn count_files_matching(dir: &std::path::Path, ext: &str) -> usize {
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some(ext))
                .count()
        })
        .unwrap_or(0)
}

fn count_mcp_servers(root: &std::path::Path) -> usize {
    let p = root.join("mcp-configs").join("mcp-servers.json");
    let Ok(txt) = std::fs::read_to_string(&p) else { return 0 };
    let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&txt) else { return 0 };
    json.get("mcpServers")
        .and_then(|v| v.as_object())
        .map(|m| m.len())
        .unwrap_or_else(|| json.as_object().map(|m| m.len()).unwrap_or(0))
}

fn mtime_to_iso(t: SystemTime) -> Option<String> {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    Some(dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}
