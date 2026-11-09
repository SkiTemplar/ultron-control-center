// Descubrimiento de modelos de un proveedor (`ai_router_discover_models`).
//
// Pide la lista de modelos a la API real del proveedor con su key, la guarda
// en `models` de `providers.json` y la devuelve. Así los proveedores nuevos
// del seed (que llegan con `models` vacío) no llevan ids inventados: los
// rellena la API.

use serde_json::Value;

use super::api_format::{openai_api_root, ApiFormat};
use super::health::{http_client, same_origin};
use super::key_source::resolve_key;
use super::providers::truncate;
use super::store::{load_providers, looks_like_placeholder, update_providers};
use super::types::Provider;

/// Petición HTTP que lista los modelos de un proveedor.
#[derive(Debug, PartialEq)]
pub(crate) struct ModelsRequest {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
}

/// Valor de la key del proveedor; `None` si no usa key. Error claro si la
/// necesita y no está.
fn provider_key(p: &Provider) -> Result<Option<String>, String> {
    if p.key_env_var.is_empty() {
        return Ok(None);
    }
    match resolve_key(&p.key_env_var) {
        Some(v) if !v.trim().is_empty() && !looks_like_placeholder(&v) => {
            Ok(Some(v.trim().to_string()))
        }
        _ => Err(format!(
            "falta la key de '{}': define {} (Settings > API Keys) para descubrir sus modelos",
            p.id, p.key_env_var
        )),
    }
}

/// URL del listado OpenAI-compatible: el `health_endpoint` si es un listado
/// de modelos del MISMO origen (GitHub Models lo sirve fuera de la raíz de
/// inferencia); si no, `{raíz}/models`. La key nunca va a otro esquema, host
/// o puerto.
fn openai_models_url(p: &Provider) -> String {
    let root = openai_api_root(&p.base_url);
    match p.health_endpoint.as_deref() {
        Some(h) if h.ends_with("/models") && same_origin(h, &root) => h.to_string(),
        _ => format!("{root}/models"),
    }
}

/// Construye la petición según el protocolo. Pura salvo por la key, que
/// recibe ya resuelta.
pub(crate) fn models_request(p: &Provider, key: Option<&str>) -> Result<ModelsRequest, String> {
    let base = p.base_url.trim().trim_end_matches('/');
    let need_key = || {
        key.map(str::to_string)
            .ok_or_else(|| format!("'{}' necesita una key para listar sus modelos", p.id))
    };
    let (url, headers) = match p.api_format {
        ApiFormat::OpenaiCompat => {
            let headers = key
                .map(|k| vec![("Authorization", format!("Bearer {k}"))])
                .unwrap_or_default();
            (openai_models_url(p), headers)
        }
        ApiFormat::Anthropic => (
            format!("{base}/v1/models?limit=1000"),
            vec![
                ("x-api-key", need_key()?),
                ("anthropic-version", "2023-06-01".to_string()),
            ],
        ),
        // Key en cabecera y no en `?key=`: un error de reqwest imprime la URL.
        ApiFormat::Gemini => (
            format!("{base}/v1beta/models?pageSize=1000"),
            vec![("x-goog-api-key", need_key()?)],
        ),
        ApiFormat::Ollama => (format!("{base}/api/tags"), Vec::new()),
        ApiFormat::Cli => {
            return Err(format!(
                "'{}' es un proveedor CLI: no expone una API de modelos",
                p.id
            ))
        }
        ApiFormat::Unknown => {
            return Err(format!(
                "'{}' tiene un api_format desconocido: no se sabe cómo listar sus modelos",
                p.id
            ))
        }
    };
    if base.is_empty() {
        return Err(format!("'{}' no tiene base_url", p.id));
    }
    Ok(ModelsRequest { url, headers })
}

fn str_field(v: &Value, field: &str) -> Option<String> {
    v.get(field).and_then(Value::as_str).map(str::to_string)
}

