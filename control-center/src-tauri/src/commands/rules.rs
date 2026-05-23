use crate::rules::{list_inner, read_inner, RuleFile};

#[tauri::command]
pub async fn rules_list() -> Result<Vec<RuleFile>, String> {
    list_inner()
}

#[tauri::command]
pub async fn rules_read(path: String) -> Result<String, String> {
    read_inner(path)
}
