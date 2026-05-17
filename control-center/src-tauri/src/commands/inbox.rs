// Inbox quick-capture commands.
use crate::inbox;

#[tauri::command]
pub async fn append_inbox(text: String) -> Result<(), String> {
    inbox::append_inbox_inner(&text)
}

#[tauri::command]
pub async fn list_inbox(limit: Option<usize>) -> Result<Vec<inbox::InboxEntry>, String> {
    inbox::list_inbox_inner(limit.unwrap_or(100))
}
