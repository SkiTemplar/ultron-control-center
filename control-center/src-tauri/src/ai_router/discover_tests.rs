use super::*;
use crate::ai_router::custom::{upsert_custom_provider, CustomProviderInput};
use crate::ai_router::seed::seed_providers;
use crate::ai_router::test_http;
use crate::ai_router::types::TestRootGuard;
use serde_json::json;

fn seed(id: &str) -> Provider {
    seed_providers()
        .into_iter()
        .find(|p| p.id == id)
        .expect("proveedor del seed")
}

#[test]
fn la_url_de_modelos_depende_del_protocolo() {
    let r = models_request(&seed("groq"), Some("k")).expect("groq");
    assert_eq!(r.url, "https://api.groq.com/openai/v1/models");
    assert_eq!(r.headers, vec![("Authorization", "Bearer k".to_string())]);

    let r = models_request(&seed("deepseek"), Some("k")).expect("deepseek");
    assert_eq!(r.url, "https://api.deepseek.com/models");

    let r = models_request(&seed("openrouter"), Some("k")).expect("openrouter");
    assert_eq!(r.url, "https://openrouter.ai/api/v1/models");

    let r = models_request(&seed("github-models"), Some("k")).expect("github");
    assert_eq!(r.url, "https://models.github.ai/catalog/models");

    let r = models_request(&seed("gemini"), Some("k")).expect("gemini");
    assert!(r
        .url
        .starts_with("https://generativelanguage.googleapis.com/v1beta/models"));
    assert!(
        !r.url.contains("key="),
        "la key va en cabecera, no en la URL"
    );
    assert_eq!(r.headers, vec![("x-goog-api-key", "k".to_string())]);

    let r = models_request(&seed("claude"), Some("k")).expect("claude");
    assert!(r.url.starts_with("https://api.anthropic.com/v1/models"));

    let r = models_request(&seed("ollama"), None).expect("ollama");
    assert_eq!(r.url, "http://127.0.0.1:11434/api/tags");
}

/// Caso negativo: la key nunca se manda a un host distinto del de la API,
/// aunque `health_endpoint` apunte a otro sitio.
#[test]
fn no_manda_la_key_a_otro_host() {
    let mut p = seed("cerebras");
    p.health_endpoint = Some("https://evil.example.com/models".into());
    let r = models_request(&p, Some("k")).expect("cerebras");
    assert_eq!(r.url, "https://api.cerebras.ai/v1/models");
}

/// Caso negativo: un CLI, un protocolo desconocido o una key ausente dan
/// error claro, no una lista vacía.
#[test]
fn errores_claros_sin_api_de_modelos_o_sin_key() {
    let err = fetch_models(&seed("codex-cli")).expect_err("cli");
    assert!(err.contains("CLI"), "{err}");
    let mut p = seed("groq");
    p.api_format = ApiFormat::Unknown;
    assert!(fetch_models(&p)
        .expect_err("unknown")
        .contains("desconocido"));
    let mut p = seed("cerebras");
    p.key_env_var = "ULTRON_KEY_NO_EXISTE_NUNCA".into();
    let err = fetch_models(&p).expect_err("sin key");
    assert!(
        err.contains("falta la key") && err.contains("ULTRON_KEY_NO_EXISTE_NUNCA"),
        "{err}"
    );
    assert!(models_request(&seed("claude"), None).is_err());
}

#[test]
fn extrae_ids_de_cada_formato() {
    let openai = json!({"data":[{"id":"b"},{"id":"a"},{"id":"a"},{"id":""}]});
    assert_eq!(
        extract_model_ids(ApiFormat::OpenaiCompat, &openai),
        vec!["a", "b"]
    );
    let catalog = json!([{"id":"openai/gpt-4.1"},{"id":"meta/llama"}]);
    assert_eq!(
        extract_model_ids(ApiFormat::OpenaiCompat, &catalog),
        vec!["meta/llama", "openai/gpt-4.1"]
    );
    let gemini = json!({"models":[
        {"name":"models/gemini-2.5-flash","supportedGenerationMethods":["generateContent"]},
        {"name":"models/text-embedding-004","supportedGenerationMethods":["embedContent"]}
    ]});
    assert_eq!(
        extract_model_ids(ApiFormat::Gemini, &gemini),
        vec!["gemini-2.5-flash"]
    );
    let ollama = json!({"models":[{"name":"qwen2.5-coder:7b"}]});
    assert_eq!(
        extract_model_ids(ApiFormat::Ollama, &ollama),
        vec!["qwen2.5-coder:7b"]
    );
    assert!(extract_model_ids(ApiFormat::OpenaiCompat, &json!({"error":"x"})).is_empty());
}

