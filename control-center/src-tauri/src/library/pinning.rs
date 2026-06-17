//! Per-project agent pinning (shared layout with P4 `agents_pinned_*`).

use std::path::PathBuf;

use super::helpers::atomic_write_bytes;
use super::types::PinnedAgents;

fn pinned_path(project_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("pinned-agents.json"))
}

pub fn pinned_load(project_id: &str) -> Result<PinnedAgents, String> {
    let p = pinned_path(project_id)?;
    if !p.exists() {
        return Ok(PinnedAgents::default());
    }
    let txt = std::fs::read_to_string(&p).map_err(|e| format!("read pinned: {e}"))?;
    Ok(serde_json::from_str::<PinnedAgents>(&txt).unwrap_or_default())
}

pub fn pinned_save(project_id: &str, pa: &PinnedAgents) -> Result<(), String> {
    let p = pinned_path(project_id)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let body = serde_json::to_vec_pretty(pa).map_err(|e| format!("ser: {e}"))?;
    atomic_write_bytes(&p, &body)
}

pub fn pin_agent_inner(project_id: &str, slug: &str) -> Result<PinnedAgents, String> {
    let mut pa = pinned_load(project_id)?;
    if !pa.pinned.iter().any(|s| s == slug) {
        pa.pinned.push(slug.to_string());
        pinned_save(project_id, &pa)?;
    }
    Ok(pa)
}

pub fn unpin_agent_inner(project_id: &str, slug: &str) -> Result<PinnedAgents, String> {
    let mut pa = pinned_load(project_id)?;
    pa.pinned.retain(|s| s != slug);
    pinned_save(project_id, &pa)?;
    Ok(pa)
}
