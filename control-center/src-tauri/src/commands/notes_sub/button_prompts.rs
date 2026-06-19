// Button prompts catalog — see button_prompts.rs for the rationale. Every AI
// button in the Control Center reads its prompt from this catalog so the user
// can refine the prompts from the Settings → "Button prompts" sub-tab without
// touching the source.

use crate::button_prompts;

#[tauri::command]
pub async fn list_button_prompts() -> Result<button_prompts::ButtonPromptsCatalog, String> {
    button_prompts::list_button_prompts_inner()
}

#[tauri::command]
pub async fn update_button_prompt(
    key: String,
    prompt: String,
) -> Result<button_prompts::ButtonPrompt, String> {
    button_prompts::update_button_prompt_inner(key, prompt)
}

#[tauri::command]
pub async fn reset_button_prompt(key: String) -> Result<button_prompts::ButtonPrompt, String> {
    button_prompts::reset_button_prompt_inner(key)
}

// TODO: when variable prompting moves server-side, add a dedicated
// `button_prompt_render_for_clipboard` command that walks the entry's `vars`
// list, surfaces a UI to collect any missing values, and returns the rendered
// text. For now the frontend uses `navigator.clipboard.writeText` directly
// over the value returned by `getPrompt(key, vars)`.
