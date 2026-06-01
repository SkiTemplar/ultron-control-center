// Skill CRUD + security findings commands.
use crate::skills;

// Origin-aware listing for the Control Center 2.0 Skills viewer.
// Walks global (~/.claude/skills), project (.claude/skills), and plugin
// (~/.claude/plugins/cache/<id>/<name>/<version>/skills) trees and tags
// each entry with its origin. The older `SkillInfo` registry path is
// kept available via `list_skills_legacy` for callers that still need
// the security + usage metadata.
#[tauri::command]
pub async fn list_skills(project_path: Option<String>) -> Result<Vec<skills::SkillEntry>, String> {
    skills::list_skills_with_origin_inner(project_path)
}

#[tauri::command]
pub async fn skill_toggle(name: String, enabled: bool) -> Result<skills::SkillEntry, String> {
    skills::skill_toggle_inner(name, enabled)
}

/// Bulk enable/disable many global skills in one call. `disabled = true`
/// disables each named skill; `false` re-enables. Loops the same per-item
/// toggle the single `skill_toggle` command uses, collecting per-item
/// outcomes so the UI can surface partial failures.
#[tauri::command]
pub async fn skills_bulk_toggle(
    names: Vec<String>,
    disabled: bool,
) -> Result<skills::BulkToggleResult, String> {
    skills::skills_bulk_toggle_inner(names, disabled)
}

/// Legacy registry-driven listing (returns the rich `SkillInfo` shape
/// with security verdict + usage_count). Kept for components that still
/// surface those fields.
#[tauri::command]
pub async fn list_skills_legacy() -> Result<Vec<skills::SkillInfo>, String> {
    skills::list_skills_inner()
}

#[tauri::command]
pub async fn read_skill_md(name: String) -> Result<String, String> {
    skills::read_skill_md_inner(&name)
}

#[tauri::command]
pub async fn create_skill(
    name: String,
    description: String,
    body: String,
    layer: String,
) -> Result<skills::SkillCreateResult, String> {
    skills::create_skill_inner(name, description, body, layer)
}

#[tauri::command]
pub async fn update_skill_md(
    name: String,
    content: String,
) -> Result<skills::SkillUpdateResult, String> {
    skills::update_skill_md_inner(name, content)
}

#[tauri::command]
pub async fn delete_skill(name: String, soft: bool) -> Result<skills::SkillDeleteResult, String> {
    skills::delete_skill_inner(name, soft)
}
