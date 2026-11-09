// Tests de `route()` y de sus piezas. Los que tocan disco van con
// `TestRootGuard`: escriben en un directorio temporal, nunca en ~/.ultron.

use std::collections::HashSet;

use super::{route, route_decision_line, skip_reason, ChainState, Skip};
use crate::ai_router::route_rates;
use crate::ai_router::seed::seed_providers;
use crate::ai_router::store::{load_metrics, write_json};
use crate::ai_router::types::{
    daily_quota_key, providers_path, route_decisions_path, zones_path, DailyUsage, Provider,
    ProviderKind, RouteOutcome, RouterMetrics, TestRootGuard, Zone, ZoneAssignment,
};

/// Proveedor de prueba que no hace red: `kind` y `key_env_var` deciden si
/// `route()` lo salta (sin clave) o lo intenta y falla («no wrapper»). Desde
/// que el despacho va por `api_format` (2026-10-26), lo que lo deja sin
/// wrapper es `ApiFormat::Unknown`; con el `OpenaiCompat` heredado de groq
/// haría una petición real.
fn test_provider(id: &str, kind: ProviderKind, key_env_var: &str) -> Provider {
    let mut p = seed_providers()
        .into_iter()
        .find(|p| p.id == "groq")
        .expect("groq en el seed");
    p.id = id.into();
    p.name = id.into();
    p.kind = kind;
    p.key_env_var = key_env_var.into();
    p.health_endpoint = None;
    p.api_format = crate::ai_router::types::ApiFormat::Unknown;
    p
}

fn asg(provider: &str, model: &str) -> ZoneAssignment {
    ZoneAssignment {
        provider_id: provider.into(),
        model: model.into(),
        max_tokens: 64,
    }
}

/// Catálogo y zona de prueba en la raíz temporal: primary sin clave
/// (saltado) y fallback sin wrapper (intentado y fallido).
fn write_failing_zone() {
    let mut providers = seed_providers();
    providers.push(test_provider(
        "sin-clave",
        ProviderKind::Cloud,
        "ULTRON_P5_TEST_KEY_THAT_DOES_NOT_EXIST",
    ));
    providers.push(test_provider("sin-wrapper", ProviderKind::Local, ""));
    write_json(&providers_path().expect("providers"), &providers).expect("providers.json");
    let zone = Zone {
        id: "prueba".into(),
        label: "prueba".into(),
        category: "test".into(),
        primary: asg("sin-clave", "m1"),
        fallbacks: vec![asg("sin-wrapper", "m2")],
        system_prompt: None,
    };
    write_json(&zones_path().expect("zones"), &vec![zone]).expect("zones.json");
}

/// router-1: un fallo total de la cadena cuenta como fallo en metrics.json,
/// en la ventana reciente y en route-decisions.jsonl. Antes contaba como una
/// ruta servida por el primary y no dejaba línea.
#[test]
fn a_failed_chain_is_counted_and_logged_as_failed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _root = TestRootGuard::new(dir.path());
    write_failing_zone();

    let err = route("prueba", "hola").expect_err("la cadena entera falla");
    assert!(
        err.contains("all providers failed for zone 'prueba'"),
        "{err}"
    );
    assert!(err.contains("no wrapper implemented"), "{err}");

    let m = load_metrics().expect("metrics");
    assert_eq!(m.routes_total, 1);
    assert_eq!(m.routes_failed, 1);
    assert_eq!(m.real_fallback_count, 0);
    assert_eq!(m.recent_outcomes, vec![RouteOutcome::Failed]);
    assert_eq!(
        m.by_model["sin-wrapper::m2"].count, 1,
        "el intento se registra"
    );
    let rates = route_rates(&m);
    assert_eq!(
        rates.missed_primary, 1.0,
        "el fallo cuenta como ruta sin primary"
    );
    assert_eq!(rates.failed_recent, 1.0, "la ventana reciente ve el fallo");

    let log = std::fs::read_to_string(route_decisions_path().expect("log")).expect("leer log");
    let lines: Vec<serde_json::Value> = log
        .lines()
        .map(|l| serde_json::from_str(l).expect("JSONL válido"))
        .collect();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["zone"], "prueba");
    assert_eq!(lines[0]["reason"], "failed");
    assert_eq!(lines[0]["used_fallback"], false);
    let logged = lines[0]["error"].as_str().unwrap_or("");
    assert!(logged.contains("all providers failed"), "{logged}");
    // Check 15.3: la línea de un fallo total es completa y nombra lo último
    // que se intentó; el error conserva el motivo de TODA la cadena.
    assert_eq!(lines[0]["provider_id"], "sin-wrapper");
    assert_eq!(lines[0]["model"], "m2");
    assert!(logged.contains("sin-clave"), "{logged}");
    assert!(logged.contains("no API key"), "{logged}");
    // El salto duro no hace intento, pero el panel de salud tiene que verlo.
    let skipped = &m.by_class["sin-clave"];
    assert_eq!(skipped.count, 0, "un salto no es una llamada");
    assert_eq!(skipped.consecutive_failures, 1);
    assert!(skipped
        .last_error
        .as_deref()
        .unwrap_or("")
        .contains("no API key"));
}

