//! In-app creation of agents and skills.

use std::path::PathBuf;

use super::helpers::{atomic_write_bytes, is_kebab, resolve_agent_target, resolve_skill_dir};
use super::types::{AgentCreateSpec, SkillCreateSpec, TargetScope};

pub fn agent_create_inner(
    spec: AgentCreateSpec,
    target_scope: TargetScope,
    target_project_id: Option<String>,
) -> Result<PathBuf, String> {
    if !is_kebab(&spec.name) {
        return Err(format!("invalid name (must be kebab-case): {}", spec.name));
    }
    let target = resolve_agent_target(&spec.name, target_scope, target_project_id.as_deref())?;
    if target.exists() {
        return Err(format!("agent already exists: {}", target.display()));
    }
    let mut fm = String::new();
    fm.push_str("---\n");
    fm.push_str(&format!("name: {}\n", spec.name));
    fm.push_str(&format!(
        "description: {}\n",
        yaml_string(&spec.description)
    ));
    if !spec.tools.is_empty() {
        let arr: Vec<String> = spec.tools.iter().map(|t| format!("\"{}\"", t)).collect();
        fm.push_str(&format!("tools: [{}]\n", arr.join(", ")));
    }
    if let Some(m) = &spec.model {
        if !m.is_empty() {
            fm.push_str(&format!("model: {}\n", m));
        }
    }
    fm.push_str("---\n\n");
    fm.push_str(&spec.body);
    if !fm.ends_with('\n') {
        fm.push('\n');
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    atomic_write_bytes(&target, fm.as_bytes())?;
    Ok(target)
}

pub fn skill_create_inner(
    spec: SkillCreateSpec,
    target_scope: TargetScope,
    target_project_id: Option<String>,
) -> Result<PathBuf, String> {
    if !is_kebab(&spec.name) {
        return Err(format!("invalid name (must be kebab-case): {}", spec.name));
    }
    let dir = resolve_skill_dir(&spec.name, target_scope, target_project_id.as_deref())?;
    let target = dir.join("SKILL.md");
    if target.exists() {
        return Err(format!("skill already exists: {}", target.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let mut fm = String::new();
    fm.push_str("---\n");
    fm.push_str(&format!("name: {}\n", spec.name));
    fm.push_str(&format!(
        "description: {}\n",
        yaml_string(&spec.description)
    ));
    fm.push_str("---\n\n");
    fm.push_str(&spec.body);
    if !fm.ends_with('\n') {
        fm.push('\n');
    }
    atomic_write_bytes(&target, fm.as_bytes())?;
    Ok(target)
}

fn yaml_string(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{}\"", escaped)
}
