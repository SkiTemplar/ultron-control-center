// ULTRON Control Center — Agents module.
//
// Agents live under ~/.claude/agents/ as markdown files with YAML
// frontmatter:
//
//   ---
//   name: ultron-arch
//   description: ...
//   tools: Read, Glob, Grep
//   model: claude-sonnet-5
//   ---
//
//   <body — system prompt / role description>
//
// Same shape as skills, different semantics: agents are autonomous role
// definitions Claude Code can spawn as subagents. We expose them in the
// Control Center with the same UX as Skills (list / preview / edit /
// delete / AI-assist) so installing or curating a community agent feels
// identical to a skill.
//
// Security pass (PI001-PI013): the same Python scanner that grades
// SKILL.md files (`skill_sync_security.py`) is reused with the
// `--target-type agent` flag, and the resulting findings are surfaced
// in the Agents tab. Waivers go to the same `skill-trust.yaml` file but
// carry `target_type: "agent"` so the scanner can disambiguate them
// from skill waivers that share the same name (very unlikely, but the
// schema is explicit anyway).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

fn agents_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/agents"))
}

#[derive(Debug, Serialize)]
pub struct AgentMutationResult {
    pub success: bool,
    pub name: String,
    pub path: String,
    pub backup_path: Option<String>,
}

pub fn update_agent_md_inner(name: String, content: String) -> Result<AgentMutationResult, String> {
    validate_slug(&name)?;
    let dir = agents_dir().ok_or_else(|| "no HOME".to_string())?;
    let path = dir.join(format!("{}.md", name));
    if !path.is_file() {
        return Err(format!("agent not found: {}", path.display()));
    }
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let backup_dir = home.join(".ultron/backups/agent-edits");
    fs::create_dir_all(&backup_dir).map_err(|e| format!("mkdir backups: {}", e))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup_path = backup_dir.join(format!("{}-{}.md", name, ts));
    fs::copy(&path, &backup_path).map_err(|e| format!("backup: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("write: {}", e))?;
    Ok(AgentMutationResult {
        success: true,
        name,
        path: path.to_string_lossy().to_string(),
        backup_path: Some(backup_path.to_string_lossy().to_string()),
    })
}

fn validate_slug(name: &str) -> Result<(), String> {
    let len = name.len();
    if !(2..=61).contains(&len) {
        return Err(format!("invalid slug length ({}): 2..=61 expected", len));
    }
    let bytes = name.as_bytes();
    if !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) {
        return Err("slug must start with [a-z0-9]".to_string());
    }
    for &b in &bytes[1..] {
        if !(b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err("slug allowed chars: [a-z0-9-]".to_string());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Origin-aware listing (Control Center 2.0 / P2)
//
// New `AgentEntry` shape that surfaces the *origin* of every agent
// (global / project / plugin) so Agents.tsx can paint scope chips. Lives
// alongside the registry-style `AgentInfo` (still used by the CRUD path).
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub enum AgentOrigin {
    #[serde(rename = "global")]
    Global,
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "plugin")]
    Plugin,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentEntry {
    pub name: String,
    pub path: String,
    pub description: String,
    pub origin: AgentOrigin,
    /// `false` when the agent file lives at `<name>.md.disabled` instead of
    /// `<name>.md`. Mirrors the same disable convention skills use so the
    /// Library tab can render Active/Disabled toggles uniformly.
    pub enabled: bool,
}

fn global_agents_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    Ok(home.join(".claude").join("agents"))
}

fn project_agents_dir(project_path: &str) -> PathBuf {
    PathBuf::from(project_path).join(".claude").join("agents")
}

/// Plugin agents live three levels deep:
/// `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/agents/`.
/// For each `<marketplace>/<plugin>` pair we keep only the latest version dir
/// (sorted lex desc). Each entry carries `disabled = true` when the plugin is
/// turned off in settings.json `enabledPlugins` (casilla 2.2): its agents are
/// inert and must NOT be counted as active (mand. 11/13).
fn plugin_agents_dirs() -> Vec<(bool, PathBuf)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let cache = home.join(".claude").join("plugins").join("cache");
    let enabled = crate::plugin_state::read_enabled_plugins();
    let mut out = Vec::new();
    let Ok(marketplaces) = std::fs::read_dir(&cache) else {
        return out;
    };
    for mkt_entry in marketplaces.flatten() {
        let mkt_path = mkt_entry.path();
        if !mkt_path.is_dir() {
            continue;
        }
        let marketplace = mkt_entry.file_name().to_string_lossy().to_string();
        let Ok(plugin_names) = std::fs::read_dir(&mkt_path) else {
            continue;
        };
        for pname_entry in plugin_names.flatten() {
            let pname_path = pname_entry.path();
            if !pname_path.is_dir() {
                continue;
            }
            let plugin = pname_entry.file_name().to_string_lossy().to_string();
            let disabled = crate::plugin_state::plugin_is_disabled(&plugin, &marketplace, &enabled);
            let mut versions: Vec<PathBuf> = match std::fs::read_dir(&pname_path) {
                Ok(rd) => rd
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .collect(),
                Err(_) => continue,
            };
            versions.sort_by(|a, b| {
                let an = a.file_name().and_then(|s| s.to_str()).unwrap_or("");
                let bn = b.file_name().and_then(|s| s.to_str()).unwrap_or("");
                bn.cmp(an)
            });
            if let Some(latest) = versions.first() {
                let agents = latest.join("agents");
                if agents.is_dir() {
                    out.push((disabled, agents));
                }
            }
        }
    }
    out
}

/// Parse `(name, description, is_valid_agent)` from an agent .md file.
/// A real agent is a markdown file whose YAML frontmatter declares at
/// least `name:` and `description:`. README.md / docs are rejected.
fn read_agent_meta(path: &Path) -> (String, String, bool) {
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("(unnamed)")
        .to_string();
    let contents = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (name, String::new(), false),
    };
    let trimmed = contents.trim_start();
    if !trimmed.starts_with("---") {
        return (name, String::new(), false);
    }
    let Some(end) = trimmed[3..].find("\n---") else {
        return (name, String::new(), false);
    };
    let block = &trimmed[3..3 + end];
    let mut has_name = false;
    let mut has_description = false;
    let mut description = String::new();
    for raw in block.lines() {
        let t = raw.trim();
        if let Some(rest) = t.strip_prefix("name:") {
            if !rest.trim().is_empty() {
                has_name = true;
            }
        } else if let Some(rest) = t.strip_prefix("description:") {
            let v = rest.trim().trim_matches(|c| c == '"' || c == '\'');
            if !v.is_empty() {
                has_description = true;
                description = v.to_string();
            }
        }
    }
    (name, description, has_name && has_description)
}

