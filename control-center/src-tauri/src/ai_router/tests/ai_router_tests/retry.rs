// KIRKARDO P2 — with_retry correctness + call_cli sandbox flag test.

use crate::ai_router::exec::{call_cli, with_retry};
use crate::ai_router::types::{
    ApiKeyStatus, CallOutcome, FailReason, Provider, ProviderClass, ProviderKind, TokenUsage,
};
use crate::ai_router::CLI_CACHE;

use super::path_lock;

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
