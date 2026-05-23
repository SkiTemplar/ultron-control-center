// ULTRON Control Center — Agents module.
//
// Agents live under ~/.claude/agents/ as markdown files with YAML
// frontmatter:
//
//   ---
//   name: ultron-arch
//   description: ...
//   tools: Read, Glob, Grep
//   model: claude-sonnet-4-6
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
                description = Some(trimmed.trim_matches(|c: char| c == '"' || c == '\'').to_string());
            }
        } else if let Some(rest) = line.strip_prefix("model:") {
            let m = rest.trim().trim_matches(|c: char| c == '"' || c == '\'');
            if !m.is_empty() {
                model = Some(m.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("tools:") {
            let t = rest.trim();
            if !t.is_empty() && !t.starts_with('[') {
                tools = t.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
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
            .map(|a| a.iter().filter(|x| !x.get("waived").and_then(|w| w.as_bool()).unwrap_or(false)).count())
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
                    .filter_map(|x| {
                        x.get("rule_id").and_then(|r| r.as_str()).map(String::from)
                    })
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
    if len < 2 || len > 61 {
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

#[allow(dead_code)]
fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
}

fn global_agents_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    Ok(home.join(".claude").join("agents"))
}

fn project_agents_dir(project_path: &str) -> PathBuf {
    PathBuf::from(project_path).join(".claude").join("agents")
}

/// Plugin agents live three levels deep:
/// `~/.claude/plugins/cache/<plugin-id>/<plugin-name>/<version>/agents/`.
/// For each `<plugin-id>/<plugin-name>` pair we keep only the latest
/// version dir (sorted lex desc).
fn plugin_agents_dirs() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let cache = home.join(".claude").join("plugins").join("cache");
    let mut out = Vec::new();
    let Ok(plugin_ids) = std::fs::read_dir(&cache) else {
        return out;
    };
    for pid_entry in plugin_ids.flatten() {
        let pid_path = pid_entry.path();
        if !pid_path.is_dir() {
            continue;
        }
        let Ok(plugin_names) = std::fs::read_dir(&pid_path) else {
            continue;
        };
        for pname_entry in plugin_names.flatten() {
            let pname_path = pname_entry.path();
            if !pname_path.is_dir() {
                continue;
            }
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
                    out.push(agents);
                }
            }
        }
    }
    out
}

fn read_agent_meta(path: &Path) -> (String, String) {
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("(unnamed)")
        .to_string();
    let description = fs::read_to_string(path)
        .ok()
        .and_then(|s| {
            for line in s.lines() {
                let t = line.trim();
                if let Some(rest) = t.strip_prefix("description:") {
                    return Some(rest.trim().trim_matches('"').to_string());
                }
            }
            None
        })
        .unwrap_or_default();
    (name, description)
}

fn collect_agents_from(root: &Path, origin: AgentOrigin) -> Vec<AgentEntry> {
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
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let (name, description) = read_agent_meta(&p);
            out.push(AgentEntry {
                name,
                path: p.to_string_lossy().to_string(),
                description,
                origin: origin.clone(),
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
        out.extend(collect_agents_from(&g, AgentOrigin::Global));
    }
    if let Some(p) = project_path.as_deref() {
        let pdir = project_agents_dir(p);
        out.extend(collect_agents_from(&pdir, AgentOrigin::Project));
    }
    for plugin_dir in plugin_agents_dirs() {
        out.extend(collect_agents_from(&plugin_dir, AgentOrigin::Plugin));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_returns_description_and_model() {
        let md = "---\n\
                  name: foo\n\
                  description: A test agent for the suite\n\
                  model: claude-sonnet-4-6\n\
                  tools: Read, Glob, Grep\n\
                  ---\n\
                  \n\
                  body text\n";
        let (desc, model, tools) = parse_frontmatter(md);
        assert_eq!(desc.as_deref(), Some("A test agent for the suite"));
        assert_eq!(model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(tools, vec!["Read".to_string(), "Glob".to_string(), "Grep".to_string()]);
    }

    #[test]
    fn parses_frontmatter_returns_none_without_marker() {
        // No leading `---` ⇒ everything None / empty.
        let md = "name: foo\ndescription: nope\n";
        let (desc, model, tools) = parse_frontmatter(md);
        assert!(desc.is_none());
        assert!(model.is_none());
        assert!(tools.is_empty());
    }

    #[test]
    fn list_agents_inner_returns_ok_regardless_of_dir_state() {
        // dirs::home_dir() on Windows resolves via the Win32 known-folder
        // API and ignores USERPROFILE/HOME env overrides, so we can't
        // synthesise a "missing dir" state cleanly. Instead we exercise
        // the public contract: list_agents_inner returns Ok(_) on a real
        // or missing dir — it must never error just because
        // ~/.claude/agents is absent. When the dir is missing, the inner
        // returns Ok(vec![]); when present (dev box), it returns
        // Ok(<entries>). Both shapes satisfy the contract.
        let result = list_agents_inner();
        assert!(
            result.is_ok(),
            "list_agents_inner must return Ok regardless of dir state, got {:?}",
            result.err()
        );
    }

    #[test]
    fn validate_slug_rejects_uppercase() {
        assert!(validate_slug("Foo-bar").is_err());
        assert!(validate_slug("FOO").is_err());
    }

    #[test]
    fn validate_slug_rejects_path_chars() {
        assert!(validate_slug("foo/bar").is_err());
        assert!(validate_slug("foo\\bar").is_err());
        assert!(validate_slug("../etc").is_err());
        assert!(validate_slug("foo.bar").is_err());
    }

    #[test]
    fn validate_slug_accepts_valid() {
        assert!(validate_slug("foo").is_ok());
        assert!(validate_slug("foo-bar").is_ok());
        assert!(validate_slug("agent-123").is_ok());
        assert!(validate_slug("a1").is_ok());
    }

}
