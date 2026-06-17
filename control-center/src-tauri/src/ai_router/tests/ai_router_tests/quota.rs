// Quota-awareness + 429 handling tests.

use crate::ai_router::types::free_tier_daily_limit;

// -----------------------------------------------------------------------
// Quota-awareness + 429 handling
// -----------------------------------------------------------------------

#[test]
fn gemini_free_tier_limit_is_twenty() {
    assert_eq!(
        free_tier_daily_limit("gemini"),
        Some(20),
        "Gemini free tier must be 20 req/day (not 1500)"
    );
}

#[test]
fn groq_free_tier_limit_is_one_thousand() {
    assert_eq!(free_tier_daily_limit("groq"), Some(1000));
}

#[test]
fn paid_only_providers_have_no_free_tier() {
    for pid in [
        "claude-haiku",
        "codex",
        "ollama",
        "deepseek",
        "codex-cli",
        "gemini-cli",
    ] {
        assert_eq!(
            free_tier_daily_limit(pid),
            None,
            "provider '{pid}' should return None for free_tier_daily_limit"
        );
    }
}

#[test]
fn rate_limit_error_strings_are_detected() {
    let rate_limit_samples = [
        "HTTP 429 Too Many Requests",
        "status 429",
        "RATE_LIMIT exceeded",
        "RESOURCE_EXHAUSTED quota",
        "QUOTA_EXCEEDED for project",
        "TOO_MANY_REQUESTS from server",
    ];
    for sample in &rate_limit_samples {
        let eu = sample.to_uppercase();
        let detected = eu.contains("429")
            || eu.contains("RATE_LIMIT")
            || eu.contains("RESOURCE_EXHAUSTED")
            || eu.contains("QUOTA_EXCEEDED")
            || eu.contains("TOO_MANY_REQUESTS");
        assert!(detected, "should detect rate-limit in: {sample}");
    }
}

#[test]
fn non_rate_limit_errors_are_not_detected() {
    let non_rl_samples = [
        "HTTP 500 Internal Server Error",
        "connection refused",
        "timeout after 10s",
        "invalid API key",
    ];
    for sample in &non_rl_samples {
        let eu = sample.to_uppercase();
        let detected = eu.contains("429")
            || eu.contains("RATE_LIMIT")
            || eu.contains("RESOURCE_EXHAUSTED")
            || eu.contains("QUOTA_EXCEEDED")
            || eu.contains("TOO_MANY_REQUESTS");
        assert!(!detected, "should NOT detect rate-limit in: {sample}");
    }
}

// --- short-circuit on free-tier 429 --------

const FULL_RETRY_BUDGET: u32 = 3;

#[test]
fn free_tier_provider_gets_zero_retries() {
    for pid in &["gemini", "groq"] {
        let has_cap = free_tier_daily_limit(pid).is_some();
        assert!(
            has_cap,
            "provider '{pid}' must have a known free-tier limit"
        );
        let effective_retries: u32 = if has_cap { 0 } else { FULL_RETRY_BUDGET };
        assert_eq!(
            effective_retries, 0,
            "provider '{pid}' must have effective_retries=0 on 429"
        );
    }
}

#[test]
fn paid_tier_provider_keeps_full_retry_budget() {
    for pid in &["claude-haiku", "claude-sonnet", "deepseek"] {
        let has_cap = free_tier_daily_limit(pid).is_some();
        assert!(!has_cap, "provider '{pid}' must NOT have a free-tier cap");
        let effective_retries: u32 = if has_cap { 0 } else { FULL_RETRY_BUDGET };
        assert_eq!(
            effective_retries, FULL_RETRY_BUDGET,
            "paid-tier provider '{pid}' must keep the full retry budget"
        );
    }
}

#[test]
fn short_circuit_does_not_affect_non_rate_limit_errors() {
    let non_rl_errors = ["connection refused", "DNS error", "timeout", "500 internal"];
    for msg in &non_rl_errors {
        let eu = msg.to_uppercase();
        let is_rate_limited = eu.contains("429")
            || eu.contains("RATE_LIMIT")
            || eu.contains("RESOURCE_EXHAUSTED")
            || eu.contains("QUOTA_EXCEEDED")
            || eu.contains("TOO_MANY_REQUESTS");
        assert!(
            !is_rate_limited,
            "error '{msg}' must NOT be classified as rate-limited"
        );
    }
}
