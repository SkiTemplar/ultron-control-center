// Proveedores personalizados del AI Router (alta y baja desde la UI).
//
// Un proveedor personalizado es una entrada con `custom: true` que vive en
// `providers.local.json` (ignorado por git; ver `store/provider_overlay.rs`).
// Como el despacho va por `api_format`, basta con declarar el protocolo: no
// hace falta código nuevo por proveedor. Solo se pueden borrar los
// personalizados; los del seed volverían en la carga siguiente.

use serde::{Deserialize, Serialize};

use super::api_format::{openai_api_root, ApiFormat};
use super::store::{compute_key_status, load_zones, update_providers};
use super::types::{ApiKeyStatus, Provider, ProviderClass, ProviderKind};
use crate::env_keys::is_custom_key;

/// Datos que manda la UI para dar de alta o editar un proveedor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomProviderInput {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_format: ApiFormat,
    /// Nombre de la variable de la key: solo `ULTRON_KEY_<NOMBRE>`, nunca una
    /// key integrada (no se manda un secreto del catálogo a un host
    /// arbitrario). Vacío solo para un servidor en loopback sin auth.
    #[serde(default)]
    pub key_env_var: String,
    #[serde(default)]
    pub default_model: Option<String>,
}

fn is_slug(id: &str) -> bool {
    (2..=40).contains(&id.len())
        && !id.starts_with('-')
        && !id.ends_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `true` para `http://localhost[:p]`, `http://127.0.0.1[:p]` y
/// `http://[::1][:p]` (la misma lista que `LOCAL_HOSTS` en validation.ts).
fn is_loopback_http(url: &reqwest::Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

fn validate_base_url(raw: &str, errors: &mut Vec<String>) -> Option<reqwest::Url> {
    let Ok(url) = reqwest::Url::parse(raw.trim()) else {
        errors.push(format!("base_url '{raw}' no es una URL válida"));
        return None;
    };
    if url.scheme() != "https" && !is_loopback_http(&url) {
        errors.push("base_url debe ser https:// (o http://localhost)".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        errors.push("base_url no puede llevar credenciales".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        errors.push("base_url no puede llevar query ni fragmento".into());
    }
    Some(url)
}

/// Sin key solo un servidor en loopback que hable `openai_compat` u `ollama`
/// (LM Studio, llama.cpp, Ollama). Los protocolos `anthropic` y `gemini`
/// siempre autentican (`x-api-key`, `?key=`) y sus llamadas leen la variable
/// de key sin excepción: sin ella fallarían en cada intento.
fn keyless_allowed(loopback: bool, format: ApiFormat) -> bool {
    loopback && matches!(format, ApiFormat::OpenaiCompat | ApiFormat::Ollama)
}

/// Valida la entrada y devuelve TODOS los fallos juntos.
pub(crate) fn validate_custom(input: &CustomProviderInput) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    if !is_slug(&input.id) {
        errors.push(format!(
            "id '{}' no válido: 2-40 caracteres a-z, 0-9 y '-' (sin '-' en los extremos)",
            input.id
        ));
    }
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        errors.push("name debe tener entre 1 y 80 caracteres".into());
    }
    let url = validate_base_url(&input.base_url, &mut errors);
    let loopback = url.as_ref().is_some_and(is_loopback_http);
    if matches!(input.api_format, ApiFormat::Cli | ApiFormat::Unknown) {
        errors.push(
            "api_format debe ser openai_compat, anthropic, gemini u ollama \
             (un CLI no se da de alta desde aquí)"
                .into(),
        );
    }
    let key = input.key_env_var.trim();
    if key.is_empty() {
        if !keyless_allowed(loopback, input.api_format) {
            errors.push(
                "key_env_var es obligatorio salvo en http://localhost con openai_compat u ollama (anthropic y gemini siempre envían una key)"
                    .into(),
            );
        }
    } else if !is_custom_key(key) {
        errors.push(format!(
            "key_env_var '{key}' no está permitida: un proveedor personalizado solo usa \
             ULTRON_KEY_<NOMBRE> (una key integrada no se manda a un host arbitrario)"
        ));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "proveedor personalizado no válido: {}",
            errors.join("; ")
        ))
    }
}

/// Entrada equivalente a un proveedor personalizado ya guardado.
fn input_of(p: &Provider) -> CustomProviderInput {
    CustomProviderInput {
        id: p.id.clone(),
        name: p.name.clone(),
        base_url: p.base_url.clone(),
        api_format: p.api_format,
        key_env_var: p.key_env_var.clone(),
        default_model: Some(p.default_model.clone()),
    }
}

/// Filtra los personalizados leídos de disco (o heredados del catálogo) con
/// las mismas reglas que un alta: uno que no las cumple (p. ej. una key
/// integrada hacia un host ajeno) se descarta con un aviso en el log y no
/// se usa. A los válidos se les regenera lo que deriva de la base: la
/// validación no mira esos campos. Pura salvo el log.
pub(crate) fn retain_valid_customs(customs: Vec<Provider>) -> Vec<Provider> {
    customs
        .into_iter()
        .filter_map(|p| match validate_custom(&input_of(&p)) {
            Ok(()) => Some(regenerate_derived(p)),
            Err(e) => {
                tracing::warn!(provider = %p.id, error = %e, "proveedor personalizado descartado");
                None
            }
        })
        .collect()
}

