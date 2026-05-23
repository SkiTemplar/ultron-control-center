// ULTRON Control Center 2.0 — Per-project terminal split-pane layout
//
// Persisted at `~/.ultron/cockpit/projects/<project_id>/terminal-layout.json`.
// Atomic writes via tmp + rename, mirroring the kanban.rs pattern. The
// `LayoutNode` is a recursive discriminated union (leaf | split). A leaf may
// reference an existing PTY by id; the frontend reattaches via `pty_list` and
// clears the field when the PTY is dead.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LayoutNode {
    Leaf {
        id: String,
        #[serde(default)]
        pty_id: Option<String>,
    },
    Split {
        direction: SplitDirection,
        ratio: f64,
        left: Box<LayoutNode>,
        right: Box<LayoutNode>,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    H,
    V,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TerminalTab {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub default_provider: Option<String>,
    pub root: LayoutNode,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectTerminalLayout {
    #[serde(default = "default_schema")]
    pub schema_version: u32,
    pub tabs: Vec<TerminalTab>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
}

fn default_schema() -> u32 {
    SCHEMA_VERSION
}

fn now_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    format!("{prefix}-{t}-{n}")
}

/// Returns `~/.ultron/cockpit/projects/<project_id>/terminal-layout.json`.
fn layout_path(project_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("terminal-layout.json"))
}

pub fn default_layout() -> ProjectTerminalLayout {
    let leaf_id = now_id("leaf");
    let tab_id = now_id("tab");
    let tab = TerminalTab {
        id: tab_id.clone(),
        label: "Tab 1".to_string(),
        default_provider: None,
        root: LayoutNode::Leaf {
            id: leaf_id,
            pty_id: None,
        },
    };
    ProjectTerminalLayout {
        schema_version: SCHEMA_VERSION,
        tabs: vec![tab],
        active_tab_id: Some(tab_id),
    }
}

pub fn load_layout(project_id: &str) -> Result<ProjectTerminalLayout, String> {
    let path = layout_path(project_id)?;
    if !path.exists() {
        return Ok(default_layout());
    }
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let layout: ProjectTerminalLayout = serde_json::from_str(&raw)
        .map_err(|e| format!("parse terminal-layout.json: {e}"))?;
    if layout.tabs.is_empty() {
        return Ok(default_layout());
    }
    Ok(layout)
}

pub fn save_layout(project_id: &str, layout: &ProjectTerminalLayout) -> Result<(), String> {
    let path = layout_path(project_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json =
        serde_json::to_string_pretty(layout).map_err(|e| format!("serialize: {e}"))?;
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}
