// Tests de la resolución de keys con el entorno saneado que hereda un hook de
// una sesión de ULTRON y un `HKCU\Environment` simulado. Ningún test lee ni
// imprime una key real: las variables `ULTRON_KEY_TEST_*` nunca existen en el
// entorno.

use super::{pick_key, resolve_key, SimulatedUserScope};
use crate::ai_router::providers::route;
use crate::ai_router::seed::seed_providers;
use crate::ai_router::store::{compute_key_status, write_json};
use crate::ai_router::test_http;
use crate::ai_router::types::{
    providers_path, zones_path, ApiFormat, ApiKeyStatus, Provider, ProviderKind, TestRootGuard,
    Zone, ZoneAssignment,
};

const OPENAI_REPLY: &str =
    r#"{"choices":[{"message":{"content":"hola"}}],"usage":{"completion_tokens":1}}"#;

fn provider(id: &str, base_url: &str, key_env_var: &str) -> Provider {
    let mut p = seed_providers()
        .into_iter()
        .find(|p| p.id == "groq")
        .expect("groq en el seed");
    p.id = id.into();
    p.base_url = base_url.into();
    p.key_env_var = key_env_var.into();
    p.health_endpoint = None;
    p.kind = ProviderKind::Cloud;
    p.api_format = ApiFormat::OpenaiCompat;
    p
}

fn write_zone(p: Provider) {
    let zone = Zone {
        id: "prueba".into(),
        label: "prueba".into(),
        category: "test".into(),
        primary: ZoneAssignment {
            provider_id: p.id.clone(),
            model: "m1".into(),
            max_tokens: 64,
        },
        fallbacks: Vec::new(),
        system_prompt: None,
    };
    let mut providers = seed_providers();
    providers.push(p);
    write_json(&providers_path().expect("providers"), &providers).expect("providers.json");
    write_json(&zones_path().expect("zones"), &vec![zone]).expect("zones.json");
}

/// Reproducción del fallo medido en producción: con el entorno saneado y sin la
/// key en el registro, el proveedor se salta con el mismo mensaje que hay en
/// `route-decisions.jsonl`.
#[test]
fn con_el_entorno_saneado_y_sin_registro_se_salta_el_proveedor() {
    const VAR: &str = "ULTRON_KEY_TEST_HKCU_REPRO";
    let dir = tempfile::tempdir().expect("tempdir");
    let _root = TestRootGuard::new(dir.path());
    write_zone(provider("repro", "https://example.invalid/v1", VAR));
    let err = route("prueba", "hola").expect_err("sin key");
    assert!(err.contains("provider has no API key"), "{err}");
}

/// El arreglo: con la misma key solo en `HKCU`, la ruta se sirve con ella y no
/// vuelve al entorno del proceso.
#[test]
fn una_key_que_solo_esta_en_el_registro_sirve_la_ruta() {
    const VAR: &str = "ULTRON_KEY_TEST_HKCU_ROUTE";
    let dir = tempfile::tempdir().expect("tempdir");
    let _root = TestRootGuard::new(dir.path());
    let _hkcu = SimulatedUserScope::with(&[(VAR, "clave-simulada")]);
    let (base, rx) = test_http::serve(vec![(200, OPENAI_REPLY.to_string())]);
    write_zone(provider("hkcu", &format!("{base}/v1"), VAR));

    assert_eq!(route("prueba", "hola").expect("ruta"), "hola");
    let req = rx.recv().expect("petición");
    assert!(
        req.to_ascii_lowercase()
            .contains("authorization: bearer clave-simulada"),
        "{req}"
    );
    assert!(std::env::var(VAR).is_err(), "la key volvió al entorno");
}