fn collect_agents_from(root: &Path, origin: AgentOrigin, plugin_disabled: bool) -> Vec<AgentEntry> {
    let mut out = Vec::new();
    if !root.exists() {
        return out;
    }
    if let Ok(entries) = fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            // Accept either <name>.md (enabled) or <name>.md.disabled
            // (disabled via the same suffix convention skills use).
            //
            // Case handling: filesystem case-sensitivity differs (NTFS is
            // case-insensitive but preserving, Linux ext4 is sensitive).
            // We MATCH the suffix case-insensitively but PRESERVE the
            // original stem case so the resulting AgentEntry.name lines up
            // with the markdown frontmatter and the actual file path
            // (KIRKARDO 2 HIGH — previous lowercasing produced
            // `MyAgent.md` → stem="myagent" mismatching the frontmatter).
            let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let fname_lower = fname.to_ascii_lowercase();
            let (enabled, stem_len) =
                if let Some(idx) = fname_lower.strip_suffix(".md.disabled").map(|s| s.len()) {
                    (false, idx)
                } else if let Some(idx) = fname_lower.strip_suffix(".md").map(|s| s.len()) {
                    (true, idx)
                } else {
                    continue;
                };
            let stem = &fname[..stem_len];
            // Skip non-agent files (README.md, CHANGELOG.md, etc.) that
            // happen to share the agents dir. Compare case-insensitively.
            let stem_lower = stem.to_ascii_lowercase();
            if stem_lower == "readme" || stem_lower == "changelog" || stem_lower == "license" {
                continue;
            }
            let (name, description, valid) = read_agent_meta(&p);
            if !valid {
                continue;
            }
            out.push(AgentEntry {
                name,
                path: p.to_string_lossy().to_string(),
                description,
                origin: origin.clone(),
                // Plugin disabled in settings.json => its agents are inert (2.2).
                enabled: enabled && !plugin_disabled,
            });
        }
    }
    out
}

