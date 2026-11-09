// Proveedores OpenAI-compatibles del seed (2026-10-26).
//
// Ninguno tiene zona asignada: están en el catálogo para que el operador
// pueda configurar su key, descubrir sus modelos (`ai_router_discover_models`)
// y usarlos en una zona o en el delegador. Por eso `default_model` y `models`
// van vacíos: los ids los rellena el descubrimiento contra la API real, no se
// inventan aquí.
//
// `base_url` es la raíz OpenAI-compatible documentada por cada proveedor
// (la que sirve `/chat/completions` y `/models`); `openai_api_root` la usa tal
// cual porque ya trae su ruta de versión.

use super::types::{ApiFormat, ApiKeyStatus, Provider, ProviderClass, ProviderKind};

/// (id, nombre, base_url, variable de la key, endpoint de modelos si no es
/// `{base_url}/models`).
const OPENAI_COMPAT_SEED: &[(&str, &str, &str, &str, Option<&str>)] = &[
    (
        "openrouter",
        "OpenRouter",
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
        None,
    ),
    (
        "cerebras",
        "Cerebras",
        "https://api.cerebras.ai/v1",
        "CEREBRAS_API_KEY",
        None,
    ),
    (
        "mistral",
        "Mistral AI",
        "https://api.mistral.ai/v1",
        "MISTRAL_API_KEY",
        None,
    ),
    (
        "nvidia-nim",
        "NVIDIA NIM",
        "https://integrate.api.nvidia.com/v1",
        "NVIDIA_NIM_API_KEY",
        None,
    ),
    // GitHub Models sirve la inferencia en `/inference` y el catálogo de
    // modelos en `/catalog/models`, no en `/inference/models`.
    (
        "github-models",
        "GitHub Models",
        "https://models.github.ai/inference",
        "GITHUB_MODELS_TOKEN",
        Some("https://models.github.ai/catalog/models"),
    ),
    (
        "together",
        "Together AI",
        "https://api.together.xyz/v1",
        "TOGETHER_API_KEY",
        None,
    ),
    (
        "fireworks",
        "Fireworks AI",
        "https://api.fireworks.ai/inference/v1",
        "FIREWORKS_API_KEY",
        None,
    ),
    (
        "xai",
        "xAI (Grok)",
        "https://api.x.ai/v1",
        "XAI_API_KEY",
        None,
    ),
    (
        "sambanova",
        "SambaNova",
        "https://api.sambanova.ai/v1",
        "SAMBANOVA_API_KEY",
        None,
    ),
    (
        "huggingface",
        "Hugging Face (router)",
        "https://router.huggingface.co/v1",
        "HF_TOKEN",
        None,
    ),
    (
        "moonshot",
        "Moonshot AI (Kimi)",
        "https://api.moonshot.ai/v1",
        "MOONSHOT_API_KEY",
        None,
    ),
    (
        "dashscope",
        "Alibaba DashScope (Qwen)",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "DASHSCOPE_API_KEY",
        None,
    ),
    (
        "zai",
        "Z.ai (GLM)",
        "https://api.z.ai/api/paas/v4",
        "ZAI_API_KEY",
        None,
    ),
    (
        "cohere",
        "Cohere (compatibility)",
        "https://api.cohere.ai/compatibility/v1",
        "COHERE_API_KEY",
        None,
    ),
];

pub(crate) fn openai_compat_seed_providers() -> Vec<Provider> {
    OPENAI_COMPAT_SEED
        .iter()
        .map(|&(id, name, base_url, key_env_var, models_url)| Provider {
            id: id.into(),
            name: name.into(),
            // Desconocido hasta elegir modelo: el coste es solo informativo.
            cost_per_mtok: 0.0,
            supports: vec![ProviderClass::Light, ProviderClass::Medium],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some(
                models_url
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{base_url}/models")),
            ),
            kind: ProviderKind::Cloud,
            key_env_var: key_env_var.into(),
            base_url: base_url.into(),
            default_model: String::new(),
            models: Vec::new(),
            cli_command: None,
            api_format: ApiFormat::OpenaiCompat,
            custom: false,
        })
        .collect()
}