/// Reconstruye desde la `base_url` validada los campos que un fichero editado
/// a mano podría apuntar a otro sitio: el `health_endpoint` recibe la key, y
/// `kind` con `cli_command` decidirían lanzar un ejecutable.
fn regenerate_derived(p: Provider) -> Provider {
    let base = p.base_url.trim().trim_end_matches('/').to_string();
    let loopback = reqwest::Url::parse(&base).is_ok_and(|u| is_loopback_http(&u));
    Provider {
        health_endpoint: health_endpoint_for(p.api_format, &base),
        kind: if loopback {
            ProviderKind::Local
        } else {
            ProviderKind::Cloud
        },
        cli_command: None,
        custom: true,
        base_url: base,
        ..p
    }
}

fn health_endpoint_for(format: ApiFormat, base: &str) -> Option<String> {
    match format {
        ApiFormat::OpenaiCompat => Some(format!("{}/models", openai_api_root(base))),
        ApiFormat::Anthropic => Some(format!("{base}/v1/models")),
        ApiFormat::Gemini => Some(format!("{base}/v1beta/models")),
        ApiFormat::Ollama => Some(format!("{base}/api/tags")),
        ApiFormat::Cli | ApiFormat::Unknown => None,
    }
}

/// Construye el `Provider`. Si ya existía con la misma URL y protocolo, se
/// conservan los modelos descubiertos y el modelo por defecto.
pub(crate) fn build_custom(input: &CustomProviderInput, existing: Option<&Provider>) -> Provider {
    let base = input.base_url.trim().trim_end_matches('/').to_string();
    let loopback = reqwest::Url::parse(&base).is_ok_and(|u| is_loopback_http(&u));
    let kept = existing.filter(|e| e.base_url == base && e.api_format == input.api_format);
    let default_model = input
        .default_model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .or_else(|| kept.map(|e| e.default_model.clone()))
        .unwrap_or_default();
    Provider {
        id: input.id.clone(),
        name: input.name.trim().to_string(),
        cost_per_mtok: 0.0,
        supports: vec![ProviderClass::Light, ProviderClass::Medium],
        api_key_status: ApiKeyStatus::Missing,
        health_endpoint: health_endpoint_for(input.api_format, &base),
        kind: if loopback {
            ProviderKind::Local
        } else {
            ProviderKind::Cloud
        },
        key_env_var: input.key_env_var.trim().to_string(),
        base_url: base,
        default_model,
        models: kept.map(|e| e.models.clone()).unwrap_or_default(),
        cli_command: None,
        api_format: input.api_format,
        custom: true,
    }
}

pub(crate) fn upsert_custom_provider(input: &CustomProviderInput) -> Result<Provider, String> {
    validate_custom(input)?;
    let mut saved = update_providers(|ps| match ps.iter().position(|p| p.id == input.id) {
        Some(i) if !ps[i].custom => Err(format!(
            "'{}' es un proveedor del catálogo base, no personalizado: elige otro id",
            input.id
        )),
        Some(i) => {
            let p = build_custom(input, Some(&ps[i]));
            ps[i] = p.clone();
            Ok(p)
        }
        None => {
            let p = build_custom(input, None);
            ps.push(p.clone());
            Ok(p)
        }
    })?;
    saved.api_key_status = compute_key_status(&saved);
    Ok(saved)
}

pub(crate) fn remove_custom_provider(provider_id: &str) -> Result<(), String> {
    let in_use: Vec<String> = load_zones()?
        .into_iter()
        .filter(|z| {
            z.primary.provider_id == provider_id
                || z.fallbacks.iter().any(|f| f.provider_id == provider_id)
        })
        .map(|z| z.id)
        .collect();
    if !in_use.is_empty() {
        return Err(format!(
            "'{provider_id}' está en uso en las zonas: {}; quítalo de ellas antes de borrarlo",
            in_use.join(", ")
        ));
    }
    update_providers(|ps| {
        let i = ps
            .iter()
            .position(|p| p.id == provider_id)
            .ok_or_else(|| format!("proveedor '{provider_id}' no encontrado"))?;
        if !ps[i].custom {
            return Err(format!(
                "'{provider_id}' no es un proveedor personalizado: no se puede borrar"
            ));
        }
        ps.remove(i);
        Ok(())
    })
}

#[tauri::command]
pub async fn ai_router_upsert_custom_provider(
    provider: CustomProviderInput,
) -> Result<Provider, String> {
    upsert_custom_provider(&provider)
}

#[tauri::command]
pub async fn ai_router_remove_custom_provider(provider_id: String) -> Result<(), String> {
    remove_custom_provider(&provider_id)
}

#[cfg(test)]
#[path = "custom_tests.rs"]
mod tests;