/// Extrae los ids de la respuesta del listado, ordenados y sin repetidos.
pub(crate) fn extract_model_ids(format: ApiFormat, v: &Value) -> Vec<String> {
    let empty: Vec<Value> = Vec::new();
    let mut ids: Vec<String> = match format {
        ApiFormat::Gemini => v
            .get("models")
            .and_then(Value::as_array)
            .unwrap_or(&empty)
            .iter()
            .filter(|m| {
                // Fuera los modelos de embeddings: solo los que generan texto.
                m.get("supportedGenerationMethods")
                    .and_then(Value::as_array)
                    .is_none_or(|ms| ms.iter().any(|x| x == "generateContent"))
            })
            .filter_map(|m| str_field(m, "name"))
            .map(|n| n.trim_start_matches("models/").to_string())
            .collect(),
        ApiFormat::Ollama => v
            .get("models")
            .and_then(Value::as_array)
            .unwrap_or(&empty)
            .iter()
            .filter_map(|m| str_field(m, "name"))
            .collect(),
        _ => v
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| v.as_array())
            .unwrap_or(&empty)
            .iter()
            .filter_map(|m| str_field(m, "id"))
            .collect(),
    };
    ids.retain(|s| !s.trim().is_empty());
    ids.sort();
    ids.dedup();
    ids
}

pub(crate) fn fetch_models(p: &Provider) -> Result<Vec<String>, String> {
    if matches!(p.api_format, ApiFormat::Cli | ApiFormat::Unknown) {
        return models_request(p, None).map(|_| Vec::new());
    }
    let key = provider_key(p)?;
    let req = models_request(p, key.as_deref())?;
    let client = http_client()?;
    let mut builder = client.get(&req.url);
    for (name, value) in &req.headers {
        builder = builder.header(*name, value);
    }
    let resp = builder
        .send()
        .map_err(|e| format!("{}: GET {} falló: {}", p.id, req.url, e))?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "{}: GET {} -> {}: {}",
            p.id,
            req.url,
            status,
            truncate(&text, 200)
        ));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("{}: la lista de modelos no es JSON: {}", p.id, e))?;
    Ok(extract_model_ids(p.api_format, &v))
}

/// Descubre, persiste y devuelve los modelos de `provider_id`.
pub(crate) fn discover_models_blocking(provider_id: &str) -> Result<Vec<String>, String> {
    let provider = load_providers()?
        .into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("proveedor '{provider_id}' no encontrado"))?;
    let models = fetch_models(&provider)?;
    persist_discovered(&provider, &models)?;
    Ok(models)
}

/// Guarda la lista obtenida con `asked`. La petición puede tardar: si entre
/// tanto el proveedor se ha borrado o apunta a otro sitio, la respuesta es de
/// un destino que ya no existe y se descarta. Si no tenía `default_model`,
/// toma el primero de la lista.
pub(crate) fn persist_discovered(asked: &Provider, models: &[String]) -> Result<(), String> {
    let id = &asked.id;
    let first = models
        .first()
        .cloned()
        .ok_or_else(|| format!("la API de '{id}' no ha devuelto ningún modelo"))?;
    update_providers(|ps| {
        let p = ps
            .iter_mut()
            .find(|p| p.id == *id)
            .ok_or_else(|| format!("proveedor '{id}' no encontrado"))?;
        let same_target = p.base_url == asked.base_url
            && p.api_format == asked.api_format
            && p.key_env_var == asked.key_env_var;
        if !same_target {
            return Err(format!(
                "'{id}' ha cambiado mientras se listaban sus modelos: se descarta la respuesta; vuelve a intentarlo"
            ));
        }
        p.models = models.to_vec();
        if p.default_model.trim().is_empty() {
            p.default_model = first;
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn ai_router_discover_models(provider_id: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || discover_models_blocking(&provider_id))
        .await
        .map_err(|e| format!("tarea de descubrimiento de modelos: {e}"))?
}

#[cfg(test)]
#[path = "discover_tests.rs"]
mod tests;