/// Extremo a extremo contra un servidor local: pide `/v1/models` con el
/// Bearer, guarda la lista en `providers.json` y rellena `default_model`.
#[test]
fn descubre_y_guarda_los_modelos() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    let (base, rx) = test_http::serve(vec![(
        200,
        r#"{"object":"list","data":[{"id":"zeta"},{"id":"alfa"}]}"#.to_string(),
    )]);
    std::env::set_var("ULTRON_KEY_TEST_DISCOVER", "sk-discover");
    upsert_custom_provider(&CustomProviderInput {
        id: "mock-disc".into(),
        name: "Mock".into(),
        base_url: format!("{base}/v1"),
        api_format: ApiFormat::OpenaiCompat,
        key_env_var: "ULTRON_KEY_TEST_DISCOVER".into(),
        default_model: None,
    })
    .expect("alta");
    let result = discover_models_blocking("mock-disc");
    std::env::remove_var("ULTRON_KEY_TEST_DISCOVER");
    assert_eq!(result.expect("discover"), vec!["alfa", "zeta"]);
    let req = rx.recv().expect("petición");
    assert!(req.starts_with("GET /v1/models "), "{req}");
    assert!(
        req.to_ascii_lowercase()
            .contains("authorization: bearer sk-discover"),
        "{req}"
    );
    let p = load_providers()
        .expect("load")
        .into_iter()
        .find(|p| p.id == "mock-disc")
        .expect("p");
    assert_eq!(p.models, vec!["alfa", "zeta"]);
    assert_eq!(p.default_model, "alfa");
}

/// Caso negativo: un error HTTP no toca el catálogo y se informa con estado.
#[test]
fn un_error_http_no_toca_el_catalogo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    let (base, _rx) = test_http::serve(vec![(401, r#"{"error":"bad key"}"#.to_string())]);
    upsert_custom_provider(&CustomProviderInput {
        id: "mock-401".into(),
        name: "Mock".into(),
        base_url: format!("{base}/v1"),
        api_format: ApiFormat::OpenaiCompat,
        key_env_var: String::new(),
        default_model: None,
    })
    .expect("alta");
    let err = discover_models_blocking("mock-401").expect_err("401");
    assert!(err.contains("401"), "{err}");
    let p = load_providers()
        .expect("load")
        .into_iter()
        .find(|p| p.id == "mock-401")
        .expect("p");
    assert!(p.models.is_empty());
}

/// Codex #4: mismo host con otro puerto o esquema tampoco recibe la key.
#[test]
fn no_manda_la_key_a_otro_puerto_ni_esquema() {
    let mut p = seed("cerebras");
    p.base_url = "http://localhost:1234/v1".into();
    p.health_endpoint = Some("http://localhost:9999/models".into());
    let r = models_request(&p, Some("k")).expect("otro puerto");
    assert_eq!(r.url, "http://localhost:1234/v1/models");
    p.base_url = "https://api.example.com/v1".into();
    p.health_endpoint = Some("http://api.example.com/models".into());
    let r = models_request(&p, Some("k")).expect("otro esquema");
    assert_eq!(r.url, "https://api.example.com/v1/models");
    p.health_endpoint = Some("https://api.example.com/catalog/models".into());
    let r = models_request(&p, Some("k")).expect("mismo origen");
    assert_eq!(r.url, "https://api.example.com/catalog/models");
}

/// Codex #9: la respuesta de un descubrimiento lanzado antes de editar el
/// proveedor no pisa el proveedor editado.
#[test]
fn una_respuesta_tardia_de_descubrimiento_se_descarta() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    let alta = |base_url: &str| CustomProviderInput {
        id: "mock-tarde".into(),
        name: "Mock".into(),
        base_url: base_url.into(),
        api_format: ApiFormat::OpenaiCompat,
        key_env_var: String::new(),
        default_model: None,
    };
    let asked = upsert_custom_provider(&alta("http://localhost:1/v1")).expect("alta");
    upsert_custom_provider(&alta("http://localhost:2/v1")).expect("edición");
    let err = persist_discovered(&asked, &["viejo".to_string()]).expect_err("tardía");
    assert!(err.contains("ha cambiado"), "{err}");
    let current = load_providers()
        .expect("load")
        .into_iter()
        .find(|p| p.id == "mock-tarde")
        .expect("p");
    assert!(current.models.is_empty(), "{:?}", current.models);
    // Caso positivo: sin edición de por medio se guarda.
    persist_discovered(&current, &["nuevo".to_string()]).expect("vigente");
    let saved = load_providers()
        .expect("load")
        .into_iter()
        .find(|p| p.id == "mock-tarde")
        .expect("p");
    assert_eq!(saved.models, vec!["nuevo"]);
}
