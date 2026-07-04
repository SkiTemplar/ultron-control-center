// KIRKARDO R4 gap tests + LatencyHistogram p50/p95 + apply_metric_sample tests.

use std::collections::HashMap;

use crate::ai_router::exec::{retry_delay_ms, xorshift64_jitter_seed};
use crate::ai_router::providers::apply_metric_sample;
use crate::ai_router::types::free_tier_daily_limit;
use crate::ai_router::types::{DailyUsage, LatencyHistogram, ModeCounters, RouterMetrics};

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
// KIRKARDO P2 — by_mode / by_class reset coordination
// -----------------------------------------------------------------------

#[test]
fn by_mode_reset_coordinated_with_daily() {
    let stale_date = "2000-01-01".to_string();
    let mut mode_counters = ModeCounters {
        date: stale_date.clone(),
        counts: {
            let mut m = HashMap::new();
            m.insert("dual".to_string(), 42u64);
            m
        },
    };

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

    let mut du = DailyUsage {
        date: stale_date.clone(),
        count: 99,
    };

    if du.date != today {
        du.date = today.clone();
        du.count = 0;
    }
    du.count = du.count.saturating_add(1);

    if mode_counters.date != today {
        mode_counters.date = today.clone();
        mode_counters.counts.clear();
    }
    let mc = mode_counters.counts.entry("dual".to_string()).or_insert(0);
    *mc = mc.saturating_add(1);

    assert_eq!(du.date, today);
    assert_eq!(mode_counters.date, today);
    assert_eq!(du.count, 1);
    assert_eq!(mode_counters.counts.get("dual").copied().unwrap_or(0), 1);
    assert_eq!(du.date, mode_counters.date);
}

#[test]
fn apply_metric_sample_health_gate_opens_and_clears_cooldown() {
    let mut m = RouterMetrics::default();
    let day = "2026-06-10";

    let mut fail = metric_sample("gemini-cli", "gemini-2.5-flash");
    fail.success = false;
    fail.error = Some("gemini exited 1: quota exceeded");

    apply_metric_sample(&mut m, &fail, day);
    apply_metric_sample(&mut m, &fail, day);
    let cm = &m.by_class["gemini-cli"];
    assert_eq!(cm.consecutive_failures, 2);
    assert!(
        cm.cooldown_until.is_none(),
        "2 fallos no deben abrir cooldown (umbral=3)"
    );
    assert_eq!(
        cm.last_error.as_deref(),
        Some("gemini exited 1: quota exceeded")
    );

    apply_metric_sample(&mut m, &fail, day);
    let cm = &m.by_class["gemini-cli"];
    assert_eq!(cm.consecutive_failures, 3);
    assert!(cm.cooldown_until.is_some(), "3 fallos abren cooldown");
    assert!(cm.last_error_at.is_some());

    let ok = metric_sample("gemini-cli", "gemini-2.5-flash");
    apply_metric_sample(&mut m, &ok, day);
    let cm = &m.by_class["gemini-cli"];
    assert_eq!(cm.consecutive_failures, 0);
    assert!(cm.cooldown_until.is_none());
    assert!(cm.last_error.is_none());
    assert!(cm.last_success_at.is_some());
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
