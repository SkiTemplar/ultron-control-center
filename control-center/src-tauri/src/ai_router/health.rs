// Health check cache — last result per provider, 30 s TTL.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use super::key_source::resolve_key;
use super::types::{ApiFormat, Provider};

pub(crate) const HEALTH_TTL: Duration = Duration::from_secs(30);
pub(crate) const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

struct HealthEntry {
    online: bool,
    checked_at: Instant,
}

static HEALTH_CACHE: Lazy<Mutex<HashMap<String, HealthEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Saltos de redirección admitidos dentro del mismo origen.
const MAX_REDIRECTS: usize = 10;

/// `true` si las dos URL tienen el mismo origen completo (esquema, host y
/// puerto). Una URL que no parsea o sin origen real nunca coincide.
pub(crate) fn same_origin(a: &str, b: &str) -> bool {
    match (reqwest::Url::parse(a), reqwest::Url::parse(b)) {
        (Ok(a), Ok(b)) => a.origin().is_tuple() && a.origin() == b.origin(),
        _ => false,
    }
}

/// Cliente de las llamadas autenticadas. No sigue una redirección a otro
/// origen: reqwest solo retira `Authorization` y similares al cambiar de host,
/// no `x-api-key` ni `x-goog-api-key`.
pub(crate) fn http_client() -> Result<reqwest::blocking::Client, String> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let same = attempt
            .previous()
            .first()
            .is_some_and(|first| first.origin() == attempt.url().origin());
        if !same {
            attempt.stop()
        } else if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("demasiadas redirecciones")
        } else {
            attempt.follow()
        }
    });
    reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(policy)
        .build()
        .map_err(|e| format!("build http client: {}", e))
}

pub(crate) fn provider_health(provider: &Provider) -> bool {
    // Fast path: cache hit.
    if let Ok(cache) = HEALTH_CACHE.lock() {
        if let Some(entry) = cache.get(&provider.id) {
            if entry.checked_at.elapsed() < HEALTH_TTL {
                return entry.online;
            }
        }
    }

    let online = probe_provider(provider);

    if let Ok(mut cache) = HEALTH_CACHE.lock() {
        cache.insert(
            provider.id.clone(),
            HealthEntry {
                online,
                checked_at: Instant::now(),
            },
        );
    }
    online
}

fn probe_provider(provider: &Provider) -> bool {
    let url = match provider.health_endpoint.as_ref() {
        Some(u) => u.clone(),
        None => return false,
    };
    let Ok(client) = http_client() else {
        return false;
    };
    let mut req = client.get(&url);
    if credentials_allowed(provider, &url) {
        for (name, value) in auth_headers(provider) {
            req = req.header(name, value);
        }
    }

    match req.send() {
        Ok(resp) => resp.status().as_u16() < 500,
        Err(_) => false,
    }
}

/// La key solo viaja al origen de la `base_url` del proveedor: un
/// `health_endpoint` ajeno se sondea sin credenciales.
pub(crate) fn credentials_allowed(provider: &Provider, url: &str) -> bool {
    same_origin(url, &provider.base_url)
}

/// Cabeceras de autenticación del sondeo según el protocolo.
fn auth_headers(provider: &Provider) -> Vec<(&'static str, String)> {
    if provider.key_env_var.is_empty() {
        return Vec::new();
    }
    let Some(key) = resolve_key(&provider.key_env_var) else {
        return Vec::new();
    };
    match provider.api_format {
        ApiFormat::Anthropic => vec![
            ("x-api-key", key),
            ("anthropic-version", "2023-06-01".to_string()),
        ],
        // (2026-09-16) Cabecera en vez de `?key=` en la query string — ver el
        // comentario equivalente en call_gemini (call_wrappers.rs): evita que
        // la clave quede en claro si reqwest imprime la URL en un error.
        ApiFormat::Gemini => vec![("x-goog-api-key", key)],
        _ => vec![("Authorization", format!("Bearer {key}"))],
    }
}

#[cfg(test)]
#[path = "health_tests.rs"]
mod tests;
