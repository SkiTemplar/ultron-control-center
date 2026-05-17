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

use serde::Serialize;

use crate::skills::{format_ymd_local, sha1_of_file};

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

// v15.4.14 — Send-to-vault / restore-from-vault flow for agents.
// The vault is `~/.ultron/agent-vault/<name>.md`. Sent agents are
// removed from `~/.claude/agents/` so Claude no longer auto-loads
// them on SessionStart, but the .md stays on disk for inspection /
// restore. The auto-recall hook can read the vault dir on demand to
// surface a vaulted agent when a prompt matches its description.
fn agent_vault_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron").join("agent-vault"))
}

pub fn send_agent_to_vault_inner(name: String) -> Result<AgentMutationResult, String> {
    validate_slug(&name)?;
    let dir = agents_dir().ok_or_else(|| "no HOME".to_string())?;
    let path = dir.join(format!("{}.md", name));
    if !path.is_file() {
        return Err(format!("agent not found: {}", path.display()));
    }
    let vault = agent_vault_dir().ok_or_else(|| "no HOME".to_string())?;
    fs::create_dir_all(&vault).map_err(|e| format!("mkdir vault: {}", e))?;
    let target = vault.join(format!("{}.md", name));
    // If the vault already has this agent (e.g. user restored, edited,
    // and is now sending back), overwrite with the current version.
    fs::rename(&path, &target).map_err(|e| format!("move to vault: {}", e))?;
    Ok(AgentMutationResult {
        success: true,
        name,
        path: path.to_string_lossy().to_string(),
        backup_path: Some(target.to_string_lossy().to_string()),
    })
}

pub fn restore_agent_from_vault_inner(name: String) -> Result<AgentMutationResult, String> {
    validate_slug(&name)?;
    let vault = agent_vault_dir().ok_or_else(|| "no HOME".to_string())?;
    let src = vault.join(format!("{}.md", name));
    if !src.is_file() {
        return Err(format!("agent not in vault: {}", src.display()));
    }
    let dir = agents_dir().ok_or_else(|| "no HOME".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir agents: {}", e))?;
    let target = dir.join(format!("{}.md", name));
    if target.exists() {
        return Err(format!(
            "agent already installed at {}; delete it first if you want the vaulted copy back",
            target.display()
        ));
    }
    fs::rename(&src, &target).map_err(|e| format!("restore from vault: {}", e))?;
    Ok(AgentMutationResult {
        success: true,
        name,
        path: target.to_string_lossy().to_string(),
        backup_path: None,
    })
}

#[derive(Debug, Serialize)]
pub struct VaultedAgent {
    pub name: String,
    pub description: String,
}

pub fn list_vaulted_agents_inner() -> Result<Vec<VaultedAgent>, String> {
    let vault = match agent_vault_dir() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    if !vault.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&vault).map_err(|e| format!("read vault: {}", e))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
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
        let body = fs::read_to_string(&path).unwrap_or_default();
        let description = body
            .lines()
            .find_map(|l| l.strip_prefix("description:"))
            .unwrap_or("")
            .trim()
            .trim_matches('"')
            .chars()
            .take(200)
            .collect::<String>();
        out.push(VaultedAgent { name, description });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
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

fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Security — findings + manual allow ("Allow anyway")
//
// These are the agent-side parallels of skills::get_skill_findings_inner
// and skills::allow_skill_manually_inner. The on-disk shape is different
// (~/.claude/agents/<name>.md is a flat file, not a SKILL.md inside a
// directory), but the protocol — invoke the Python scanner, parse the
// JSON, write a SHA1-anchored waiver entry to skill-trust.yaml — is
// identical. Waiver entries are stamped with `target_type: agent` so
// the scanner can distinguish them from same-named skill waivers.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct AgentFinding {
    pub rule_id: String,
    pub severity: String,
    pub pattern_name: String,
    pub excerpt: String,
    pub line_number: Option<u64>,
    pub waived: bool,
}

#[derive(Debug, Serialize)]
pub struct AgentSecurityReport {
    pub name: String,
    pub decision: String,
    pub sha1: Option<String>,
    pub findings: Vec<AgentFinding>,
    pub stderr: String,
}

#[derive(Debug, Serialize)]
pub struct AllowAgentResult {
    pub success: bool,
    pub name: String,
    pub sha1: String,
    pub waiver_path: String,
}

/// Resolve the on-disk path for a given agent slug. The agent must live
/// directly under ~/.claude/agents/<name>.md — we don't search anywhere
/// else (unlike skills, which can also live in the vault layer).
fn locate_agent_md(home: &Path, name: &str) -> Result<PathBuf, String> {
    let path = home.join(format!(".claude/agents/{}.md", name));
    if !path.is_file() {
        return Err(format!("agent not found: {}", path.display()));
    }
    Ok(path)
}

