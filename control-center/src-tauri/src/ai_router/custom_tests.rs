use super::*;
use crate::ai_router::providers::call_wrappers::try_assignment_call;
use crate::ai_router::store::load_providers;
use crate::ai_router::test_http;
use crate::ai_router::types::{TestRootGuard, ZoneAssignment};

fn input(id: &str, base_url: &str, key: &str) -> CustomProviderInput {
    CustomProviderInput {
        id: id.into(),
        name: format!("Proveedor {id}"),
        base_url: base_url.into(),
        api_format: ApiFormat::OpenaiCompat,
        key_env_var: key.into(),
        default_model: Some("modelo-a".into()),
    }
}

#[test]
fn valida_un_proveedor_correcto_y_localhost_sin_key() {
    validate_custom(&input(
        "mi-proxy",
        "https://api.ejemplo.com/v1",
        "ULTRON_KEY_MI_PROXY",
    ))
    .expect("https con key personalizada");
    validate_custom(&input("lmstudio", "http://localhost:1234/v1", "")).expect("localhost");
    validate_custom(&input("local2", "http://127.0.0.1:8080", "")).expect("loopback");
}

/// Caso negativo: cada regla falla con su motivo, y todos a la vez.
#[test]
fn rechaza_id_url_key_y_protocolo_invalidos() {
    let mut bad = input("Mal_Id", "http://api.ejemplo.com", "PATH");
    bad.api_format = ApiFormat::Cli;
    let err = validate_custom(&bad).expect_err("inválido");
    assert!(err.contains("id 'Mal_Id'"), "{err}");
    assert!(err.contains("https://"), "{err}");
    assert!(err.contains("key_env_var 'PATH'"), "{err}");
    assert!(err.contains("api_format"), "{err}");

    let err = validate_custom(&input("x1", "https://u:p@api.ejemplo.com", "GROQ_API_KEY"))
        .expect_err("credenciales");
    assert!(err.contains("credenciales"), "{err}");
    let err = validate_custom(&input("x1", "https://api.ejemplo.com", "")).expect_err("sin key");
    assert!(err.contains("obligatorio"), "{err}");
    assert!(validate_custom(&input("-x", "https://a.com", "GROQ_API_KEY")).is_err());
}

#[test]
fn alta_edicion_y_baja_de_un_proveedor_personalizado() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());

    let p = upsert_custom_provider(&input(
        "mi-proxy",
        "https://api.ejemplo.com/v1/",
        "ULTRON_KEY_MI_PROXY",
    ))
    .expect("alta");
    assert!(p.custom);
    assert_eq!(p.base_url, "https://api.ejemplo.com/v1");
    assert_eq!(
        p.health_endpoint.as_deref(),
        Some("https://api.ejemplo.com/v1/models")
    );
    assert_eq!(p.kind, ProviderKind::Cloud);

    // Modelos descubiertos: una edición con la misma URL los conserva.
    update_providers(|ps| {
        ps.iter_mut()
            .find(|x| x.id == "mi-proxy")
            .expect("p")
            .models = vec!["m1".into()];
        Ok(())
    })
    .expect("models");
    let mut edit = input(
        "mi-proxy",
        "https://api.ejemplo.com/v1",
        "ULTRON_KEY_MI_PROXY",
    );
    edit.name = "Renombrado".into();
    edit.default_model = None;
    let p = upsert_custom_provider(&edit).expect("edición");
    assert_eq!(p.name, "Renombrado");
    assert_eq!(p.models, vec!["m1".to_string()]);
    assert_eq!(p.default_model, "modelo-a");

    let stored = load_providers().expect("load");
    assert_eq!(stored.iter().filter(|x| x.id == "mi-proxy").count(), 1);

    remove_custom_provider("mi-proxy").expect("baja");
    assert!(load_providers()
        .expect("load")
        .iter()
        .all(|x| x.id != "mi-proxy"));
}

/// Caso negativo: ni se sobrescribe ni se borra un proveedor del seed.
#[test]
fn no_toca_los_proveedores_del_seed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    let err = upsert_custom_provider(&input(
        "groq",
        "https://api.ejemplo.com/v1",
        "ULTRON_KEY_GROQ",
    ))
    .expect_err("seed");
    assert!(err.contains("catálogo base"), "{err}");
    let err = remove_custom_provider("deepseek").expect_err("seed");
    assert!(err.contains("no es un proveedor personalizado"), "{err}");
    assert!(remove_custom_provider("no-existe").is_err());
}

