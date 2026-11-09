// KIRKARDO R4 gap tests + LatencyHistogram p50/p95 + apply_metric_sample tests.

use crate::ai_router::exec::{retry_delay_ms, xorshift64_jitter_seed};
use crate::ai_router::providers::{apply_metric_sample, apply_route_outcome};
use crate::ai_router::types::free_tier_daily_limit;
use crate::ai_router::types::{
    daily_quota_key, DailyUsage, LatencyHistogram, RouteOutcome, RouterMetrics,
    RECENT_FALLBACK_WINDOW,
};

use super::{env_lock, metric_sample};

// -----------------------------------------------------------------------
// KIRKARDO R4 — gap tests
// -----------------------------------------------------------------------

#[test]
fn xorshift64_jitter_seed_in_range() {
    for _ in 0..50 {
        let v = xorshift64_jitter_seed() % 1000;
        assert!(v < 1000, "jitter seed mod 1000 must be < 1000, got {v}");
    }
}

#[test]
fn retry_delay_ms_within_jitter_bounds() {
    // Escala corta (Timeout/Overloaded/Error): la de siempre.
    let bases: &[(u32, u64)] = &[(0, 500), (1, 1000), (2, 2000), (3, 4000)];
    for &(attempt, base) in bases {
        for _ in 0..20 {
            let delay = retry_delay_ms(attempt, crate::ai_router::types::FailReason::Timeout);
            let lo = ((base as f64) * 0.8) as u64;
            let hi = ((base as f64) * 1.2) as u64;
            assert!(
                delay >= 100,
                "delay must be >= 100 ms (floor), got {delay} for attempt {attempt}"
            );
            assert!(
                delay >= lo.max(100) && delay <= hi,
                "delay {delay} out of ±20% bounds [{lo}, {hi}] for attempt {attempt}"
            );
        }
    }
}

#[test]
fn retry_delay_ms_rate_limit_uses_long_scale() {
    // cat3 2026-07-04: los 429 RPM de groq viven en ventanas de ~60s — la
    // escala RateLimit (2s/5s/10s) debe SALIR de la ventana, no quemarse en
    // 3.5s dentro de ella.
    use crate::ai_router::types::FailReason;
    let bases: &[(u32, u64)] = &[(0, 2_000), (1, 5_000), (2, 10_000), (3, 10_000)];
    for &(attempt, base) in bases {
        for _ in 0..20 {
            let delay = retry_delay_ms(attempt, FailReason::RateLimit);
            let lo = ((base as f64) * 0.8) as u64;
            let hi = ((base as f64) * 1.2) as u64;
            assert!(
                delay >= lo && delay <= hi,
                "RateLimit delay {delay} out of ±20% bounds [{lo}, {hi}] for attempt {attempt}"
            );
        }
    }
    // Caso negativo: un Error NO transitorio jamas llega a dormir (with_retry
    // corta antes), y si alguien pidiera el delay igualmente, seria la escala
    // corta — la larga es EXCLUSIVA de RateLimit.
    let d = retry_delay_ms(0, FailReason::Error);
    assert!(
        (400..=600).contains(&d),
        "Error debe usar la escala corta (~500ms), got {d}"
    );
}

#[test]
fn env_override_gemini_tier_limit() {
    // SAFETY: serialised by the module-level ENV_MUTEX shared with all
    // env-override tests so they cannot interleave their set_var calls.
    let _g = env_lock();
    unsafe { std::env::set_var("ULTRON_GEMINI_TIER_LIMIT", "50") };
    let limit = free_tier_daily_limit("gemini");
    unsafe { std::env::remove_var("ULTRON_GEMINI_TIER_LIMIT") };

    assert_eq!(
        limit,
        Some(50),
        "env override ULTRON_GEMINI_TIER_LIMIT=50 must take effect"
    );
}

#[test]
fn env_override_groq_tier_limit() {
    let _g = env_lock();
    unsafe { std::env::set_var("ULTRON_GROQ_TIER_LIMIT", "200") };
    let limit = free_tier_daily_limit("groq");
    unsafe { std::env::remove_var("ULTRON_GROQ_TIER_LIMIT") };

    assert_eq!(
        limit,
        Some(200),
        "env override ULTRON_GROQ_TIER_LIMIT=200 must take effect"
    );
}

