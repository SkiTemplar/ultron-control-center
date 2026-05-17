// Skill CRUD + security findings commands.
use crate::skills;

#[tauri::command]
pub async fn list_skills() -> Result<Vec<skills::SkillInfo>, String> {
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

#[tauri::command]
pub async fn restore_skill_from_vault(name: String) -> Result<skills::SkillDeleteResult, String> {
    skills::restore_skill_from_vault_inner(name)
}

#[tauri::command]
pub async fn list_vaulted_skills() -> Result<Vec<skills::VaultedSkill>, String> {
    skills::list_vaulted_skills_inner()
}

#[tauri::command]
pub async fn get_skill_findings(name: String) -> Result<skills::SkillSecurityReport, String> {
    skills::get_skill_findings_inner(name)
}

#[tauri::command]
pub async fn allow_skill_manually(
    name: String,
    rules: Vec<String>,
    reason: String,
) -> Result<skills::AllowSkillResult, String> {
    skills::allow_skill_manually_inner(name, rules, reason)
}
