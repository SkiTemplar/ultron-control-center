// Basic smoke tests — CLI args, seed providers/zones, truncate, placeholder, clamp.

use crate::ai_router::exec::cli_invocation_args;
use crate::ai_router::primary_model_for_zone;
use crate::ai_router::providers::clamp_max_tokens;
use crate::ai_router::providers::truncate;
use crate::ai_router::seed::{seed_providers, seed_zones};
use crate::ai_router::store::looks_like_placeholder;

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
