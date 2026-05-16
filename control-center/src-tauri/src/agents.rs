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

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct AgentInfo {
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub tools: Vec<String>,
    pub path: Option<String>,
    pub size_bytes: u64,
    pub last_modified: Option<u64>,
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
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
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
fn _placate_unused(p: &Path) -> &Path { p }