/// Los procesos hijos del sidecar no heredan lo leído del registro.
#[test]
fn un_proceso_hijo_no_hereda_la_key_del_registro() {
    const VAR: &str = "ULTRON_KEY_TEST_HKCU_CHILD";
    let _hkcu = SimulatedUserScope::with(&[(VAR, "clave-simulada")]);
    assert_eq!(resolve_key(VAR).as_deref(), Some("clave-simulada"));
    if !crate::ai_router::store::detect_cli("node") {
        eprintln!("node no está en el PATH: se omite el hijo real");
        return;
    }
    let out = std::process::Command::new("node")
        .args(["-e", &format!("process.exit(process.env.{VAR} ? 9 : 0)")])
        .status()
        .expect("node");
    assert_eq!(out.code(), Some(0), "el hijo ve la key");
}

#[test]
fn el_estado_de_la_key_refleja_el_registro_y_detecta_placeholders() {
    const VAR: &str = "ULTRON_KEY_TEST_HKCU_STATUS";
    let p = provider("estado", "https://example.invalid/v1", VAR);
    assert_eq!(compute_key_status(&p), ApiKeyStatus::Missing);
    {
        let _hkcu = SimulatedUserScope::with(&[(VAR, "clave-simulada")]);
        assert_eq!(compute_key_status(&p), ApiKeyStatus::Configured);
    }
    let _hkcu = SimulatedUserScope::with(&[(VAR, "your-key-here")]);
    assert_eq!(compute_key_status(&p), ApiKeyStatus::Placeholder);
}

/// Toda lectura de la key de un proveedor pasa por `resolve_key`: una lectura
/// directa del entorno volvería a dejar sin key al sidecar de los hooks.
#[test]
fn ninguna_lectura_de_key_del_router_va_directa_al_entorno() {
    let direct = concat!("std::env::var(&", "p");
    for (file, src) in [
        (
            "call_wrappers.rs",
            include_str!("providers/call_wrappers.rs"),
        ),
        ("health.rs", include_str!("health.rs")),
        ("discover.rs", include_str!("discover.rs")),
        ("store.rs", include_str!("store.rs")),
        ("mod.rs", include_str!("mod.rs")),
    ] {
        assert!(!src.contains(direct), "{file} lee la key del entorno");
    }
}

#[test]
fn el_entorno_manda_y_no_se_consulta_el_registro() {
    let got = pick_key(Some("de-entorno".into()), || {
        panic!("no debe consultar el registro si el entorno tiene valor")
    });
    assert_eq!(got.as_deref(), Some("de-entorno"));
}

#[test]
fn sin_entorno_se_usa_el_registro() {
    let got = pick_key(None, || Some("de-registro".into()));
    assert_eq!(got.as_deref(), Some("de-registro"));
}

#[test]
fn un_valor_en_blanco_no_tapa_el_registro() {
    let got = pick_key(Some("   ".into()), || Some("de-registro".into()));
    assert_eq!(got.as_deref(), Some("de-registro"));
}

#[test]
fn un_valor_en_blanco_sin_alternativa_se_devuelve_tal_cual() {
    let got = pick_key(Some(" ".into()), || None);
    assert_eq!(got.as_deref(), Some(" "));
}

#[test]
fn sin_entorno_ni_registro_no_hay_key() {
    assert_eq!(pick_key(None, || None), None);
}

#[test]
fn resolve_key_lee_el_registro_simulado_sin_tocar_el_entorno() {
    const NAME: &str = "ULTRON_TEST_KEY_SOURCE_SOLO_REGISTRO";
    let _scope = SimulatedUserScope::with(&[(NAME, "valor-simulado")]);
    assert_eq!(resolve_key(NAME).as_deref(), Some("valor-simulado"));
    assert!(
        std::env::var(NAME).is_err(),
        "lo leído del registro no debe volver al entorno, o lo heredarían los hijos"
    );
}

#[test]
fn el_guard_limpia_el_registro_simulado() {
    const NAME: &str = "ULTRON_TEST_KEY_SOURCE_GUARD";
    {
        let _scope = SimulatedUserScope::with(&[(NAME, "temporal")]);
        assert_eq!(resolve_key(NAME).as_deref(), Some("temporal"));
    }
    assert_eq!(resolve_key(NAME), None);
}
