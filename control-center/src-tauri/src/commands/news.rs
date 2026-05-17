// News (ULTRON Times) generation and management commands.
use crate::news;

#[tauri::command]
pub async fn list_news() -> Result<Vec<news::NewsEntry>, String> {
    news::list_news_inner()
}

#[tauri::command]
pub async fn generate_news(
    app: tauri::AppHandle,
    theme: Option<String>,
    days: Option<u32>,
) -> Result<news::NewsGenerateResult, String> {
    news::generate_news_inner(&app, theme, days).await
}

#[tauri::command]
pub async fn generate_news_session(
    app: tauri::AppHandle,
    theme: Option<String>,
    days: Option<u32>,
) -> Result<news::NewsGenerateResult, String> {
    news::generate_news_session_inner(&app, theme, days).await
}

#[tauri::command]
pub async fn delete_news(path: String) -> Result<bool, String> {
    news::delete_news_inner(path)
}

#[tauri::command]
pub async fn read_news_html(path: String) -> Result<String, String> {
    news::read_news_html_inner(path)
}

#[tauri::command]
pub async fn summarize_news(app: tauri::AppHandle, path: String) -> Result<String, String> {
    news::summarize_news_inner(&app, path).await
}
