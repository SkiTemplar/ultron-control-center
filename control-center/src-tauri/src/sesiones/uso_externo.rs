// sesiones/uso_externo.rs — Lo que la pestaña Uso suma a Codex y agy
// (`sesiones_engines_usage`): saldo de DeepSeek y resumen de delegaciones.
//
// - DeepSeek: GET https://api.deepseek.com/user/balance con la key de
//   `DEEPSEEK_API_KEY` (entorno o registro de usuario). Respuesta:
//   `{is_available, balance_infos:[{currency, total_balance, …}]}`. Se cachea
//   10 min (un fallo, 60 s); «Actualizar» (`force`) la salta.
// - Delegaciones: `cockpit/delegations.jsonl` (contrato 2026-10-26, §2) por
//   motor: intentos que llegaron a ejecutarse, % de éxito y coste en USD.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::ai_router::delegation_runtime::{read_ledger, LedgerEntry};

const BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
const BALANCE_TTL: Duration = Duration::from_secs(600);
const ERROR_TTL: Duration = Duration::from_secs(60);
const HTTP_TOPE: Duration = Duration::from_secs(8);
/// Entradas del ledger que se leen (las más recientes; el tope de `read_ledger`).
const LEDGER_MAX: u32 = 2000;

/// Saldo de DeepSeek para la UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepseekBalance {
    /// `ok` | `none` (sin key) | `error`.
    pub status: &'static str,
    /// `is_available` de la API; `None` si no se pudo leer.
    pub available: Option<bool>,
    pub balances: Vec<Saldo>,
    pub note: Option<String>,
    pub read_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Saldo {
    pub currency: String,
    pub total: String,
}

fn ahora_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Interpreta la respuesta de `/user/balance`. Pura.
pub fn leer_balance(v: &Value, read_at_ms: u64) -> DeepseekBalance {
    let available = v.get("is_available").and_then(Value::as_bool);
    let balances: Vec<Saldo> = v
        .get("balance_infos")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|b| {
                    Some(Saldo {
                        currency: b.get("currency")?.as_str()?.to_string(),
                        total: b.get("total_balance")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let note = (available == Some(false)).then(|| "sin saldo".to_string());
    DeepseekBalance {
        status: if available.is_some() { "ok" } else { "error" },
        available,
        balances,
        note: note.or_else(|| {
            available
                .is_none()
                .then(|| "respuesta sin is_available".into())
        }),
        read_at_ms: Some(read_at_ms),
    }
}

fn sin_dato(status: &'static str, note: String) -> DeepseekBalance {
    DeepseekBalance {
        status,
        available: None,
        balances: Vec::new(),
        note: Some(note),
        read_at_ms: None,
    }
}

fn pedir_balance(key: &str) -> DeepseekBalance {
    let cliente = match reqwest::blocking::Client::builder()
        .timeout(HTTP_TOPE)
        .build()
    {
        Ok(c) => c,
        Err(e) => return sin_dato("error", format!("cliente HTTP: {e}")),
    };
    let resp = match cliente.get(BALANCE_URL).bearer_auth(key).send() {
        Ok(r) => r,
        Err(e) => return sin_dato("error", format!("sin respuesta de DeepSeek: {e}")),
    };
    if !resp.status().is_success() {
        return sin_dato("error", format!("DeepSeek respondió {}", resp.status()));
    }
    match resp.json::<Value>() {
        Ok(v) => leer_balance(&v, ahora_ms()),
        Err(e) => sin_dato("error", format!("respuesta de DeepSeek ilegible: {e}")),
    }
}

/// Lo cacheado sigue valiendo: un acierto 10 min y un fallo 60 s.
fn vigente(b: &DeepseekBalance, at: Instant) -> bool {
    let ttl = if b.status == "ok" {
        BALANCE_TTL
    } else {
        ERROR_TTL
    };
    at.elapsed() < ttl
}

/// Saldo de DeepSeek con caché; `force` la salta.
pub fn deepseek_balance(force: bool) -> DeepseekBalance {
    static CACHE: OnceLock<Mutex<Option<(Instant, DeepseekBalance)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if !force {
        if let Some((at, b)) = cache.lock().ok().and_then(|c| c.clone()) {
            if vigente(&b, at) {
                return b;
            }
        }
    }
    let key = super::opencode_entorno::claves()
        .into_iter()
        .find(|(p, _)| p.id == "deepseek")
        .map(|(_, v)| v);
    let Some(key) = key else {
        return sin_dato("none", "sin DEEPSEEK_API_KEY".into());
    };
    let b = pedir_balance(&key);
    if let Ok(mut c) = cache.lock() {
        *c = Some((Instant::now(), b.clone()));
    }
    b
}

/// Delegaciones de un motor.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegacionesMotor {
    pub engine: String,
    /// Intentos que llegaron a ejecutarse (los `skipped` no cuentan).
    pub attempts: u32,
    pub ok: u32,
    pub success_pct: f64,
    /// Suma de `costUsd`; `None` si ningún intento lo trae.
    pub cost_usd: Option<f64>,
}

/// Resumen por motor, en orden alfabético. Pura.
pub fn resumir(entradas: &[LedgerEntry]) -> Vec<DelegacionesMotor> {
    let mut por_motor: BTreeMap<&str, DelegacionesMotor> = BTreeMap::new();
    for e in entradas {
        let (Some(engine), Some(outcome)) = (e.engine.as_deref(), e.outcome.as_deref()) else {
            continue; // líneas de desenlace (`final`) o incompletas
        };
        if outcome == "skipped" {
            continue;
        }
        let m = por_motor
            .entry(engine)
            .or_insert_with(|| DelegacionesMotor {
                engine: engine.to_string(),
                attempts: 0,
                ok: 0,
                success_pct: 0.0,
                cost_usd: None,
            });
        m.attempts += 1;
        m.ok += u32::from(outcome == "ok");
        if let Some(c) = e.cost_usd {
            m.cost_usd = Some(m.cost_usd.unwrap_or(0.0) + c);
        }
    }
    por_motor
        .into_values()
        .map(|m| DelegacionesMotor {
            success_pct: f64::from(m.ok) * 100.0 / f64::from(m.attempts.max(1)),
            ..m
        })
        .collect()
}

/// Delegaciones del ledger; un ledger ilegible es error visible.
pub fn delegaciones() -> Result<Vec<DelegacionesMotor>, String> {
    read_ledger(LEDGER_MAX).map(|v| resumir(&v))
}

/// Añade `deepseek` y `delegations` (o `delegationsError`) a la respuesta.
pub fn anadir(respuesta: &mut Value, deepseek: DeepseekBalance) {
    let Some(obj) = respuesta.as_object_mut() else {
        return;
    };
    obj.insert(
        "deepseek".into(),
        serde_json::to_value(deepseek).unwrap_or(Value::Null),
    );
    match delegaciones() {
        Ok(d) => {
            obj.insert(
                "delegations".into(),
                serde_json::to_value(d).unwrap_or_default(),
            );
        }
        Err(e) => {
            obj.insert("delegationsError".into(), Value::String(e));
        }
    }
}

#[cfg(test)]
#[path = "tests_uso_externo.rs"]
mod tests;