#[test]
fn env_override_invalid_value_uses_hardcoded_default() {
    let _g = env_lock();
    unsafe { std::env::set_var("ULTRON_GEMINI_TIER_LIMIT", "not-a-number") };
    let limit = free_tier_daily_limit("gemini");
    unsafe { std::env::remove_var("ULTRON_GEMINI_TIER_LIMIT") };

    assert_eq!(
        limit,
        Some(20),
        "invalid env override must fall back to hardcoded default (20)"
    );
}

#[test]
fn latency_histogram_record_warns_on_corrupt_state() {
    let mut h = LatencyHistogram {
        bounds: LatencyHistogram::default_bounds(),
        counts: vec![0u64; 2],
        total: 0,
        sum_ms: 0,
    };
    h.record(300);
    assert_eq!(h.counts.len(), h.bounds.len());
    assert_eq!(h.total, 1);
    assert!(h.sum_ms > 0);
}

// -----------------------------------------------------------------------
// LatencyHistogram p50/p95 correctness
// -----------------------------------------------------------------------

#[test]
fn latency_histogram_p50_p95_correct() {
    let mut h = LatencyHistogram::default();
    for _ in 0..10 {
        h.record(80);
    }
    for _ in 0..9 {
        h.record(600);
    }
    assert_eq!(h.total, 19);
    assert_eq!(h.p50_ms(), 100);
    assert_eq!(h.p95_ms(), 1_000);
    let expected_avg = (10u64 * 80 + 9 * 600) / 19;
    assert_eq!(h.avg_ms(), expected_avg);
}

#[test]
fn latency_histogram_empty_returns_zero() {
    let h = LatencyHistogram::default();
    assert_eq!(h.p50_ms(), 0);
    assert_eq!(h.p95_ms(), 0);
    assert_eq!(h.avg_ms(), 0);
}

// -----------------------------------------------------------------------
// router-2 (2026-10-23): contador diario free-tier por (proveedor, modelo)
// -----------------------------------------------------------------------

#[test]
fn daily_counter_is_kept_per_provider_and_model() {
    let mut m = RouterMetrics::default();
    // Clave antigua por proveedor, escrita por un binario anterior.
    m.daily.insert(
        "groq".into(),
        DailyUsage {
            date: "2026-10-23".into(),
            count: 999,
        },
    );
    apply_metric_sample(
        &mut m,
        &metric_sample("groq", "openai/gpt-oss-120b"),
        "2026-10-23",
    );
    apply_metric_sample(
        &mut m,
        &metric_sample("groq", "openai/gpt-oss-120b"),
        "2026-10-23",
    );
    apply_metric_sample(
        &mut m,
        &metric_sample("groq", "openai/gpt-oss-20b"),
        "2026-10-23",
    );

    assert_eq!(m.daily_used("groq", "openai/gpt-oss-120b", "2026-10-23"), 2);
    assert_eq!(m.daily_used("groq", "openai/gpt-oss-20b", "2026-10-23"), 1);
    assert!(
        !m.daily.contains_key("groq"),
        "la clave por proveedor sumaba los dos buckets y se descarta"
    );
    // Cambio de día: el bucket arranca de cero.
    apply_metric_sample(
        &mut m,
        &metric_sample("groq", "openai/gpt-oss-20b"),
        "2026-10-24",
    );
    assert_eq!(
        m.daily[&daily_quota_key("groq", "openai/gpt-oss-20b")].count,
        1
    );
}

// -----------------------------------------------------------------------
// router-1 (2026-10-23): resultado de cada route()
// -----------------------------------------------------------------------

#[test]
fn route_outcomes_feed_counters_and_window() {
    let mut m = RouterMetrics::default();
    apply_route_outcome(&mut m, RouteOutcome::Primary);
    apply_route_outcome(&mut m, RouteOutcome::Fallback);
    apply_route_outcome(&mut m, RouteOutcome::Failed);
    assert_eq!(m.routes_total, 3);
    assert_eq!(m.real_fallback_count, 1);
    assert_eq!(m.routes_failed, 1);
    assert_eq!(
        m.recent_outcomes,
        vec![
            RouteOutcome::Primary,
            RouteOutcome::Fallback,
            RouteOutcome::Failed
        ]
    );
}

