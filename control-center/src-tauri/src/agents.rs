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

#[derive(Debug, Serialize, Clone)]
pub struct AgentInfo {
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub tools: Vec<String>,
    pub path: Option<String>,
    pub size_bytes: u64,
    pub last_modified: Option<u64>,
    /// Best-effort security verdict from a single `audit-all --target-type
    /// agent` sweep at list time. Skipped silently if the scanner is not
    /// reachable so the Agents tab still loads on a broken cockpit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub security: Option<AgentSecurityHint>,
}

/// Compact per-agent verdict embedded in `list_agents` output so the UI
/// can render the security badge + Quarantined filter without making one
/// RPC per agent. Mirrors `skills::SecurityInfo` for the Skills tab.
#[derive(Debug, Serialize, Clone)]
pub struct AgentSecurityHint {
    pub decision: String,
    pub findings_count: u64,
    pub high_severity_rules: Vec<String>,
}

fn agents_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/agents"))
}

fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>, Vec<String>) {
    // Returns (description, model, tools). Naive YAML-ish parser — same
    // pattern skills.rs already uses for SKILL.md. Keeps zero external
    // deps; community agents in the wild stick to the simple shape.
    if !text.starts_with("---") {
        return (None, None, vec![]);
    }
    let end = match text[3..].find("---") {
        Some(i) => i + 3,
        None => return (None, None, vec![]),
    };
    let block = &text[3..end];
    let mut description: Option<String> = None;
    let mut model: Option<String> = None;
    let mut tools: Vec<String> = Vec::new();

    for raw in block.lines() {
        let line = raw.trim_end();
        if let Some(rest) = line.strip_prefix("description:") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() && trimmed != ">" && trimmed != "|" {
                description = Some(
                    trimmed
                        .trim_matches(|c: char| c == '"' || c == '\'')
                        .to_string(),
                );
            }
        } else if let Some(rest) = line.strip_prefix("model:") {
            let m = rest.trim().trim_matches(|c: char| c == '"' || c == '\'');
            if !m.is_empty() {
                model = Some(m.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("tools:") {
            let t = rest.trim();
            if !t.is_empty() && !t.starts_with('[') {
                tools = t
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        }
    }
    (description, model, tools)
}

pub fn list_agents_inner() -> Result<Vec<AgentInfo>, String> {
    let dir = agents_dir().ok_or_else(|| "no HOME".to_string())?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<AgentInfo> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("read agents dir: {}", e))? {
        let entry = entry.map_err(|e| format!("entry: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let meta = entry.metadata().ok();
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let last_modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        let (description, model, tools) = match fs::read_to_string(&path) {
            Ok(text) => parse_frontmatter(&text),
            Err(_) => (None, None, Vec::new()),
        };

        out.push(AgentInfo {
            name,
            description,
            model,
            tools,
            path: Some(path.to_string_lossy().to_string()),
            size_bytes,
            last_modified,
            security: None,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));

    // Single-shot scanner sweep. We swallow any error so a broken cockpit
    // (uv missing, scanner not present, etc.) doesn't kill the list view —
    // the UI just won't surface security badges in that case.
    if let Some(map) = audit_all_agents_map() {
        for a in out.iter_mut() {
            if let Some(hint) = map.get(&a.name) {
                a.security = Some(hint.clone());
            }
        }
    }
    Ok(out)
}

/// Invoke `skill_sync_security.py audit-all --target-type agent --json`
/// and return a name→hint map. Returns None on any failure so callers can
/// fall back to a security-less list view gracefully.
fn audit_all_agents_map() -> Option<std::collections::HashMap<String, AgentSecurityHint>> {
    let home = dirs::home_dir()?;
    let scanner = home.join(".ultron/scripts/cockpit/skill_sync_security.py");
    if !scanner.is_file() {
        return None;
    }
    let mut cmd = std::process::Command::new("uv");
    cmd.arg("run")
        .arg("python")
        .arg(&scanner)
        .arg("audit-all")
        .arg("--target-type")
        .arg("agent")
        .arg("--json")
        .current_dir(home.join(".ultron"));
    // CREATE_NO_WINDOW (0x08000000) suppresses the cmd.exe flash that
    // would otherwise pop up every time the Agents tab loads — the
    // scanner sweep is invoked synchronously inside list_agents_inner,
    // so without this the user sees a console window appear for ~200ms.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let parsed: serde_json::Value = serde_json::from_str(&stdout).ok()?;
    let verdicts = parsed.get("verdicts")?.as_array()?;
    let mut map: std::collections::HashMap<String, AgentSecurityHint> =
        std::collections::HashMap::new();
    for v in verdicts {
        // `skill_path` is the .md file for agents — derive the name from
        // the file stem so it matches AgentInfo.name.
        let raw_path = v.get("skill_path").and_then(|p| p.as_str()).unwrap_or("");
        let stem = Path::new(raw_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if stem.is_empty() {
            continue;
        }
        let decision = v
            .get("decision")
            .and_then(|d| d.as_str())
            .unwrap_or("allow")
            .to_string();
        let findings_count = v
            .get("findings")
            .and_then(|f| f.as_array())
            .map(|a| {
                a.iter()
                    .filter(|x| !x.get("waived").and_then(|w| w.as_bool()).unwrap_or(false))
                    .count()
            })
            .unwrap_or(0) as u64;
        let high_severity_rules: Vec<String> = v
            .get("findings")
            .and_then(|f| f.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|x| {
                        // Only surface unwaived high-impact findings in
                        // the row badge — matches the Skills UX.
                        let waived = x.get("waived").and_then(|w| w.as_bool()).unwrap_or(false);
                        let sev = x.get("severity").and_then(|s| s.as_str()).unwrap_or("");
                        !waived && (sev == "high" || sev == "critical")
                    })
                    .filter_map(|x| x.get("rule_id").and_then(|r| r.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        map.insert(
            stem,
            AgentSecurityHint {
                decision,
                findings_count,
                high_severity_rules,
            },
        );
    }
    Some(map)
}

pub fn read_agent_md_inner(name: &str) -> Result<String, String> {
    validate_slug(name)?;
    let dir = agents_dir().ok_or_else(|| "no HOME".to_string())?;
    let path = dir.join(format!("{}.md", name));
    fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))
}

#[derive(Debug, Serialize)]
pub struct AgentMutationResult {
    pub success: bool,
    pub name: String,
    pub path: String,
    pub backup_path: Option<String>,
}

pub fn create_agent_inner(
    name: String,
    description: String,
    body: String,
    model: Option<String>,
    tools: Vec<String>,
) -> Result<AgentMutationResult, String> {
    validate_slug(&name)?;
    let desc_trim = description.trim();
    if desc_trim.is_empty() || desc_trim.len() > 600 {
        return Err("description must be 1..=600 chars".to_string());
    }
    let dir = agents_dir().ok_or_else(|| "no HOME".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    let path = dir.join(format!("{}.md", name));
    if path.exists() {
        return Err(format!("agent file already exists: {}", path.display()));
    }
    let mut frontmatter = format!(
        "---\nname: {}\ndescription: {}\n",
        name,
        desc_trim.replace('\n', " ")
    );
    if let Some(m) = model {
        let mt = m.trim();
        if !mt.is_empty() {
            frontmatter.push_str(&format!("model: {}\n", mt));
        }
    }
    if !tools.is_empty() {
        let cleaned: Vec<String> = tools
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        if !cleaned.is_empty() {
            frontmatter.push_str(&format!("tools: {}\n", cleaned.join(", ")));
        }
    }
    frontmatter.push_str("---\n\n");
    let contents = format!("{}{}\n", frontmatter, body.trim_end());
    fs::write(&path, contents).map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(AgentMutationResult {
        success: true,
        name,
        path: path.to_string_lossy().to_string(),
        backup_path: None,
    })
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

pub fn delete_agent_inner(name: String) -> Result<AgentMutationResult, String> {
    validate_slug(&name)?;
    let dir = agents_dir().ok_or_else(|| "no HOME".to_string())?;
    let path = dir.join(format!("{}.md", name));
    if !path.is_file() {
        return Err(format!("agent not found: {}", path.display()));
    }
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let archive_dir = home.join(".ultron/backups/agent-deleted");
    fs::create_dir_all(&archive_dir).map_err(|e| format!("mkdir archive: {}", e))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let archive_path = archive_dir.join(format!("{}-{}.md", name, ts));
    fs::rename(&path, &archive_path).map_err(|e| format!("archive: {}", e))?;
    Ok(AgentMutationResult {
        success: true,
        name,
        path: path.to_string_lossy().to_string(),
        backup_path: Some(archive_path.to_string_lossy().to_string()),
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
