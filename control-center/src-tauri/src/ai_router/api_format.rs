// Protocolo de cada proveedor del router (`Provider::api_format`).
//
// Hasta el 2026-10-26 el despacho de `try_assignment_call` iba por id
// (`"claude" | "claude-haiku"`, `"codex" | "groq" | "deepseek"`, ...): un
// proveedor nuevo, aunque hablase el mismo protocolo que Groq, necesitaba
// tocar código. Ahora cada proveedor declara su protocolo y el despacho va
// por él, así que un proveedor OpenAI-compatible (seed o personalizado) solo
// necesita una entrada en `providers.json`.
//
// Un `providers.json` escrito antes de este cambio no trae el campo: se
// deduce del id y del `kind` al leerlo (`ProviderRaw` -> `Provider`).

use serde::{Deserialize, Serialize};

use super::types::{ApiKeyStatus, Provider, ProviderClass, ProviderKind};

/// Protocolo HTTP (o CLI) con el que se habla con un proveedor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiFormat {
    /// `POST {raíz}/chat/completions` con `Authorization: Bearer`.
    OpenaiCompat,
    /// Messages API de Anthropic (`x-api-key`).
    Anthropic,
    /// `generateContent` de Google Gemini.
    Gemini,
    /// `/api/generate` de Ollama.
    Ollama,
    /// CLI local por suscripción (`cli_command`).
    Cli,
    /// Valor que esta versión no conoce: el despacho lo rechaza con un error
    /// explícito en vez de hacer un no-op o tumbar la carga del catálogo.
    #[serde(other)]
    Unknown,
}

/// Ids del seed (y anteriores) que hablan el protocolo de OpenAI.
const OPENAI_COMPAT_IDS: &[&str] = &[
    "codex",
    "groq",
    "deepseek",
    "openrouter",
    "cerebras",
    "mistral",
    "nvidia-nim",
    "github-models",
    "together",
    "fireworks",
    "xai",
    "sambanova",
    "huggingface",
    "moonshot",
    "dashscope",
    "zai",
    "cohere",
];

/// Protocolo de un proveedor sin el campo en disco. Un id desconocido queda
/// en `Unknown` (mismo comportamiento que el antiguo despacho por id: error
/// explícito), no se supone OpenAI-compatible.
pub(crate) fn infer_api_format(id: &str, kind: ProviderKind) -> ApiFormat {
    if kind == ProviderKind::Cli {
        return ApiFormat::Cli;
    }
    match id {
        "claude" | "claude-haiku" => ApiFormat::Anthropic,
        "gemini" => ApiFormat::Gemini,
        "ollama" => ApiFormat::Ollama,
        _ if OPENAI_COMPAT_IDS.contains(&id) => ApiFormat::OpenaiCompat,
        _ => ApiFormat::Unknown,
    }
}

/// Raíz de la API OpenAI-compatible, la que sirve `/chat/completions` y
/// `/models`. Los tres proveedores históricos guardan la raíz sin versión
/// (`https://api.openai.com`, `https://api.deepseek.com`,
/// `https://api.groq.com/openai`) y se les añade `/v1`; los demás ya la traen
/// con su ruta (`/v1`, `/api/v1`, `/api/paas/v4`, `/inference`...) y se usa
/// tal cual.
pub(crate) fn openai_api_root(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let path = reqwest::Url::parse(trimmed)
        .map(|u| u.path().trim_end_matches('/').to_string())
        .unwrap_or_default();
    if path.is_empty() || path == "/openai" {
        format!("{trimmed}/v1")
    } else {
        trimmed.to_string()
    }
}

/// Forma en disco de `Provider`: igual, pero con los campos nuevos
/// opcionales para poder deducirlos en un `providers.json` antiguo.
#[derive(Deserialize)]
pub(crate) struct ProviderRaw {
    id: String,
    name: String,
    cost_per_mtok: f64,
    supports: Vec<ProviderClass>,
    api_key_status: ApiKeyStatus,
    #[serde(default)]
    health_endpoint: Option<String>,
    #[serde(default)]
    kind: ProviderKind,
    #[serde(default)]
    key_env_var: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    default_model: String,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    cli_command: Option<String>,
    #[serde(default)]
    api_format: Option<ApiFormat>,
    #[serde(default)]
    custom: bool,
}

