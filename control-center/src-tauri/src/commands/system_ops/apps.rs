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
// AI-powered app categorisation.
//
// The frontend sends a list of (name, publisher) pairs and gets back a map
// of name → category string.  Results are cached in a process-level HashMap
// so the same app name is never sent to the AI twice in the same session.
//
// The AI call goes through ai_router::route("light", …) — cheap
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

/// Categorías aceptadas; cualquier otra respuesta del proveedor pasa a `Other`.
const VALID_CATEGORIES: [&str; 6] = [
    "Development",
    "Games",
    "Media",
    "Productivity",
    "System utilities",
    "Other",
];

/// Categorise a batch of apps using the AI Router (light zone).
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
    let (mut result, novel) = split_cached(&items)?;
    if novel.is_empty() {
        return Ok(result);
    }
    let prompt = build_prompt(&novel);

    // route() is blocking: offload so we don't block the async executor.
    let ai_raw = tokio::task::spawn_blocking(move || crate::ai_router::route("light", &prompt))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?;
    let ai_text = match ai_raw {
        Ok(t) => t,
        Err(e) => {
            // AI Router unavailable — return the cached part so the frontend
            // falls back to its own heuristic classifier. Don't hard-fail.
            tracing::warn!("[categorize_apps_with_ai] route failed: {e}");
            return Ok(result);
        }
    };
    let assignments = match parse_assignments(&ai_text) {
        Ok(obj) => obj,
        Err(why) => {
            // Misma política que el fallo de ruta (la UI cae a su heurística),
            // pero con constancia: antes esta rama no dejaba rastro.
            tracing::warn!(
                "[categorize_apps_with_ai] respuesta del proveedor descartada ({} caracteres): {why}",
                ai_text.chars().count()
            );
            return Ok(result);
        }
    };

    let mut cache = category_cache()
        .lock()
        .map_err(|_| "category cache poisoned".to_string())?;
    for item in &novel {
        if let Some(cat_val) = assignments.get(&item.name).and_then(|v| v.as_str()) {
            let cat = normalize_category(cat_val);
            cache.insert(item.name.to_lowercase(), cat.clone());
            result.insert(item.name.clone(), cat);
        }
    }
    Ok(result)
}

/// Separa lo que ya está en la caché (devuelto en el mapa) de lo nuevo.
fn split_cached(
    items: &[AppCategoriseItem],
) -> Result<(HashMap<String, String>, Vec<&AppCategoriseItem>), String> {
    let cache = category_cache()
        .lock()
        .map_err(|_| "category cache poisoned".to_string())?;
    let mut cached = HashMap::new();
    let mut novel = Vec::new();
    for item in items {
        match cache.get(&item.name.to_lowercase()) {
            Some(cat) => {
                cached.insert(item.name.clone(), cat.clone());
            }
            None => novel.push(item),
        }
    }
    Ok((cached, novel))
}

/// Prompt compacto con todas las apps nuevas.
fn build_prompt(novel: &[&AppCategoriseItem]) -> String {
    let app_list = novel
        .iter()
        .map(|it| {
            let pub_str = it.publisher.as_deref().unwrap_or("unknown");
            format!("- \"{}\" (publisher: {})", it.name, pub_str)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Classify each application below into EXACTLY one of these categories: \
Development, Games, Media, Productivity, System utilities, Other.\n\
Reply with ONLY a JSON object mapping each app name to its category, e.g. \
{{\"Visual Studio Code\": \"Development\"}}. No prose, no markdown fences.\n\n\
Apps to classify:\n{app_list}"
    )
}

/// El objeto JSON de la respuesta, o el motivo por el que no se pudo leer.
fn parse_assignments(ai_text: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let blob = extract_first_json_object(ai_text)
        .ok_or_else(|| "sin objeto JSON en la respuesta".to_string())?;
    match serde_json::from_str::<serde_json::Value>(&blob) {
        Ok(serde_json::Value::Object(obj)) => Ok(obj),
        Ok(_) => Err("el JSON no es un objeto".to_string()),
        Err(e) => Err(format!("JSON no válido: {e}")),
    }
}

/// Solo categorías conocidas; el resto, `Other`.
fn normalize_category(raw: &str) -> String {
    if VALID_CATEGORIES.contains(&raw) {
        raw.to_string()
    } else {
        "Other".to_string()
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_assignments_lee_el_objeto_aunque_venga_con_prosa() {
        let obj = parse_assignments("Aquí va: {\"Steam\": \"Games\"} fin").unwrap();
        assert_eq!(obj["Steam"], "Games");
    }

    #[test]
    fn parse_assignments_explica_por_que_descarta() {
        assert!(parse_assignments("sin json")
            .unwrap_err()
            .contains("sin objeto"));
        assert!(parse_assignments("{\"a\": }")
            .unwrap_err()
            .contains("no válido"));
    }

    #[test]
    fn una_categoria_desconocida_pasa_a_other() {
        assert_eq!(normalize_category("Games"), "Games");
        assert_eq!(normalize_category("Juegos"), "Other");
    }
}