/// Caso negativo: un proveedor que usa una zona no se borra en silencio.
#[test]
fn no_borra_un_proveedor_en_uso_por_una_zona() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    upsert_custom_provider(&input(
        "mi-proxy",
        "https://api.ejemplo.com/v1",
        "ULTRON_KEY_MI_PROXY",
    ))
    .expect("alta");
    let mut zones = load_zones().expect("zones");
    zones[0].fallbacks.push(ZoneAssignment {
        provider_id: "mi-proxy".into(),
        model: "modelo-a".into(),
        max_tokens: 64,
    });
    crate::ai_router::store::write_json(
        &crate::ai_router::types::zones_path().expect("path"),
        &zones,
    )
    .expect("write");
    let err = remove_custom_provider("mi-proxy").expect_err("en uso");
    assert!(err.contains("en uso"), "{err}");
}

/// Un proveedor personalizado `openai_compat` (id que el código no conoce)
/// se despacha a `call_openai_compat`: la petición llega a
/// `{base}/chat/completions` con su Bearer y su respuesta vuelve.
#[test]
fn un_custom_openai_compat_se_despacha_por_protocolo() {
    // Variable propia de este test: no hace falta el cerrojo de entorno.
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    let body = r#"{"choices":[{"message":{"content":"hola desde el mock"}}],
        "usage":{"prompt_tokens":3,"completion_tokens":4}}"#;
    let (base, rx) = test_http::serve(vec![(200, body.to_string())]);
    std::env::set_var("ULTRON_KEY_TEST_DISPATCH", "sk-test-dispatch");
    let inp = input(
        "mi-proxy",
        &format!("{base}/v1"),
        "ULTRON_KEY_TEST_DISPATCH",
    );
    upsert_custom_provider(&inp).expect("alta");

    let asg = ZoneAssignment {
        provider_id: "mi-proxy".into(),
        model: "modelo-a".into(),
        max_tokens: 64,
    };
    let result = try_assignment_call(&asg, "hola", None);
    std::env::remove_var("ULTRON_KEY_TEST_DISPATCH");
    let (outcome, _) = result.expect("despacho a call_openai_compat");
    assert_eq!(outcome.text, "hola desde el mock");
    assert_eq!(outcome.usage.output_tokens, 4);
    let req = rx.recv().expect("petición");
    assert!(req.starts_with("POST /v1/chat/completions "), "{req}");
    assert!(
        req.to_ascii_lowercase()
            .contains("authorization: bearer sk-test-dispatch"),
        "{req}"
    );
}

fn write_catalog(extra: Provider) {
    let mut ps = crate::ai_router::seed::seed_providers();
    ps.push(extra);
    crate::ai_router::store::write_json(
        &crate::ai_router::types::providers_path().expect("path"),
        &ps,
    )
    .expect("write");
}

fn call(provider_id: &str) -> String {
    let asg = ZoneAssignment {
        provider_id: provider_id.into(),
        model: "m".into(),
        max_tokens: 16,
    };
    try_assignment_call(&asg, "hola", None)
        .map(|_| String::new())
        .expect_err("debía fallar")
        .0
}

/// Caso negativo: `api_format: cli` sin `cli_command` y un protocolo
/// desconocido dan un error explícito, no un no-op. Van como entradas del
/// catálogo (`custom: false`, p. ej. editado a mano): un personalizado así
/// ya no llega al despacho porque la carga lo descarta (`validate_custom`).
#[test]
fn cli_sin_comando_y_protocolo_desconocido_dan_error_explicito() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    let mut cli = build_custom(&input("cli-roto", "https://a.com", "GROQ_API_KEY"), None);
    cli.api_format = ApiFormat::Cli;
    cli.custom = false;
    write_catalog(cli);
    let err = call("cli-roto");
    assert!(
        err.contains("api_format 'cli' but has no cli_command"),
        "{err}"
    );

    let mut unknown = build_custom(&input("raro", "https://a.com", ""), None);
    unknown.api_format = ApiFormat::Unknown;
    unknown.key_env_var = String::new();
    unknown.custom = false;
    write_catalog(unknown);
    let err = call("raro");
    assert!(err.contains("unknown api_format"), "{err}");
}

