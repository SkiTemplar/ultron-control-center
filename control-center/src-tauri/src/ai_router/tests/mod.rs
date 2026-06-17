// AI Router tests — 46 tests covering all areas.
//
// Uses `crate::ai_router::*` for all imports so the test-vs-impl boundary
// matches what external callers see (modulo the pub(crate) items listed below).
//
// Sub-module layout:
//   basics.rs        — CLI args, seed providers/zones, truncate, placeholder, clamp
//   key_validation.rs — P1 key validation + CLI provider tests
//   quota.rs         — Quota-awareness + 429 handling
//   retry.rs         — KIRKARDO P2: with_retry correctness + call_cli sandbox flag
//   metrics.rs       — R4 gaps, LatencyHistogram p50/p95, apply_metric_sample

#[cfg(test)]
mod ai_router_tests {
    use std::sync::Mutex;

    use crate::ai_router::providers::MetricSample;
    use crate::ai_router::types::{ApiKeyStatus, Provider, ProviderClass, ProviderKind};

    // -----------------------------------------------------------------------
    // Shared infrastructure — serialization mutexes for env/PATH mutations
    // -----------------------------------------------------------------------

    // Module-level serialization mutex for all tests that mutate environment
    // variables. In the original monolith the three env-override tests shared
    // the same static OnceLock because they were in the same file scope; here
    // they are in a separate module so we declare the lock once at module level.
    static ENV_MUTEX: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    pub(super) fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_MUTEX
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    // Ditto for PATH-mutating tests.
    static PATH_MUTEX: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    pub(super) fn path_lock() -> std::sync::MutexGuard<'static, ()> {
        PATH_MUTEX
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    // -----------------------------------------------------------------------
    // Shared helper — constructs a minimal Provider for key-status tests
    // -----------------------------------------------------------------------

    pub(super) fn make_provider(
        id: &str,
        kind: ProviderKind,
        key_env_var: &str,
        cli_command: Option<&str>,
    ) -> Provider {
        Provider {
            id: id.into(),
            name: format!("Test {id}"),
            cost_per_mtok: 0.0,
            supports: vec![ProviderClass::Light],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: None,
            kind,
            key_env_var: key_env_var.into(),
            base_url: "https://example.com".into(),
            default_model: "test-model".into(),
            models: vec![],
            cli_command: cli_command.map(String::from),
        }
    }

    // -----------------------------------------------------------------------
    // Shared helper — constructs a MetricSample for metrics tests
    // -----------------------------------------------------------------------

    pub(super) fn metric_sample<'a>(provider: &'a str, model: &'a str) -> MetricSample<'a> {
        MetricSample {
            provider_id: provider,
            model,
            success: true,
            output_tokens: 100,
            cost_per_mtok: 0.0,
            primary_cost_per_mtok: 0.0,
            latency_ms: 50,
            mode: None,
            retry_count: 0,
            fail_reason: None,
            error: None,
        }
    }

    // -----------------------------------------------------------------------
    // Sub-modules — each holds a domain group of tests
    // -----------------------------------------------------------------------

    mod basics;
    mod key_validation;
    mod metrics;
    mod quota;
    mod retry;
}
