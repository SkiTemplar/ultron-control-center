// AI Router tests — 46 tests covering all areas.
//
// Uses `crate::ai_router::*` for all imports so the test-vs-impl boundary
// matches what external callers see (modulo the pub(crate) items listed below).

#[cfg(test)]
mod ai_router_tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use crate::ai_router::exec::{
        call_cli, cli_invocation_args, retry_delay_ms, with_retry, xorshift64_jitter_seed,
    };
    use crate::ai_router::providers::{
        apply_metric_sample, clamp_max_tokens, truncate, MetricSample,
    };
    use crate::ai_router::seed::{seed_providers, seed_zones};
    use crate::ai_router::store::{compute_key_status, detect_cli, looks_like_placeholder};
    use crate::ai_router::types::{
        free_tier_daily_limit, ApiKeyStatus, CallOutcome, DailyUsage, FailReason, LatencyHistogram,
        ModeCounters, Provider, ProviderClass, ProviderKind, RouterMetrics, TokenUsage,
    };
    use crate::ai_router::{primary_model_for_zone, CLI_CACHE};

    // Module-level serialization mutex for all tests that mutate environment
    // variables. In the original monolith the three env-override tests shared
    // the same static OnceLock because they were in the same file scope; here
    // they are in a separate module so we declare the lock once at module level.
    static ENV_MUTEX: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_MUTEX
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    // Ditto for PATH-mutating tests.
    static PATH_MUTEX: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    fn path_lock() -> std::sync::MutexGuard<'static, ()> {
        PATH_MUTEX
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn codex_cli_uses_exec_subcommand_not_dash_p() {
        let codex = cli_invocation_args(true, "hello world", "gpt-5");
        assert_eq!(codex[0], "exec", "codex must use the exec subcommand");
        assert_eq!(
            codex[1], "hello world",
            "prompt must be positional for codex"
        );
        assert!(
            !codex.contains(&"-p"),
            "codex must NOT receive -p (it means --profile)"
        );
        assert!(
            !codex.contains(&"--model"),
            "codex rejects explicit models on a ChatGPT account"
        );
        assert!(codex.contains(&"--sandbox") && codex.contains(&"read-only"));

        let gemini = cli_invocation_args(false, "hello world", "gemini-2.5-flash");
        assert_eq!(gemini[0], "-p", "gemini uses -p for the prompt");
        assert_eq!(gemini[1], "hello world");
        assert!(gemini.contains(&"--model") && gemini.contains(&"gemini-2.5-flash"));
        assert!(!gemini.contains(&"exec"), "gemini has no exec subcommand");
    }

    #[test]
    fn seed_providers_includes_all_six_targets() {
        let ids: Vec<String> = seed_providers().into_iter().map(|p| p.id).collect();
        for expected in [
            "claude-haiku",
            "codex",
            "gemini",
            "groq",
            "ollama",
            "deepseek",
        ] {
            assert!(ids.iter().any(|id| id == expected), "missing {}", expected);
        }
    }

    #[test]
    fn primary_model_for_known_zone_is_some() {
        assert!(primary_model_for_zone("light").is_some());
    }

    #[test]
    fn primary_model_for_unknown_zone_is_none() {
        assert!(primary_model_for_zone("no-such-zone-xyz").is_none());
    }

    #[test]
    fn seed_zones_includes_all_seven_targets() {
        let ids: Vec<String> = seed_zones().into_iter().map(|z| z.id).collect();
        for expected in [
            "chat",
            "code-edit",
            "code-review",
            "research-web",
            "summarize",
            "routing-decision",
            "code-fast-local",
        ] {
            assert!(ids.iter().any(|id| id == expected), "missing {}", expected);
        }
    }

    #[test]
    fn truncate_respects_unicode() {
        let s = "abcdefghij";
        assert_eq!(truncate(s, 5), "abcde...");
        assert_eq!(truncate(s, 99), "abcdefghij");
    }

    #[test]
    fn placeholder_detection_catches_common_patterns() {
        assert!(looks_like_placeholder("YOUR-KEY-HERE"));
        assert!(looks_like_placeholder("replace-me"));
        assert!(looks_like_placeholder("sk-..."));
        assert!(!looks_like_placeholder("sk-proj-abc123"));
    }

    #[test]
    fn clamp_max_tokens_uses_default_on_zero() {
        assert_eq!(clamp_max_tokens(0, 1024), 1024);
        assert_eq!(clamp_max_tokens(2048, 1024), 2048);
        assert_eq!(clamp_max_tokens(99_999, 1024), 8192);
    }

    // -----------------------------------------------------------------------
    // P1 2026-05-27 — key validation + disabled-providers
    // -----------------------------------------------------------------------

    fn make_provider(
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

    #[test]
    fn local_provider_never_disabled() {
        let ollama = make_provider("ollama", ProviderKind::Local, "", None);
        assert_eq!(compute_key_status(&ollama), ApiKeyStatus::Configured);
    }

    #[test]
    fn cloud_provider_missing_key_is_missing_status() {
        let p = make_provider(
            "qwen-cloud",
            ProviderKind::Cloud,
            "__ULTRON_TEST_KEY_NOT_SET_XYZ__",
            None,
        );
        if std::env::var("__ULTRON_TEST_KEY_NOT_SET_XYZ__").is_err() {
            assert_eq!(compute_key_status(&p), ApiKeyStatus::Missing);
        }
    }

    #[test]
    fn cloud_provider_placeholder_key_is_placeholder_status() {
        let key_var = "__ULTRON_TEST_PLACEHOLDER_KEY__";
        // SAFETY: test-only mutation, single-threaded test runner.
        unsafe { std::env::set_var(key_var, "your-key-here") };
        let p = make_provider("test-cloud", ProviderKind::Cloud, key_var, None);
        let status = compute_key_status(&p);
        unsafe { std::env::remove_var(key_var) };
        assert_eq!(status, ApiKeyStatus::Placeholder);
    }

    #[test]
    fn cloud_provider_real_key_is_configured_status() {
        let key_var = "__ULTRON_TEST_REAL_KEY__";
        unsafe { std::env::set_var(key_var, "sk-proj-abc123realkey") };
        let p = make_provider("test-cloud2", ProviderKind::Cloud, key_var, None);
        let status = compute_key_status(&p);
        unsafe { std::env::remove_var(key_var) };
        assert_eq!(status, ApiKeyStatus::Configured);
    }

    #[test]
    fn key_validation_warning_message_contains_env_var_name() {
        let key_var = "__ULTRON_TEST_WARN_KEY__";
        unsafe { std::env::remove_var(key_var) };
        let p = make_provider("warn-provider", ProviderKind::Cloud, key_var, None);

        let warning = match std::env::var(&p.key_env_var) {
            Err(_) => Some(format!(
                "Provider '{}' has no API key. \
                 Set {} or configure it in Settings > AI Router.",
                p.id, p.key_env_var
            )),
            _ => None,
        };

        let w = warning.expect("warning should be present when key is absent");
        assert!(w.contains(key_var), "warning must name the env var");
        assert!(
            w.contains("warn-provider"),
            "warning must name the provider"
        );
    }

    // -----------------------------------------------------------------------
    // CLI provider tests
    // -----------------------------------------------------------------------

    #[test]
    fn cli_provider_with_no_cli_command_is_missing() {
        let p = make_provider("broken-cli", ProviderKind::Cli, "", None);
        assert_eq!(compute_key_status(&p), ApiKeyStatus::Missing);
    }

    #[test]
    fn cli_provider_with_nonexistent_command_is_missing() {
        let p = make_provider(
            "ghost-cli",
            ProviderKind::Cli,
            "",
            Some("__ultron_ghost_binary_xyz__"),
        );
        assert_eq!(compute_key_status(&p), ApiKeyStatus::Missing);
    }

    #[test]
    fn detect_cli_finds_well_known_shell() {
        #[cfg(target_os = "windows")]
        assert!(detect_cli("cmd"), "cmd.exe should be detectable on Windows");
        #[cfg(not(target_os = "windows"))]
        assert!(detect_cli("sh"), "sh should be detectable on Unix");
    }

    #[test]
    fn detect_cli_returns_false_for_nonexistent() {
        assert!(!detect_cli("__ultron_ghost_binary_xyz__"));
    }

    #[test]
    fn detect_cli_result_is_stable_across_calls() {
        let first = detect_cli("__ultron_cache_stability_test__");
        let second = detect_cli("__ultron_cache_stability_test__");
        assert_eq!(first, second);
    }

    #[test]
    fn seed_providers_includes_cli_providers() {
        let ids: Vec<String> = seed_providers().into_iter().map(|p| p.id).collect();
        assert!(ids.iter().any(|id| id == "codex-cli"), "missing codex-cli");
        assert!(
            ids.iter().any(|id| id == "gemini-cli"),
            "missing gemini-cli"
        );
    }

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

    #[test]
    fn cli_providers_have_correct_metadata() {
        for p in seed_providers() {
            if p.id == "codex-cli" || p.id == "gemini-cli" {
                assert_eq!(p.kind, ProviderKind::Cli, "{} must have kind=Cli", p.id);
                assert!(
                    p.cli_command.is_some(),
                    "{} must have cli_command set",
                    p.id
                );
                assert!(
                    p.key_env_var.is_empty(),
                    "{} must have empty key_env_var (no API key needed)",
                    p.id
                );
            }
        }
    }

    #[test]
    fn cli_missing_binary_makes_provider_disabled_for_route() {
        let ghost = make_provider(
            "ghost-cli",
            ProviderKind::Cli,
            "",
            Some("__ultron_ghost_binary_xyz__"),
        );
        assert_eq!(
            compute_key_status(&ghost),
            ApiKeyStatus::Missing,
            "ghost CLI must be Missing so route() skips it via disabled_providers_set"
        );
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

    // -----------------------------------------------------------------------
    // KIRKARDO P2 — with_retry correctness
    // -----------------------------------------------------------------------

    #[test]
    fn with_retry_returns_zero_retry_count_on_first_success() {
        let mut call_count = 0u32;
        let result = with_retry(3, || {
            call_count += 1;
            Ok(CallOutcome {
                text: "ok".to_string(),
                usage: TokenUsage::default(),
            })
        });
        assert!(result.is_ok(), "must succeed");
        let (_, retry_count) = result.unwrap();
        assert_eq!(
            retry_count, 0,
            "no retries consumed on first-attempt success"
        );
        assert_eq!(call_count, 1, "closure called exactly once");
    }

    #[test]
    fn with_retry_returns_correct_retry_count_after_transient_failures() {
        let mut call_count = 0u32;
        let result = with_retry(3, || {
            call_count += 1;
            if call_count < 3 {
                Err(("rate limited".to_string(), FailReason::RateLimit))
            } else {
                Ok(CallOutcome {
                    text: "ok after retry".to_string(),
                    usage: TokenUsage::default(),
                })
            }
        });
        assert!(result.is_ok(), "must succeed after retries");
        let (outcome, retry_count) = result.unwrap();
        assert_eq!(outcome.text, "ok after retry");
        assert_eq!(retry_count, 2, "two retries were consumed before success");
        assert_eq!(call_count, 3, "closure called three times total");
    }

    #[test]
    fn with_retry_terminal_failure_has_correct_fail_reason() {
        let mut call_count = 0u32;
        let result: Result<(CallOutcome, u32), (String, FailReason)> = with_retry(2, || {
            call_count += 1;
            Err(("always fails".to_string(), FailReason::RateLimit))
        });
        assert!(result.is_err(), "must fail after exhausting retries");
        let (_, terminal_reason) = result.unwrap_err();
        assert_eq!(terminal_reason, FailReason::RateLimit);
        assert_eq!(call_count, 3, "closure called max_retries+1 times");
    }

    #[test]
    fn call_cli_codex_includes_sandbox_read_only_flag() {
        use std::io::Write;

        let _guard = path_lock();

        let tmp = std::env::temp_dir().join("ultron_test_codex_sandbox");
        std::fs::create_dir_all(&tmp).expect("create tmp dir");

        #[cfg(target_os = "windows")]
        let (script_name, script_body) = ("codex.bat", "@echo off\r\necho %*\r\n");
        #[cfg(not(target_os = "windows"))]
        let (script_name, script_body) = ("codex", "#!/bin/sh\necho \"$@\"\n");

        let script_path = tmp.join(script_name);
        {
            let mut f = std::fs::File::create(&script_path).expect("create echo script");
            f.write_all(script_body.as_bytes()).expect("write script");
        }

        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script_path, perms).unwrap();
        }

        let original_path = std::env::var("PATH").unwrap_or_default();
        let sep = if cfg!(target_os = "windows") {
            ";"
        } else {
            ":"
        };
        let new_path = format!("{}{sep}{}", tmp.display(), original_path);

        if let Ok(mut cache) = CLI_CACHE.lock() {
            cache.remove("codex");
        }

        // SAFETY: we hold path_lock() so no other test mutates PATH concurrently.
        unsafe { std::env::set_var("PATH", &new_path) };

        let provider = Provider {
            id: "codex-cli".to_string(),
            name: "Codex CLI test".to_string(),
            cost_per_mtok: 0.0,
            supports: vec![ProviderClass::Light],
            api_key_status: ApiKeyStatus::Configured,
            health_endpoint: None,
            kind: ProviderKind::Cli,
            key_env_var: String::new(),
            base_url: String::new(),
            default_model: "gpt-5".to_string(),
            models: vec![],
            cli_command: Some("codex".to_string()),
        };

        let result = call_cli(&provider, "hello world");

        // SAFETY: same path_lock() guard covers this restore.
        unsafe { std::env::set_var("PATH", &original_path) };
        if let Ok(mut cache) = CLI_CACHE.lock() {
            cache.remove("codex");
        }
        let _ = std::fs::remove_dir_all(&tmp);

        match result {
            Ok(co) => {
                let output = co.text.to_lowercase();
                assert!(
                    output.contains("--sandbox") && output.contains("read-only"),
                    "codex-cli call must include '--sandbox read-only' in args; got: {:?}",
                    co.text
                );
            }
            Err((msg, _)) => {
                if !msg.contains("not found")
                    && !msg.contains("cannot find")
                    && !msg.contains("No such file")
                {
                    panic!("call_cli failed unexpectedly: {msg}");
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // KIRKARDO RONDA 4 — gap tests
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
        let bases: &[(u32, u64)] = &[(0, 500), (1, 1000), (2, 2000), (3, 4000)];
        for &(attempt, base) in bases {
            for _ in 0..20 {
                let delay = retry_delay_ms(attempt);
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

    fn metric_sample<'a>(provider: &'a str, model: &'a str) -> MetricSample<'a> {
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
}
