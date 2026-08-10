// skills/crud.rs — Update operations on skill directories.
//
// (2026-08-11, decisión del usuario — audit 08-09 #38) create_skill_inner y
// delete_skill_inner RETIRADOS junto a sus comandos huérfanos: la creación
// pasa por library::skill_create y el vaulting por el flujo de la Library.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::SkillUpdateResult;

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