/// Run the Python security scanner against the agent and return its
/// findings as parsed JSON. Symmetric with `skills::get_skill_findings_inner`
/// — the only difference is the `--target-type agent` flag passed to the
/// scanner and the file-vs-directory argument layout.
pub fn get_agent_findings_inner(name: String) -> Result<AgentSecurityReport, String> {
    validate_slug(&name)?;
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let agent_md = locate_agent_md(&home, &name)?;
    let scanner = home.join(".ultron/scripts/cockpit/skill_sync_security.py");
    if !scanner.is_file() {
        return Err(format!("scanner missing: {}", scanner.display()));
    }
    // uv run honours the cockpit lockfile (same as skills.rs).
    let mut cmd = std::process::Command::new("uv");
    cmd.arg("run")
        .arg("python")
        .arg(&scanner)
        .arg("scan")
        .arg(&agent_md)
        .arg("--target-type")
        .arg("agent")
        .arg("--json")
        .current_dir(home.join(".ultron"));
    // CREATE_NO_WINDOW — no console flash when the user opens an agent's
    // Security drawer. Same fix as audit_all_agents_map above.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("spawn uv: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let parsed: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| {
        format!(
            "parse scanner json: {} — raw: {}",
            e,
            stdout.chars().take(200).collect::<String>()
        )
    })?;
    let decision = parsed
        .get("decision")
        .and_then(|v| v.as_str())
        .unwrap_or("allow")
        .to_string();
    // The scanner's JSON doesn't carry a sha1 field today (it only writes
    // `skill_path`), so we hash the file locally — this matches what the
    // waiver writer will record below, keeping the two values consistent.
    let sha1 = sha1_of_file(&agent_md).ok();
    let mut findings: Vec<AgentFinding> = Vec::new();
    if let Some(arr) = parsed.get("findings").and_then(|v| v.as_array()) {
        for f in arr {
            findings.push(AgentFinding {
                rule_id: f
                    .get("rule_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?")
                    .to_string(),
                severity: f
                    .get("severity")
                    .and_then(|v| v.as_str())
                    .unwrap_or("low")
                    .to_string(),
                pattern_name: f
                    .get("pattern_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                excerpt: f
                    .get("excerpt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                line_number: f.get("line_number").and_then(|v| v.as_u64()),
                waived: f
                    .get("waived")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            });
        }
    }
    Ok(AgentSecurityReport {
        name,
        decision,
        sha1,
        findings,
        stderr,
    })
}

/// Write a per-agent waiver to ~/.ultron/config/skill-trust.yaml so the
/// scanner downgrades the listed rules on the current agent SHA1.
/// Editing the .md invalidates the waiver — that is by design.
pub fn allow_agent_manually_inner(
    name: String,
    rules: Vec<String>,
    reason: String,
) -> Result<AllowAgentResult, String> {
    validate_slug(&name)?;
    if rules.is_empty() {
        return Err("waived rules cannot be empty".to_string());
    }
    if reason.trim().is_empty() {
        return Err("reason is required (audit trail)".to_string());
    }
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let agent_md = locate_agent_md(&home, &name)?;
    let sha1 = sha1_of_file(&agent_md)?;

    let trust_path = home.join(".ultron/config/skill-trust.yaml");
    if !trust_path.is_file() {
        return Err(format!("trust config missing: {}", trust_path.display()));
    }
    let mut yaml = fs::read_to_string(&trust_path)
        .map_err(|e| format!("read {}: {}", trust_path.display(), e))?;

    // Refuse duplicate waivers for the same (name, sha1, target_type=agent)
    // triple. We use a 3-line presence check (sha1 + name + target_type)
    // because the YAML is hand-authored append-only; a single shared
    // marker would false-match a skill waiver for the same `name`.
    let sha1_marker = format!("skill_md_sha1: \"{}\"", sha1);
    let name_marker = format!("skill_name: \"{}\"", name);
    let target_marker = "target_type: \"agent\"";
    if yaml.contains(&sha1_marker) && yaml.contains(&name_marker) && yaml.contains(target_marker)
    {
        // Heuristic: if all three markers are present anywhere AND a block
        // with this exact sha1 carries a sibling `target_type: "agent"`,
        // it's the same waiver. Scan blocks to confirm — cheaper than a
        // full YAML parse and matches the contract used by the scanner.
        for block in yaml.split("\n  - ") {
            if block.contains(&sha1_marker)
                && block.contains(&name_marker)
                && block.contains(target_marker)
            {
                return Err(format!(
                    "agent waiver already present for {} @ sha1 {}",
                    name, sha1
                ));
            }
        }
    }
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }

    let today = format_ymd_local(unix_ts());
    let rules_yaml: String = rules
        .iter()
        .map(|r| format!("\"{}\"", r.replace('"', "")))
        .collect::<Vec<_>>()
        .join(", ");
    let reason_one_line = reason.replace('\n', " ").replace('"', "'");
    // target_type is the only field that distinguishes this block from a
    // skill waiver — keep it next to skill_name so the schema is obvious
    // at a glance when a human edits the YAML.
    let entry = format!(
        "\n  - skill_name: \"{name}\"\n    target_type: \"agent\"\n    skill_md_sha1: \"{sha1}\"\n    waived_rules: [{rules}]\n    reason: \"{reason}\"\n    approved_by: \"USER@local\"\n    approved_at: \"{today}\"\n",
        name = name,
        sha1 = sha1,
        rules = rules_yaml,
        reason = reason_one_line,
        today = today,
    );
    yaml.push_str(&entry);
    fs::write(&trust_path, yaml)
        .map_err(|e| format!("write {}: {}", trust_path.display(), e))?;

    Ok(AllowAgentResult {
        success: true,
        name,
        sha1,
        waiver_path: trust_path.to_string_lossy().to_string(),
    })
}

#[allow(dead_code)]
fn _placate_unused(p: &Path) -> &Path { p }

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