/// Una zona inexistente no es una ruta: no toca las métricas.
#[test]
fn an_unknown_zone_does_not_count_as_a_route() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _root = TestRootGuard::new(dir.path());
    assert!(route("zona-que-no-existe", "hola").is_err());
    assert_eq!(load_metrics().expect("metrics").routes_total, 0);
}

fn state<'a>(disabled: &'a HashSet<String>, metrics: &'a RouterMetrics) -> ChainState<'a> {
    ChainState {
        disabled,
        metrics,
        today: "2026-10-23",
        now: chrono::Utc::now(),
    }
}

/// router-2: con el bucket del 120b agotado, el 20b (otro bucket) se sigue
/// intentando. Con el contador por proveedor se saltaban los dos.
#[test]
fn an_exhausted_quota_bucket_only_skips_its_own_model() {
    let mut m = RouterMetrics::default();
    m.daily.insert(
        daily_quota_key("groq", "openai/gpt-oss-120b"),
        DailyUsage {
            date: "2026-10-23".into(),
            count: u64::MAX / 2,
        },
    );
    let disabled = HashSet::new();
    let st = state(&disabled, &m);
    assert!(matches!(
        skip_reason(&asg("groq", "openai/gpt-oss-120b"), &st),
        Some(Skip::Hard(why)) if why.contains("daily free-tier quota exhausted")
    ));
    assert!(
        skip_reason(&asg("groq", "openai/gpt-oss-20b"), &st).is_none(),
        "el 20b tiene su propio bucket"
    );
}

/// Caso negativo: el contador de AYER no agota la cuota de hoy, y la clave
/// antigua por proveedor ya no cuenta para ningún modelo.
#[test]
fn stale_or_legacy_daily_counters_do_not_skip() {
    let mut m = RouterMetrics::default();
    m.daily.insert(
        daily_quota_key("groq", "openai/gpt-oss-120b"),
        DailyUsage {
            date: "2026-10-22".into(),
            count: u64::MAX / 2,
        },
    );
    m.daily.insert(
        "groq".into(),
        DailyUsage {
            date: "2026-10-23".into(),
            count: u64::MAX / 2,
        },
    );
    let disabled = HashSet::new();
    assert!(skip_reason(&asg("groq", "openai/gpt-oss-120b"), &state(&disabled, &m)).is_none());
}

/// La línea de un fallo total es JSON válido, sin proveedor ganador y con el
/// error redactado.
#[test]
fn failed_decision_line_is_valid_json_with_a_redacted_error() {
    let secret = "sk-abcdEFGH1234567890ijklMNOP";
    let line = route_decision_line(
        "chat",
        "",
        "",
        RouteOutcome::Failed,
        Some(&format!("401 with key {secret}")),
    );
    let v: serde_json::Value = serde_json::from_str(line.trim_end()).expect("JSON");
    assert_eq!(v["reason"], "failed");
    assert_eq!(v["provider_id"], "");
    assert!(!v["error"].as_str().unwrap_or("").contains(secret), "{v}");
}

/// La clave de Groq (`gsk_…`) tampoco llega al log de rutas.
#[test]
fn failed_decision_line_redacts_a_groq_key() {
    let secret = format!("gsk_{}", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijkl");
    let line = route_decision_line(
        "chat",
        "",
        "",
        RouteOutcome::Failed,
        Some(&format!("groq: 401 invalid key {secret}")),
    );
    let v: serde_json::Value = serde_json::from_str(line.trim_end()).expect("JSON");
    let error = v["error"].as_str().unwrap_or("");
    assert!(!error.contains("gsk_"), "{v}");
    assert!(error.contains("[REDACTED:groq_key]"), "{v}");
}
