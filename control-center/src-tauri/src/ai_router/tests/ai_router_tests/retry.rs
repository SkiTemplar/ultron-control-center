// KIRKARDO P2 — with_retry correctness + call_cli sandbox flag test.

use crate::ai_router::exec::{call_cli, with_retry};
use crate::ai_router::seed::{seed_providers, seed_zones};
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

    // .cmd, not .bat: resolve_windows_cli_program() probes .cmd first (it is
    // the extension npm actually ships), so the stub must match or the real
    // installed codex.cmd elsewhere on PATH would win the resolution instead.
    #[cfg(target_os = "windows")]
    let (script_name, script_body) = ("codex.cmd", "@echo off\r\necho %*\r\n");
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
        default_model: "gpt-5.6-terra".to_string(),
        models: vec![],
        cli_command: Some("codex".to_string()),
    };

    // Pass the model explicitly (as try_assignment_call does with the
    // ZoneAssignment's model) — call_cli must forward it via --model, not
    // silently ignore it in favour of provider.default_model.
    let result = call_cli(&provider, "hello world", "gpt-5.6-sol");

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
            assert!(
                output.contains("--model") && output.contains("gpt-5.6-sol"),
                "codex-cli call must forward the caller's model via --model, \
                 not provider.default_model; got: {:?}",
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
// KIRKARDO HIGH — a multi-word/punctuated prompt must survive call_cli
// byte-for-byte. REPRO: before the 2026-09-11 fix, call_cli built ONE
// `cmd /C <string>` shell line on Windows and neutered `&|<>^%()!"` with
// `_` before embedding the prompt in it (sanitize_for_cmd) — this test's
// prompt (spaces, colon, both quote kinds, &, |, ^, %, newline, accents)
// would come back mangled. Fixed by spawning codex.cmd DIRECTLY (no shell)
// and piping the prompt through stdin (`codex exec -`), which this test
// verifies via a stub script that echoes stdin back unmodified.
// -----------------------------------------------------------------------

#[test]
fn call_cli_codex_preserves_a_prompt_with_shell_metacharacters_via_stdin() {
    use std::io::Write;

    let _guard = path_lock();

    let tmp = std::env::temp_dir().join("ultron_test_codex_stdin_roundtrip");
    std::fs::create_dir_all(&tmp).expect("create tmp dir");

    // Echoes argv (so we can still see --sandbox/--model) AND stdin verbatim
    // between markers. `findstr "^"` is the standard cmd.exe "cat" trick —
    // verified empirically (2026-09-11) to pass through `&|<>^%"'`, newlines
    // and UTF-8 accents byte-for-byte, unlike piping through `more`.
    #[cfg(target_os = "windows")]
    let (script_name, script_body) = (
        "codex.cmd",
        "@echo off\r\necho ARGV:%*\r\necho STDIN_START\r\nfindstr \"^\"\r\necho STDIN_END\r\n",
    );
    #[cfg(not(target_os = "windows"))]
    let (script_name, script_body) = (
        "codex",
        "#!/bin/sh\necho \"ARGV:$@\"\necho STDIN_START\ncat\necho STDIN_END\n",
    );

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
        default_model: "gpt-5.6-terra".to_string(),
        models: vec![],
        cli_command: Some("codex".to_string()),
    };

    let dangerous_prompt = "Responde solo con la palabra OK: \"comillas dobles\" y 'simples', \
        & un ampersand | una tuberia ^ un caret % variables%, tildes: niño, mañana, año\n\
        segunda línea tras un salto de línea real";

    let result = call_cli(&provider, dangerous_prompt, "gpt-5.6-terra");

    // SAFETY: same path_lock() guard covers this restore.
    unsafe { std::env::set_var("PATH", &original_path) };
    if let Ok(mut cache) = CLI_CACHE.lock() {
        cache.remove("codex");
    }
    let _ = std::fs::remove_dir_all(&tmp);

    match result {
        Ok(co) => {
            let start = co
                .text
                .find("STDIN_START")
                .expect("stub must echo the STDIN_START marker");
            let end = co
                .text
                .find("STDIN_END")
                .expect("stub must echo the STDIN_END marker");
            let echoed_stdin =
                co.text[start + "STDIN_START".len()..end].trim_matches(|c| c == '\r' || c == '\n');
            assert_eq!(
                echoed_stdin, dangerous_prompt,
                "the prompt must reach the CLI via stdin byte-for-byte, \
                 with no shell metacharacter mangling; got: {:?}",
                echoed_stdin
            );
            assert!(
                co.text.contains("--sandbox") && co.text.contains("read-only"),
                "must still include --sandbox read-only in argv; got: {:?}",
                co.text
            );
            assert!(
                co.text.contains("--model") && co.text.contains("gpt-5.6-terra"),
                "must still forward --model in argv; got: {:?}",
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
// Real end-to-end call — REQUIRES the `codex` CLI logged into the ChatGPT
// subscription. Not run by default (`cargo test`); invoke explicitly with
// `cargo test --lib ai_router:: -- --ignored real_codex_cli_call_uses_the_code_edit_zone_model`.
// -----------------------------------------------------------------------

#[test]
#[ignore]
fn real_codex_cli_call_uses_the_code_edit_zone_model() {
    // Exercises the actual router wiring end to end: seed_zones() ->
    // code-edit's codex-cli fallback assignment -> call_cli -> a real
    // `codex exec -m gpt-5.6-terra` process. Verifies the 2026-09-11 wiring
    // fix (ZoneAssignment.model now reaches the CLI) against the live
    // binary, not just the pure arg-builder unit tests above.
    let zone = seed_zones()
        .into_iter()
        .find(|z| z.id == "code-edit")
        .expect("code-edit zone must exist in the seed");
    let assignment = zone
        .fallbacks
        .iter()
        .find(|f| f.provider_id == "codex-cli")
        .expect("code-edit must carry a codex-cli fallback")
        .clone();
    assert_eq!(
        assignment.model, "gpt-5.6-terra",
        "code-edit's codex-cli fallback must be terra (basic-tier subscription model)"
    );

    let provider = seed_providers()
        .into_iter()
        .find(|p| p.id == "codex-cli")
        .expect("codex-cli must exist in the seed");

    // Multi-word prompt WITH a shell metacharacter (&) — this used to break
    // on Windows via the old `cmd /C` shell-string wrapper (mis-split argv);
    // fixed 2026-09-11 by spawning codex.cmd directly and piping the prompt
    // through stdin (`codex exec -`). Proves both fixes end to end against
    // the live binary: -m wiring AND metacharacter-safe prompt delivery.
    let prompt = "Responde solo con la palabra OK: sin comillas & sin nada más";
    let result = call_cli(&provider, prompt, &assignment.model);
    match result {
        Ok(co) => {
            assert!(
                co.text.to_uppercase().contains("OK"),
                "real codex exec call must answer OK; got: {:?}",
                co.text
            );
        }
        Err((msg, _)) => panic!("real codex-cli call failed: {msg}"),
    }
}