#[test]
fn route_outcome_window_is_bounded() {
    let mut m = RouterMetrics::default();
    for _ in 0..RECENT_FALLBACK_WINDOW {
        apply_route_outcome(&mut m, RouteOutcome::Failed);
    }
    apply_route_outcome(&mut m, RouteOutcome::Primary);
    assert_eq!(m.recent_outcomes.len(), RECENT_FALLBACK_WINDOW);
    assert_eq!(m.recent_outcomes.last(), Some(&RouteOutcome::Primary));
}

/// Un metrics.json escrito por un binario anterior (ventana booleana) se lee
/// sin perder la ventana y sin volver a escribir el campo antiguo.
#[test]
fn legacy_boolean_window_is_adopted_and_not_written_back() {
    let legacy = r#"{"fallback_output_tokens":0,"cost_saved_usd":0.0,"by_class":{},
        "fallback_rate":0.0,"routes_total":3,"real_fallback_count":1,
        "recent_routes":[false,true,false]}"#;
    let mut m: RouterMetrics = serde_json::from_str(legacy).expect("legacy");
    m.adopt_legacy_window();
    assert_eq!(
        m.recent_outcomes,
        vec![
            RouteOutcome::Primary,
            RouteOutcome::Fallback,
            RouteOutcome::Primary
        ]
    );
    let out = serde_json::to_value(&m).expect("json");
    assert!(out.get("recent_routes").is_none());
    assert_eq!(out["recent_outcomes"][1], "fallback");
}

#[test]
fn route_rates_see_failed_routes() {
    let mut m = RouterMetrics::default();
    for _ in 0..3 {
        apply_route_outcome(&mut m, RouteOutcome::Primary);
    }
    apply_route_outcome(&mut m, RouteOutcome::Failed);
    let r = crate::ai_router::route_rates(&m);
    assert_eq!(r.missed_primary, 0.25);
    assert_eq!(r.failed, 0.25);
    assert_eq!(r.missed_primary_recent, 0.25);
    assert_eq!(r.failed_recent, 0.25);
    // Caso negativo: sin rutas, todo a cero (no NaN).
    let empty = crate::ai_router::route_rates(&RouterMetrics::default());
    assert_eq!(empty.missed_primary, 0.0);
    assert_eq!(empty.failed_recent, 0.0);
}

#[test]
fn apply_metric_sample_health_gate_opens_and_clears_cooldown() {
    let mut m = RouterMetrics::default();
    let day = "2026-06-10";

    let mut fail = metric_sample("gemini-cli", "gemini-2.5-flash");
    fail.success = false;
    fail.error = Some("gemini exited 1: quota exceeded");

    let key = "gemini-cli::gemini-2.5-flash";
    apply_metric_sample(&mut m, &fail, day);
    apply_metric_sample(&mut m, &fail, day);
    let mm = &m.by_model[key];
    assert_eq!(mm.consecutive_failures, 2);
    assert!(
        mm.cooldown_until.is_none(),
        "2 fallos no deben abrir cooldown (umbral=3)"
    );
    assert_eq!(
        m.by_class["gemini-cli"].last_error.as_deref(),
        Some("gemini exited 1: quota exceeded")
    );

    apply_metric_sample(&mut m, &fail, day);
    let mm = &m.by_model[key];
    assert_eq!(mm.consecutive_failures, 3);
    assert!(mm.cooldown_until.is_some(), "3 fallos abren cooldown");
    assert!(m.by_class["gemini-cli"].last_error_at.is_some());
    assert!(
        m.by_class["gemini-cli"].cooldown_until.is_none(),
        "el cooldown vive por modelo, no por proveedor"
    );

    let ok = metric_sample("gemini-cli", "gemini-2.5-flash");
    apply_metric_sample(&mut m, &ok, day);
    let mm = &m.by_model[key];
    assert_eq!(mm.consecutive_failures, 0);
    assert!(mm.cooldown_until.is_none());
    let cm = &m.by_class["gemini-cli"];
    assert!(cm.last_error.is_none());
    assert!(cm.last_success_at.is_some());
}

