//! Tauri command wrapper for the slash-command registry.

use crate::commands_registry::{self, SlashCommand};

#[tauri::command]
pub fn list_all_slash_commands() -> Result<Vec<SlashCommand>, String> {
    commands_registry::list_all_commands()
}
