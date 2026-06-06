// Installed apps commands.
use crate::installed_apps;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[tauri::command]
pub async fn list_installed_apps(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<installed_apps::InstalledAppsReport, String> {
    installed_apps::list_installed_apps_inner(&app, force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn open_app_folder(install_location: String) -> Result<String, String> {
    installed_apps::open_app_folder_inner(install_location)
}

#[tauri::command]
pub async fn uninstall_app(
    app: tauri::AppHandle,
    name: String,
    provider: String,
    package_id: Option<String>,
) -> Result<installed_apps::UninstallResult, String> {
    installed_apps::uninstall_app_inner(&app, name, provider, package_id).await
}

// ---------------------------------------------------------------------------
// Bloatware (System → Bloatware sub-tab). Curated list of Windows preloaded
// Appx packages the user almost never wants. Backend exposes a query (is it
// installed?) + a remove (Remove-AppxPackage) path. The pattern is validated
// against a strict allowlist of characters before any PS interpolation.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn appx_query(
    app: tauri::AppHandle,
    pattern: String,
) -> Result<installed_apps::AppxQueryResult, String> {
    installed_apps::appx_query_inner(&app, pattern).await
}

#[tauri::command]
pub async fn uninstall_bloatware_app(
    app: tauri::AppHandle,
    pattern: String,
) -> Result<installed_apps::BloatwareUninstallResult, String> {
    installed_apps::uninstall_bloatware_app_inner(&app, pattern).await
}

// ---------------------------------------------------------------------------
// AI-powered app categorisation.
//
// The frontend sends a list of (name, publisher) pairs and gets back a map
// of name → category string.  Results are cached in a process-level HashMap
// so the same app name is never sent to the AI twice in the same session.
//
// The AI call goes through ai_router::route("utility/light", …) — cheap
// zone, no user-visible latency budget, result is a single word.
// ---------------------------------------------------------------------------

/// Per-process cache: app name → AI-assigned category.
/// Keyed by lowercase(name) so capitalisation differences don't double-call.
static CATEGORY_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn category_cache() -> &'static Mutex<HashMap<String, String>> {
    CATEGORY_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Input item from the frontend.
#[derive(serde::Deserialize)]
pub struct AppCategoriseItem {
    pub name: String,
    pub publisher: Option<String>,
}

/// Categorise a batch of apps using the AI Router (utility/light zone).
///
/// Returns a JSON object `{ "<name>": "<category>", … }` where category is
/// one of: Development | Games | Media | Productivity | System utilities | Other.
/// Apps whose names are already in the in-process cache are returned immediately
/// without an AI call.  Novel apps are batched into one prompt to keep latency
/// low (one route() call per batch rather than one per app).
#[tauri::command]
pub async fn categorize_apps_with_ai(
    items: Vec<AppCategoriseItem>,
) -> Result<HashMap<String, String>, String> {
    if items.is_empty() {
        return Ok(HashMap::new());
    }

    let valid_categories = [
        "Development",
        "Games",
        "Media",
        "Productivity",
        "System utilities",
        "Other",
    ];

    let mut result: HashMap<String, String> = HashMap::new();

    // Split into cached vs. novel.
    let mut novel: Vec<&AppCategoriseItem> = Vec::new();
    {
        let cache = category_cache()
            .lock()
            .map_err(|_| "category cache poisoned".to_string())?;
        for item in &items {
            let key = item.name.to_lowercase();
            if let Some(cat) = cache.get(&key) {
                result.insert(item.name.clone(), cat.clone());
            } else {
                novel.push(item);
            }
        }
    }

    if novel.is_empty() {
        return Ok(result);
    }

    // Build a compact prompt listing all novel apps.
    let app_list = novel
        .iter()
        .map(|it| {
            let pub_str = it.publisher.as_deref().unwrap_or("unknown");
            format!("- \"{}\" (publisher: {})", it.name, pub_str)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        "Classify each application below into EXACTLY one of these categories: \
Development, Games, Media, Productivity, System utilities, Other.\n\
Reply with ONLY a JSON object mapping each app name to its category, e.g. \
{{\"Visual Studio Code\": \"Development\"}}. No prose, no markdown fences.\n\n\
Apps to classify:\n{app_list}"
    );

    // Call the AI Router synchronously (route() is blocking).
    // We offload to a blocking thread so we don't block the async executor.
    let ai_raw = tokio::task::spawn_blocking(move || {
        crate::ai_router::route("utility/light", &prompt)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?;

    let ai_text = match ai_raw {
        Ok(t) => t,
        Err(e) => {
            // AI Router unavailable — return empty map so frontend falls back
            // to its own heuristic classifier. Don't hard-fail.
            eprintln!("[categorize_apps_with_ai] route failed: {e}");
            return Ok(result);
        }
    };

    // Extract first JSON object from the response.
    let json_blob = extract_first_json_object(&ai_text).unwrap_or_default();
    if json_blob.is_empty() {
        return Ok(result);
    }
    let parsed: serde_json::Value = match serde_json::from_str(&json_blob) {
        Ok(v) => v,
        Err(_) => return Ok(result),
    };
    let Some(obj) = parsed.as_object() else {
        return Ok(result);
    };

    // Validate and cache each assignment.
    let mut cache = category_cache()
        .lock()
        .map_err(|_| "category cache poisoned".to_string())?;

    for item in &novel {
        if let Some(cat_val) = obj.get(&item.name).and_then(|v| v.as_str()) {
            // Only accept known categories; fall back to "Other".
            let cat = if valid_categories.contains(&cat_val) {
                cat_val.to_string()
            } else {
                "Other".to_string()
            };
            cache.insert(item.name.to_lowercase(), cat.clone());
            result.insert(item.name.clone(), cat);
        }
    }

    Ok(result)
}

/// Pull the first balanced `{…}` block from an arbitrary string.
fn extract_first_json_object(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let bytes = text.as_bytes();
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes[start..].iter().enumerate() {
        if escape {
            escape = false;
            continue;
        }
        match b {
            b'\\' if in_string => escape = true,
            b'"' => in_string = !in_string,
            b'{' if !in_string => depth += 1,
            b'}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start..start + i + 1].to_string());
                }
            }
            _ => {}
        }
    }
    None
}