/// Caso negativo (hallazgo de seguridad): un proveedor personalizado no puede
/// usar una key integrada, porque mandaría ese secreto a un host arbitrario.
#[test]
fn rechaza_keys_integradas_en_un_personalizado() {
    for key in [
        "ANTHROPIC_API_KEY",
        "DEEPSEEK_API_KEY",
        "OPENROUTER_API_KEY",
        "GROQ_API_KEY",
    ] {
        let err = validate_custom(&input("x1", "https://atacante.example/v1", key))
            .expect_err("key integrada");
        assert!(err.contains("ULTRON_KEY_<NOMBRE>"), "{key}: {err}");
    }
    validate_custom(&input("x1", "https://a.example/v1", "ULTRON_KEY_X1")).expect("propia");
}

/// El loopback IPv6 vale igual que en el formulario (validation.ts).
#[test]
fn acepta_loopback_ipv6_sin_key() {
    let inp = input("ipv6", "http://[::1]:8080/v1", "");
    validate_custom(&inp).expect("[::1]");
    assert_eq!(build_custom(&inp, None).kind, ProviderKind::Local);
    assert!(validate_custom(&input("ipv6", "http://[::2]:8080/v1", "")).is_err());
}

/// Caso negativo: un proxy local que declara variable de key y no la tiene
/// definida no se da por configurado (route() lo salta en vez de fallar en
/// cada llamada); sin variable, sí.
#[test]
fn un_local_con_key_sin_definir_no_esta_configurado() {
    let with_key = build_custom(
        &input(
            "lm-auth",
            "http://127.0.0.1:1234/v1",
            "ULTRON_KEY_TEST_NO_DEFINIDA_LM",
        ),
        None,
    );
    assert_eq!(with_key.kind, ProviderKind::Local);
    assert_eq!(compute_key_status(&with_key), ApiKeyStatus::Missing);
    let keyless = build_custom(&input("lm", "http://localhost:1234/v1", ""), None);
    assert_eq!(compute_key_status(&keyless), ApiKeyStatus::Configured);
}

/// Caso negativo: en loopback sin key solo valen `openai_compat` y `ollama`;
/// `anthropic` y `gemini` siempre envían una key y la exigen.
#[test]
fn loopback_sin_key_solo_con_openai_compat_u_ollama() {
    for format in [ApiFormat::Anthropic, ApiFormat::Gemini] {
        let mut inp = input("lm", "http://localhost:4000", "");
        inp.api_format = format;
        let err = validate_custom(&inp).expect_err("protocolo con key obligatoria");
        assert!(err.contains("obligatorio"), "{format:?}: {err}");
        assert!(!err.contains("  "), "literal partido con espacios: {err}");
        inp.key_env_var = "ULTRON_KEY_LM".into();
        validate_custom(&inp).unwrap_or_else(|e| panic!("{format:?} con key: {e}"));
    }
    for format in [ApiFormat::OpenaiCompat, ApiFormat::Ollama] {
        let mut inp = input("lm", "http://localhost:4000", "");
        inp.api_format = format;
        validate_custom(&inp).unwrap_or_else(|e| panic!("{format:?}: {e}"));
    }
}

/// Codex #4: un personalizado leído de disco no conserva endpoints ni un modo
/// CLI editados a mano: todo se regenera desde la base validada.
#[test]
fn lo_derivado_se_regenera_desde_la_base_validada() {
    let mut hostile = build_custom(
        &input(
            "editado",
            "https://api.example.com/v1/",
            "ULTRON_KEY_EDITADO",
        ),
        None,
    );
    hostile.health_endpoint = Some("https://evil.example.com/models".into());
    hostile.kind = ProviderKind::Cli;
    hostile.cli_command = Some("calc.exe".into());
    hostile.base_url = "https://api.example.com/v1/".into();
    let kept = retain_valid_customs(vec![hostile]);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].base_url, "https://api.example.com/v1");
    assert_eq!(
        kept[0].health_endpoint.as_deref(),
        Some("https://api.example.com/v1/models")
    );
    assert_eq!(kept[0].kind, ProviderKind::Cloud);
    assert_eq!(kept[0].cli_command, None);
}