pub fn list_agents_with_origin_inner(
    project_path: Option<String>,
) -> Result<Vec<AgentEntry>, String> {
    let mut out = Vec::new();
    if let Ok(g) = global_agents_dir() {
        out.extend(collect_agents_from(&g, AgentOrigin::Global, false));
    }
    if let Some(p) = project_path.as_deref() {
        let pdir = project_agents_dir(p);
        out.extend(collect_agents_from(&pdir, AgentOrigin::Project, false));
    }
    for (disabled, plugin_dir) in plugin_agents_dirs() {
        out.extend(collect_agents_from(
            &plugin_dir,
            AgentOrigin::Plugin,
            disabled,
        ));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Toggle a global agent between `<name>.md` and `<name>.md.disabled`.
/// Mirrors `skills::skill_toggle_inner` but operates on .md files (agents
/// are single files, not directories).
pub fn agent_toggle_inner(name: String, enabled: bool) -> Result<AgentEntry, String> {
    // Reject path separators, `..`, null bytes, control chars, and any
    // non-ASCII-printable character (KIRKARDO 3 MED). The frontend only
    // ever passes slugs derived from filenames we just listed, so the
    // strict allowlist is safe in practice and closes the residual risk
    // of a unicode-confusable name slipping through to fs::rename.
    if name.is_empty() || name.len() > 128 {
        return Err("invalid agent name: empty or too long".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || name.contains("..")
        || name.starts_with('.')
    {
        return Err(
            "invalid agent name: only [a-zA-Z0-9_-.] allowed, no leading dot or '..'".to_string(),
        );
    }
    let root = global_agents_dir()?;
    let path_enabled = root.join(format!("{}.md", name));
    let path_disabled = root.join(format!("{}.md.disabled", name));

    if enabled {
        if !path_disabled.exists() {
            return Err(format!(
                "agent '{name}' not found in disabled state (expected {})",
                path_disabled.display()
            ));
        }
        if path_enabled.exists() {
            return Err(format!("agent '{name}' already exists at enabled path"));
        }
        fs::rename(&path_disabled, &path_enabled)
            .map_err(|e| format!("rename {:?} → {:?}: {e}", path_disabled, path_enabled))?;
        let (n, desc, _) = read_agent_meta(&path_enabled);
        Ok(AgentEntry {
            name: if n == "(unnamed)" { name } else { n },
            path: path_enabled.to_string_lossy().to_string(),
            description: desc,
            origin: AgentOrigin::Global,
            enabled: true,
        })
    } else {
        if !path_enabled.exists() {
            return Err(format!(
                "agent '{name}' not found at enabled path (expected {})",
                path_enabled.display()
            ));
        }
        if path_disabled.exists() {
            return Err(format!("agent '{name}' already disabled"));
        }
        fs::rename(&path_enabled, &path_disabled)
            .map_err(|e| format!("rename {:?} → {:?}: {e}", path_enabled, path_disabled))?;
        let (n, desc, _) = read_agent_meta(&path_disabled);
        Ok(AgentEntry {
            name: if n == "(unnamed)" { name } else { n },
            path: path_disabled.to_string_lossy().to_string(),
            description: desc,
            origin: AgentOrigin::Global,
            enabled: false,
        })
    }
}

/// Per-item outcome of a bulk toggle. `error` is `None` on success.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BulkToggleOutcome {
    pub name: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Aggregate result of `agents_bulk_toggle`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BulkToggleResult {
    pub requested: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub outcomes: Vec<BulkToggleOutcome>,
}

/// Enable or disable many global agents in one call. `disabled = true` moves
/// each `<name>.md` to `<name>.md.disabled`; `disabled = false` reverses it.
///
/// Loops the existing `agent_toggle_inner` so the on-disk convention stays
/// identical to the single-item path. Failures are collected per-item rather
/// than aborting the whole batch.
pub fn agents_bulk_toggle_inner(
    names: Vec<String>,
    disabled: bool,
) -> Result<BulkToggleResult, String> {
    let enabled = !disabled;
    let mut outcomes: Vec<BulkToggleOutcome> = Vec::with_capacity(names.len());
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    for name in &names {
        match agent_toggle_inner(name.clone(), enabled) {
            Ok(_) => {
                succeeded += 1;
                outcomes.push(BulkToggleOutcome {
                    name: name.clone(),
                    ok: true,
                    error: None,
                });
            }
            Err(e) => {
                failed += 1;
                outcomes.push(BulkToggleOutcome {
                    name: name.clone(),
                    ok: false,
                    error: Some(e),
                });
            }
        }
    }
    Ok(BulkToggleResult {
        requested: names.len(),
        succeeded,
        failed,
        outcomes,
    })
}

#[cfg(test)]
mod tests;
