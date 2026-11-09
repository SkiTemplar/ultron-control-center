// Configuración del delegador multi-motor.
//
// Contrato: plans/2026-10-26-delegador-multi-motor.md §1. Dos ficheros:
// - `cockpit/ai-router/delegation.default.json`: valor por defecto
//   versionado (se incrusta al compilar);
// - `cockpit/ai-router/delegation.json`: la configuración del usuario,
//   ignorada por git. La escribe `ai_router_set_delegation` (pestaña AI
//   Router) y la lee `scripts/delegate.mjs`; si falta, vale el default.
// Ninguno lleva secretos: solo el NOMBRE de la variable de la key (`keyEnv`).

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::store::{read_json, write_json};
use super::types::delegation_path;
use crate::env_keys::is_allowed_key;

/// Ejecutores que sabe lanzar `delegate.mjs`.
pub(crate) const RUNNERS: &[&str] = &["codex", "agy", "opencode", "claude"];
/// Niveles de complejidad de una tarea delegada.
pub(crate) const TIERS: &[&str] = &["complex", "standard", "trivial"];
/// Variables que un runner puede recibir por `envMap` (la clave del mapa):
/// solo nombres de key que leen los CLI de `delegate.mjs`. Nunca variables
/// que cambian cómo arranca el proceso (`NODE_OPTIONS`, `PATH`...).
pub(crate) const RUNNER_ENV_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "CEREBRAS_API_KEY",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "NVIDIA_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationTier {
    /// Motor de entrada para las tareas de este nivel.
    pub start: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationEngine {
    /// `codex | agy | opencode | claude`.
    pub runner: String,
    /// Modelo en el formato del runner (OpenCode: `proveedor/modelo`).
    pub model: String,
    /// Modelo por nivel, si difiere de `model`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier_models: Option<BTreeMap<String, String>>,
    /// Variable de entorno de la key; si está vacía, el motor se salta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_env: Option<String>,
    /// Tope de gasto por tarea (solo runner `claude`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_budget_usd: Option<f64>,
    /// Variable que espera el runner -> variable nuestra de la que se copia
    /// (p. ej. `OPENAI_API_KEY` -> `CEREBRAS_API_KEY`). El destino debe ser
    /// una variable permitida por `env_keys::is_allowed_key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_map: Option<BTreeMap<String, String>>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Campos que esta versión no conoce: se conservan al guardar.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationConfig {
    pub version: u32,
    /// Orden de relevo entre motores.
    pub chain: Vec<String>,
    pub tiers: BTreeMap<String, DelegationTier>,
    /// Si el check de la tarea falla, se pasa al siguiente motor.
    #[serde(default = "default_true")]
    pub relay_on_check_fail: bool,
    pub engines: BTreeMap<String, DelegationEngine>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_true() -> bool {
    true
}

/// Valor por defecto: el `cockpit/ai-router/delegation.default.json`
/// versionado del repo, incrustado al compilar. Es la misma fuente que mantiene
/// `delegate.mjs` (no se duplica la lista de motores ni de modelos en Rust);
/// el test `el_default_incrustado_es_valido` lo valida en cada `cargo test`.
const DEFAULT_DELEGATION_JSON: &str =
    include_str!("../../../../cockpit/ai-router/delegation.default.json");

pub(crate) fn default_delegation() -> Result<DelegationConfig, String> {
    serde_json::from_str(DEFAULT_DELEGATION_JSON)
        .map_err(|e| format!("delegation.default.json incrustado no parsea: {e}"))
}

fn is_engine_id(id: &str) -> bool {
    (1..=40).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub(crate) fn is_runner_env_var(name: &str) -> bool {
    RUNNER_ENV_VARS.contains(&name)
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    (2..=64).contains(&name.len())
        && chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// Modelo que acaba en una línea de shell de `delegate.mjs`: lista blanca
/// `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$` (sin comillas, `&`, `%`, `$` ni
/// espacios). Empieza por alfanumérico para que el CLI no lo lea como una
/// opción (`--share`).
pub(crate) fn is_safe_model(model: &str) -> bool {
    (1..=200).contains(&model.len())
        && model.starts_with(|c: char| c.is_ascii_alphanumeric())
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/@+-".contains(c))
}

fn model_issue(id: &str, field: &str, model: &str) -> Option<String> {
    if model.trim().is_empty() {
        Some(format!("motor '{id}': {field} vacío"))
    } else if !is_safe_model(model) {
        Some(format!(
            "motor '{id}': {field} '{model}' no válido (empieza por A-Z, a-z o 0-9; después solo A-Z, a-z, 0-9 y . _ : / @ + -)"
        ))
    } else {
        None
    }
}

fn validate_engine(id: &str, e: &DelegationEngine, errors: &mut Vec<String>) {
    if !is_engine_id(id) {
        errors.push(format!(
            "id de motor no válido '{id}' (solo a-z, 0-9 y '-')"
        ));
    }
    if !RUNNERS.contains(&e.runner.as_str()) {
        errors.push(format!(
            "motor '{id}': runner '{}' no válido (admitidos: {})",
            e.runner,
            RUNNERS.join(", ")
        ));
    }
    errors.extend(model_issue(id, "model", &e.model));
    for (tier, model) in e.tier_models.iter().flatten() {
        if !TIERS.contains(&tier.as_str()) {
            errors.push(format!(
                "motor '{id}': tierModels con nivel desconocido '{tier}'"
            ));
        }
        errors.extend(model_issue(id, &format!("tierModels.{tier}"), model));
    }
    if let Some(k) = &e.key_env {
        if !is_env_name(k) {
            errors.push(format!(
                "motor '{id}': keyEnv '{k}' no es un nombre de variable válido"
            ));
        }
    }
    for (runner_var, ours) in e.env_map.iter().flatten() {
        if !is_runner_env_var(runner_var) {
            errors.push(format!(
                "motor '{id}': envMap tiene una variable de runner no permitida '{runner_var}' (admitidas: {})",
                RUNNER_ENV_VARS.join(", ")
            ));
        }
        if !is_allowed_key(ours) {
            errors.push(format!(
                "motor '{id}': envMap.{runner_var} = '{ours}' no es una variable permitida \
                 (Settings > API Keys o ULTRON_KEY_<NOMBRE>)"
            ));
        }
    }
    if let Some(b) = e.max_budget_usd {
        if e.runner != "claude" {
            errors.push(format!(
                "motor '{id}': maxBudgetUsd solo se aplica al runner claude"
            ));
        } else if !(b.is_finite() && b > 0.0) {
            errors.push(format!("motor '{id}': maxBudgetUsd debe ser mayor que 0"));
        }
    }
}

/// Valida la configuración entera y devuelve TODOS los fallos juntos.
pub(crate) fn validate_delegation(cfg: &DelegationConfig) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    if cfg.version != 1 {
        errors.push(format!(
            "version {} no soportada (se espera 1)",
            cfg.version
        ));
    }
    if cfg.engines.is_empty() {
        errors.push("engines está vacío".into());
    }
    for (id, e) in &cfg.engines {
        validate_engine(id, e, &mut errors);
    }
    if cfg.chain.is_empty() {
        errors.push("chain está vacía".into());
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for id in &cfg.chain {
        if !seen.insert(id.as_str()) {
            errors.push(format!("chain repite '{id}'"));
        }
        if !cfg.engines.contains_key(id) {
            errors.push(format!("chain incluye '{id}', que no está en engines"));
        }
    }
    for tier in TIERS {
        if !cfg.tiers.contains_key(*tier) {
            errors.push(format!("falta el nivel '{tier}' en tiers"));
        }
    }
    for (tier, t) in &cfg.tiers {
        if !TIERS.contains(&tier.as_str()) {
            errors.push(format!(
                "nivel desconocido '{tier}' (admitidos: {})",
                TIERS.join(", ")
            ));
        }
        if !cfg.engines.contains_key(&t.start) {
            errors.push(format!(
                "tiers.{tier}.start = '{}' no está en engines",
                t.start
            ));
        } else if !cfg.chain.contains(&t.start) {
            // delegate.mjs empezaría en silencio por chain[0].
            errors.push(format!(
                "tiers.{tier}.start = '{}' no está en chain",
                t.start
            ));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("delegation.json no válido: {}", errors.join("; ")))
    }
}

/// Lee el `delegation.json` del usuario; si no existe, devuelve el default
/// sin escribir nada (el fichero solo nace al guardar desde la UI). Un
/// fichero que no parsea es un error (no se pisa).
pub(crate) fn load_delegation() -> Result<DelegationConfig, String> {
    let path = delegation_path()?;
    if !path.exists() {
        return default_delegation();
    }
    read_json(&path)
}

pub(crate) fn save_delegation(cfg: &DelegationConfig) -> Result<(), String> {
    validate_delegation(cfg)?;
    write_json(&delegation_path()?, cfg)
}

#[tauri::command]
pub async fn ai_router_get_delegation() -> Result<DelegationConfig, String> {
    load_delegation()
}

#[tauri::command]
pub async fn ai_router_set_delegation(config: DelegationConfig) -> Result<(), String> {
    save_delegation(&config)
}

#[cfg(test)]
#[path = "delegation_tests.rs"]
mod tests;
