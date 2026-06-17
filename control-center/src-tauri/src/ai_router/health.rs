// Health check cache — last result per provider, 30 s TTL.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use super::types::Provider;

pub(crate) const HEALTH_TTL: Duration = Duration::from_secs(30);
pub(crate) const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

struct HealthEntry {
    online: bool,
    checked_at: Instant,
}

static HEALTH_CACHE: Lazy<Mutex<HashMap<String, HealthEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub(crate) fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
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

    // Per-provider auth headers.
    if provider.id == "claude-haiku" {
        if let Ok(key) = std::env::var(&provider.key_env_var) {
            req = req
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01");
        }
    } else if provider.id == "gemini" {
        if let Ok(key) = std::env::var(&provider.key_env_var) {
            req = req.query(&[("key", key)]);
        }
    } else if !provider.key_env_var.is_empty() {
        if let Ok(key) = std::env::var(&provider.key_env_var) {
            req = req.header("Authorization", format!("Bearer {}", key));
        }
    }

    match req.send() {
        Ok(resp) => resp.status().as_u16() < 500,
        Err(_) => false,
    }
}
