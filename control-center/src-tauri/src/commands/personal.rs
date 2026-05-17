// Personal profile / known data / style sample commands.
use crate::personal;

#[tauri::command]
pub async fn read_personal_profile() -> Result<personal::PersonalProfile, String> {
    personal::read_personal_profile_inner()
}

#[tauri::command]
pub async fn save_personal_profile(
    content: String,
) -> Result<personal::PersonalProfile, String> {
    personal::save_personal_profile_inner(content)
}

#[tauri::command]
pub async fn read_personal_known() -> Result<personal::PersonalKnown, String> {
    personal::read_personal_known_inner()
}

#[tauri::command]
pub async fn request_personal_analysis(app: tauri::AppHandle) -> Result<String, String> {
    personal::request_personal_analysis_inner(&app).await
}

#[tauri::command]
pub async fn read_personal_sample() -> Result<personal::PersonalSample, String> {
    personal::read_personal_sample_inner()
}

#[tauri::command]
pub async fn train_personal_style(
    app: tauri::AppHandle,
    sample_text: String,
) -> Result<String, String> {
    personal::train_personal_style_inner(&app, sample_text).await
}

#[tauri::command]
pub async fn generate_style_sample(app: tauri::AppHandle) -> Result<String, String> {
    personal::generate_style_sample_inner(&app).await
}