#[test]
fn apply_metric_sample_redacta_el_error_antes_de_recortarlo() {
    use crate::ai_router::providers::metrics::MAX_LAST_ERROR_CHARS;
    let mut m = RouterMetrics::default();
    // El token empieza 14 caracteres antes del tope: recortar primero deja
    // `ghp_` + 10 caracteres, por debajo del mínimo del patrón, y escapa.
    let error = format!(
        "{} ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        "e".repeat(MAX_LAST_ERROR_CHARS - 15)
    );
    let mut fail = metric_sample("groq", "m");
    fail.success = false;
    fail.error = Some(&error);
    apply_metric_sample(&mut m, &fail, "2026-10-18");
    let guardado = m.by_class["groq"].last_error.clone().unwrap_or_default();
    assert!(
        !guardado.contains("ghp_"),
        "ni el prefijo del token: {guardado}"
    );
    assert!(guardado.contains("[REDACTED"), "{guardado}");
    assert!(
        guardado.chars().count() <= MAX_LAST_ERROR_CHARS + 3,
        "sigue acotado"
    );
}

/// Una clave de Groq (`gsk_…`) en el cuerpo de un 401 no llega a `last_error`.
#[test]
fn apply_metric_sample_redacta_una_clave_de_groq() {
    let mut m = RouterMetrics::default();
    let key = format!("gsk_{}", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijkl");
    let error = format!("401 Unauthorized: invalid api key {key}");
    let mut fail = metric_sample("groq", "m");
    fail.success = false;
    fail.error = Some(&error);
    apply_metric_sample(&mut m, &fail, "2026-10-23");
    let guardado = m.by_class["groq"].last_error.clone().unwrap_or_default();
    assert!(
        !guardado.contains("gsk_"),
        "ni el prefijo de la clave: {guardado}"
    );
    assert!(guardado.contains("[REDACTED:groq_key]"), "{guardado}");
}

/// Minutos que faltan hasta `cooldown_until` del modelo (redondeo al minuto).
fn cooldown_minutes_left(m: &RouterMetrics, key: &str) -> i64 {
    let until = m.by_model[key].cooldown_until.as_deref().expect("cooldown");
    let until = chrono::DateTime::parse_from_rfc3339(until).unwrap();
    let secs = (until.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_seconds();
    (secs + 30) / 60
}

#[test]
fn health_gate_429_on_one_model_does_not_bench_its_sibling() {
    use crate::ai_router::types::FailReason;
    let mut m = RouterMetrics::default();
    let day = "2026-09-28";
    let mut fail = metric_sample("groq", "openai/gpt-oss-120b");
    fail.success = false;
    fail.fail_reason = Some(FailReason::RateLimit);
    fail.error = Some("groq 429: tokens per day [retry-after=433s]");
    apply_metric_sample(&mut m, &fail, day);

    assert_eq!(
        cooldown_minutes_left(&m, "groq::openai/gpt-oss-120b"),
        7,
        "un 429 con plazo largo enfría desde el primer fallo, el plazo exacto"
    );
    assert!(
        !m.by_model.contains_key("groq::openai/gpt-oss-20b"),
        "el modelo hermano no se toca"
    );
    assert!(m.by_class["groq"].cooldown_until.is_none());
}

#[test]
fn health_gate_short_retry_hint_does_not_cool_down() {
    use crate::ai_router::types::FailReason;
    let mut m = RouterMetrics::default();
    let mut fail = metric_sample("groq", "openai/gpt-oss-120b");
    fail.success = false;
    fail.fail_reason = Some(FailReason::RateLimit);
    fail.error = Some("groq 429: rpm [retry-after=4s]");
    apply_metric_sample(&mut m, &fail, "2026-09-28");
    assert!(
        m.by_model["groq::openai/gpt-oss-120b"]
            .cooldown_until
            .is_none(),
        "≤10 s se espera en línea; no saca el modelo de la cadena"
    );
}

#[test]
fn health_gate_backoff_doubles_up_to_two_hours() {
    let mut m = RouterMetrics::default();
    let key = "groq::openai/gpt-oss-120b";
    let mut fail = metric_sample("groq", "openai/gpt-oss-120b");
    fail.success = false;
    fail.error = Some("groq 500: upstream");
    let mut seen = Vec::new();
    for _ in 0..7 {
        apply_metric_sample(&mut m, &fail, "2026-09-28");
        seen.push(
            m.by_model[key]
                .cooldown_until
                .as_ref()
                .map(|_| cooldown_minutes_left(&m, key)),
        );
    }
    assert_eq!(
        seen,
        vec![
            None,
            None,
            Some(15),
            Some(30),
            Some(60),
            Some(120),
            Some(120)
        ]
    );
}

#[test]
fn health_gate_survives_daily_counter_reset() {
    let mut m = RouterMetrics::default();
    let key = "groq::openai/gpt-oss-120b";
    let mut fail = metric_sample("groq", "openai/gpt-oss-120b");
    fail.success = false;
    fail.error = Some("groq 500: upstream");
    for _ in 0..3 {
        apply_metric_sample(&mut m, &fail, "2026-09-28");
    }
    apply_metric_sample(&mut m, &fail, "2026-09-29");
    let mm = &m.by_model[key];
    assert_eq!(mm.count, 1, "los contadores diarios sí se reinician");
    assert_eq!(mm.consecutive_failures, 4, "la racha de fallos no");
    assert_eq!(cooldown_minutes_left(&m, key), 30);
}

#[test]
fn apply_metric_sample_by_model_resets_only_on_day_boundary() {
    let mut m = RouterMetrics::default();
    let key = "groq::llama";

    apply_metric_sample(&mut m, &metric_sample("groq", "llama"), "2026-06-05");
    assert_eq!(m.by_model[key].count, 1);
    assert_eq!(m.by_model[key].date, "2026-06-05");

    apply_metric_sample(&mut m, &metric_sample("groq", "llama"), "2026-06-05");
    apply_metric_sample(&mut m, &metric_sample("groq", "llama"), "2026-06-05");
    assert_eq!(m.by_model[key].count, 3);

    apply_metric_sample(&mut m, &metric_sample("groq", "llama"), "2026-06-06");
    assert_eq!(
        m.by_model[key].count, 1,
        "day2 call1: resets at the boundary"
    );
    assert_eq!(m.by_model[key].date, "2026-06-06");

    apply_metric_sample(&mut m, &metric_sample("groq", "llama"), "2026-06-06");
    assert_eq!(
        m.by_model[key].count, 2,
        "day2 call2 must accumulate, NOT wipe"
    );
}

#[test]
fn apply_metric_sample_resets_each_model_independently() {
    let mut m = RouterMetrics::default();

    apply_metric_sample(&mut m, &metric_sample("groq", "a"), "2026-06-05");
    apply_metric_sample(&mut m, &metric_sample("groq", "b"), "2026-06-05");
    assert_eq!(m.by_model["groq::a"].count, 1);
    assert_eq!(m.by_model["groq::b"].count, 1);

    apply_metric_sample(&mut m, &metric_sample("groq", "a"), "2026-06-06");
    apply_metric_sample(&mut m, &metric_sample("groq", "b"), "2026-06-06");
    assert_eq!(m.by_model["groq::a"].count, 1, "model a resets on day 2");
    assert_eq!(
        m.by_model["groq::b"].count, 1,
        "model b ALSO resets independently on day 2"
    );
}

#[test]
fn apply_metric_sample_by_class_resets_only_on_day_boundary() {
    let mut m = RouterMetrics::default();

    apply_metric_sample(&mut m, &metric_sample("groq", "llama"), "2026-06-05");
    assert_eq!(m.by_class["groq"].count, 1);
    assert_eq!(m.by_class["groq"].success_count, 1);
    assert_eq!(m.by_class["groq"].date, "2026-06-05");

    apply_metric_sample(&mut m, &metric_sample("groq", "llama"), "2026-06-05");
    assert_eq!(m.by_class["groq"].count, 2);
    assert_eq!(m.by_class["groq"].success_count, 2);

    apply_metric_sample(&mut m, &metric_sample("groq", "llama"), "2026-06-06");
    assert_eq!(
        m.by_class["groq"].count, 1,
        "day2 call1: resets at the boundary"
    );
    assert_eq!(
        m.by_class["groq"].success_count, 1,
        "day2 success_count must NOT carry over"
    );
    assert_eq!(m.by_class["groq"].date, "2026-06-06");

    apply_metric_sample(&mut m, &metric_sample("groq", "llama"), "2026-06-06");
    assert_eq!(
        m.by_class["groq"].count, 2,
        "day2 call2 must accumulate, NOT wipe"
    );
}
