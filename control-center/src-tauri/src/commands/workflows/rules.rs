use crate::rules::{list_inner, write_inner, RuleFile};

#[tauri::command]
pub async fn rules_list() -> Result<Vec<RuleFile>, String> {
    list_inner()
}

#[tauri::command]
pub async fn rules_write(name: String, body: String) -> Result<String, String> {
    write_inner(name, body)
}
