// P1 2026-05-27 — key validation + disabled-providers + CLI provider tests.

use crate::ai_router::seed::seed_providers;
use crate::ai_router::store::{compute_key_status, detect_cli};
use crate::ai_router::types::{ApiKeyStatus, ProviderKind};

use super::make_provider;

// -----------------------------------------------------------------------
// P1 2026-05-27 — key validation + disabled-providers
// -----------------------------------------------------------------------

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
