// skills/crud.rs — Create / update / delete operations on skill directories.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::{SkillCreateResult, SkillDeleteResult, SkillUpdateResult};

/// Validate slug per the spec: `^[a-z0-9][a-z0-9-]{1,60}$`.
pub(crate) fn validate_slug(name: &str) -> Result<(), String> {
    let len = name.len();
    if !(2..=61).contains(&len) {
        return Err(format!("invalid slug length ({}): 2..=61 expected", len));
    }
    let bytes = name.as_bytes();
    let first_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
    if !first_ok {
        return Err("slug must start with [a-z0-9]".to_string());
    }
    for &b in &bytes[1..] {
        let ok = b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-';
        if !ok {
            return Err("slug allowed chars: [a-z0-9-]".to_string());
        }
    }
    Ok(())
}

pub(crate) fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn layer_root(home: &Path, layer: &str) -> Result<PathBuf, String> {
    match layer {
        "active" => Ok(home.join(".claude/skills")),
        "vaulted" => Ok(home.join(".ultron/skill-vault")),
        other => Err(format!(
            "invalid layer '{}': expected active|vaulted",
            other
        )),
    }
}

/// Locate an existing skill dir. Looks in active first, then vault.
pub(crate) fn locate_skill_dir(home: &Path, name: &str) -> Result<PathBuf, String> {
    let active = home.join(format!(".claude/skills/{}", name));
    if active.is_dir() {
        return Ok(active);
    }
    let vault = home.join(format!(".ultron/skill-vault/{}", name));
    if vault.is_dir() {
        return Ok(vault);
    }
    Err(format!("skill dir not found for '{}'", name))
}

/// Create a new skill. Validates slug, ensures the target dir does not yet
/// exist, writes SKILL.md with YAML frontmatter + body.
pub fn create_skill_inner(
    name: String,
    description: String,
    body: String,
    layer: String,
) -> Result<SkillCreateResult, String> {
    validate_slug(&name)?;
    let desc_trim = description.trim();
    if desc_trim.is_empty() || desc_trim.len() > 300 {
        return Err("description must be 1..=300 chars".to_string());
    }
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let root = layer_root(&home, &layer)?;
    let dir = root.join(&name);
    if dir.exists() {
        return Err(format!("skill dir already exists: {}", dir.display()));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;

    let body_trim = body.trim_end();
    let contents = format!(
        "---\nname: {}\ndescription: {}\n---\n\n{}\n",
        name,
        desc_trim.replace('\n', " "),
        body_trim
    );
    let md_path = dir.join("SKILL.md");
    fs::write(&md_path, contents).map_err(|e| format!("write SKILL.md: {}", e))?;

    Ok(SkillCreateResult {
        success: true,
        name,
        path: md_path.to_string_lossy().to_string(),
        layer,
    })
}

/// Overwrite an existing SKILL.md after backing up the previous version to
/// ~/.ultron/backups/skill-edits/<name>-<ts>.md. Refuses if the file is missing.
pub fn update_skill_md_inner(name: String, content: String) -> Result<SkillUpdateResult, String> {
    validate_slug(&name)?;
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let dir = locate_skill_dir(&home, &name)?;
    let md_path = dir.join("SKILL.md");
    if !md_path.is_file() {
        return Err(format!("SKILL.md not found at {}", md_path.display()));
    }

    let backup_dir = home.join(".ultron/backups/skill-edits");
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("mkdir {}: {}", backup_dir.display(), e))?;
    let backup_path = backup_dir.join(format!("{}-{}.md", name, unix_ts()));
    fs::copy(&md_path, &backup_path)
        .map_err(|e| format!("backup copy {}: {}", backup_path.display(), e))?;

    fs::write(&md_path, content).map_err(|e| format!("write SKILL.md: {}", e))?;

    Ok(SkillUpdateResult {
        success: true,
        name,
        path: md_path.to_string_lossy().to_string(),
        backup_path: backup_path.to_string_lossy().to_string(),
    })
}

/// Move a skill dir.
///   soft=true  → demote to ~/.ultron/skill-vault/<name>
///   soft=false → archive to ~/.ultron/backups/skill-deleted/<name>-<ts>
/// Never recursively deletes.
pub fn delete_skill_inner(name: String, soft: bool) -> Result<SkillDeleteResult, String> {
    validate_slug(&name)?;
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let from = locate_skill_dir(&home, &name)?;

    let to = if soft {
        let dest_root = home.join(".ultron/skill-vault");
        fs::create_dir_all(&dest_root)
            .map_err(|e| format!("mkdir {}: {}", dest_root.display(), e))?;
        let dest = dest_root.join(&name);
        if dest.exists() {
            return Err(format!(
                "vault destination already exists: {}",
                dest.display()
            ));
        }
        // Already in vault? No-op-soft would be a contradiction; refuse.
        if from == dest {
            return Err("skill is already in vault layer".to_string());
        }
        dest
    } else {
        let dest_root = home.join(".ultron/backups/skill-deleted");
        fs::create_dir_all(&dest_root)
            .map_err(|e| format!("mkdir {}: {}", dest_root.display(), e))?;
        dest_root.join(format!("{}-{}", name, unix_ts()))
    };

    // Try fast rename first; fall back to copy+remove for cross-volume moves.
    if let Err(_e) = fs::rename(&from, &to) {
        copy_dir_recursive(&from, &to)
            .map_err(|e| format!("copy fallback {}→{}: {}", from.display(), to.display(), e))?;
        fs::remove_dir_all(&from).map_err(|e| format!("remove src {}: {}", from.display(), e))?;
    }

    Ok(SkillDeleteResult {
        success: true,
        name,
        from_path: from.to_string_lossy().to_string(),
        to_path: to.to_string_lossy().to_string(),
        soft,
    })
}

pub(crate) fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
