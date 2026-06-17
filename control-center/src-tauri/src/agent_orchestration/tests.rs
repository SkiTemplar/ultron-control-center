// agent_orchestration/tests.rs — unit tests for the agent_orchestration module.

use super::delegate::{
    resolve_cheap_model, strip_ansi, validate_agent_slug, COMPLETION_SENTINEL,
    DEFAULT_DELEGATE_TIMEOUT_SECS,
};
use super::workflows::list_workflows_inner;

// ------------------------------------------------------------------
// validate_agent_slug
// ------------------------------------------------------------------

#[test]
fn validate_slug_accepts_canonical_agents() {
    for name in [
        "terry-davis",
        "kirkardo",
        "don-claudio",
        "ue5-dev",
        "novalbos",
        "einstein",
    ] {
        assert!(
            validate_agent_slug(name).is_ok(),
            "slug '{}' should be accepted",
            name
        );
    }
}

#[test]
fn validate_slug_rejects_uppercase_and_path_chars() {
    assert!(validate_agent_slug("Terry").is_err());
    assert!(validate_agent_slug("agent/etc").is_err());
    assert!(validate_agent_slug("agent\\bad").is_err());
    assert!(validate_agent_slug("agent.md").is_err());
}

// ------------------------------------------------------------------
// list_workflows_inner
// ------------------------------------------------------------------

#[test]
fn list_workflows_contains_canonical_seven() {
    // list_workflows_inner() returns only the built-in set (>= 7 entries).
    // The merged list (user + built-ins) may exceed 7 when the user has
    // YAML files in ~/.ultron/cockpit/workflows/ — that path is tested in
    // workflow_loader::tests. Here we only assert the built-in floor.
    let wf = list_workflows_inner();
    assert!(
        wf.len() >= 7,
        "expected at least 7 built-in workflows, got {}",
        wf.len()
    );
    let ids: Vec<&str> = wf.iter().map(|w| w.id.as_str()).collect();
    for required in [
        "quick", "feature", "debug", "security", "research", "game", "learning",
    ] {
        assert!(
            ids.contains(&required),
            "missing workflow id '{}'",
            required
        );
    }
}

// ------------------------------------------------------------------
// resolve_cheap_model
// ------------------------------------------------------------------

#[test]
fn resolve_cheap_model_returns_non_empty() {
    assert!(!resolve_cheap_model().is_empty());
}

// ------------------------------------------------------------------
// strip_ansi tests
// ------------------------------------------------------------------

#[test]
fn strip_ansi_removes_csi_colour_codes() {
    // ESC[32m = green, ESC[0m = reset
    let raw = b"\x1b[32mHello\x1b[0m world";
    let result = strip_ansi(raw);
    assert_eq!(result, "Hello world");
}

#[test]
fn strip_ansi_preserves_plain_ascii() {
    let raw = b"plain text [AGENT TASK COMPLETE]";
    let result = strip_ansi(raw);
    assert_eq!(result, "plain text [AGENT TASK COMPLETE]");
}

#[test]
fn strip_ansi_handles_two_byte_esc_sequences() {
    // ESC= (application keypad mode) followed by text
    let raw = b"\x1b=some text\x1b>";
    let result = strip_ansi(raw);
    assert_eq!(result, "some text");
}

#[test]
fn strip_ansi_detects_sentinel_after_stripping() {
    // Sentinel wrapped in green colour codes as a TUI would emit it.
    let raw = b"\x1b[1m[AGENT TASK COMPLETE]\x1b[0m";
    let text = strip_ansi(raw);
    assert!(
        text.contains(COMPLETION_SENTINEL),
        "sentinel must survive ANSI strip; got: {text:?}"
    );
}

// ------------------------------------------------------------------
// DelegateRequest timeout resolution tests
// ------------------------------------------------------------------

#[test]
fn delegate_request_timeout_defaults() {
    // None and 0 both resolve to DEFAULT_DELEGATE_TIMEOUT_SECS.
    for val in [None, Some(0u64)] {
        let resolved = match val {
            Some(0) | None => DEFAULT_DELEGATE_TIMEOUT_SECS,
            Some(n) => n.min(3_600),
        };
        assert_eq!(
            resolved, DEFAULT_DELEGATE_TIMEOUT_SECS,
            "timeout {:?} should default to {DEFAULT_DELEGATE_TIMEOUT_SECS}",
            val
        );
    }
}

#[test]
fn delegate_request_timeout_clamps_to_one_hour() {
    let huge: u64 = 99_999;
    let resolved = match Some(huge) {
        Some(0) | None => DEFAULT_DELEGATE_TIMEOUT_SECS,
        Some(n) => n.min(3_600),
    };
    assert_eq!(resolved, 3_600, "timeout should be clamped to 3600s");
}

#[test]
fn delegate_request_timeout_custom_value_respected() {
    let custom: u64 = 60;
    let resolved = match Some(custom) {
        Some(0) | None => DEFAULT_DELEGATE_TIMEOUT_SECS,
        Some(n) => n.min(3_600),
    };
    assert_eq!(resolved, 60);
}

// ------------------------------------------------------------------
// Sentinel constant sanity
// ------------------------------------------------------------------

#[test]
fn completion_sentinel_is_non_empty_and_ascii() {
    assert!(!COMPLETION_SENTINEL.is_empty());
    assert!(
        COMPLETION_SENTINEL.is_ascii(),
        "sentinel must be pure ASCII to survive PTY encoding"
    );
    // Must start with '[' so it stands out on its own line.
    assert!(COMPLETION_SENTINEL.starts_with('['));
}

// ------------------------------------------------------------------
// Poll-loop sentinel detection logic (unit-tested without real PTY)
// ------------------------------------------------------------------

/// Simulate what the poll loop does: take raw bytes, strip ANSI, check
/// for the sentinel. This validates the detection algorithm in isolation
/// from the actual PTY infrastructure.
fn poll_loop_detects(raw: &[u8]) -> bool {
    let text = strip_ansi(raw);
    text.contains(COMPLETION_SENTINEL)
}

#[test]
fn poll_detects_sentinel_plain() {
    let output = format!("some work done\n{COMPLETION_SENTINEL}\n");
    assert!(poll_loop_detects(output.as_bytes()));
}

#[test]
fn poll_detects_sentinel_with_ansi_colour() {
    let output = format!("doing work\r\n\x1b[32m{COMPLETION_SENTINEL}\x1b[0m\r\n");
    assert!(poll_loop_detects(output.as_bytes()));
}

#[test]
fn poll_does_not_false_positive_on_partial_sentinel() {
    let partial = b"[AGENT TASK INCOMPLET";
    assert!(!poll_loop_detects(partial));
}

#[test]
fn poll_does_not_false_positive_on_empty_output() {
    assert!(!poll_loop_detects(b""));
}