impl From<ProviderRaw> for Provider {
    fn from(r: ProviderRaw) -> Self {
        let api_format = r
            .api_format
            .unwrap_or_else(|| infer_api_format(&r.id, r.kind));
        Provider {
            id: r.id,
            name: r.name,
            cost_per_mtok: r.cost_per_mtok,
            supports: r.supports,
            api_key_status: r.api_key_status,
            health_endpoint: r.health_endpoint,
            kind: r.kind,
            key_env_var: r.key_env_var,
            base_url: r.base_url,
            default_model: r.default_model,
            models: r.models,
            cli_command: r.cli_command,
            api_format,
            custom: r.custom,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deduce_el_protocolo_de_un_providers_json_antiguo() {
        let json = r#"[
          {"id":"claude-haiku","name":"h","cost_per_mtok":1.0,"supports":["light"],"api_key_status":"missing"},
          {"id":"groq","name":"g","cost_per_mtok":0.5,"supports":["light"],"api_key_status":"missing"},
          {"id":"gemini","name":"ge","cost_per_mtok":0.3,"supports":["light"],"api_key_status":"missing"},
          {"id":"ollama","name":"o","cost_per_mtok":0.0,"supports":["light"],"api_key_status":"configured","kind":"local"},
          {"id":"codex-cli","name":"c","cost_per_mtok":0.0,"supports":["light"],"api_key_status":"configured","kind":"cli"},
          {"id":"misterio","name":"m","cost_per_mtok":0.0,"supports":["light"],"api_key_status":"missing"}
        ]"#;
        let ps: Vec<Provider> = serde_json::from_str(json).expect("parse");
        let formats: Vec<ApiFormat> = ps.iter().map(|p| p.api_format).collect();
        assert_eq!(
            formats,
            vec![
                ApiFormat::Anthropic,
                ApiFormat::OpenaiCompat,
                ApiFormat::Gemini,
                ApiFormat::Ollama,
                ApiFormat::Cli,
                ApiFormat::Unknown,
            ]
        );
        assert!(ps.iter().all(|p| !p.custom));
    }

    #[test]
    fn el_campo_explicito_manda_sobre_el_id() {
        let json = r#"{"id":"groq","name":"g","cost_per_mtok":0.5,"supports":["light"],
            "api_key_status":"missing","api_format":"anthropic","custom":true}"#;
        let p: Provider = serde_json::from_str(json).expect("parse");
        assert_eq!(p.api_format, ApiFormat::Anthropic);
        assert!(p.custom);
        let back = serde_json::to_value(&p).expect("ser");
        assert_eq!(back["api_format"], "anthropic");
        assert_eq!(back["custom"], true);
    }

    /// Caso negativo: un protocolo que esta versión no conoce no tumba la
    /// carga de todo el catálogo; queda en `Unknown`.
    #[test]
    fn un_protocolo_desconocido_no_rompe_la_carga() {
        let json = r#"{"id":"x","name":"x","cost_per_mtok":0.0,"supports":[],
            "api_key_status":"missing","api_format":"grpc-futuro"}"#;
        let p: Provider = serde_json::from_str(json).expect("parse");
        assert_eq!(p.api_format, ApiFormat::Unknown);
    }

    #[test]
    fn la_raiz_openai_anade_v1_solo_a_las_raices_historicas() {
        assert_eq!(
            openai_api_root("https://api.openai.com"),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            openai_api_root("https://api.deepseek.com/"),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(
            openai_api_root("https://api.groq.com/openai"),
            "https://api.groq.com/openai/v1"
        );
        assert_eq!(
            openai_api_root("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            openai_api_root("https://api.z.ai/api/paas/v4"),
            "https://api.z.ai/api/paas/v4"
        );
        assert_eq!(
            openai_api_root("https://models.github.ai/inference"),
            "https://models.github.ai/inference"
        );
    }
}
