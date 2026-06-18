use super::*;

// KIRKARDO 16 — format_iso via chrono

#[test]
fn format_iso_epoch() {
    assert_eq!(format_iso(0), "1970-01-01T00:00:00Z");
}

#[test]
fn format_iso_known_date() {
    // 2026-05-17 00:00:00 UTC
    assert_eq!(format_iso(1778976000), "2026-05-17T00:00:00Z");
}

#[test]
fn format_iso_leap_day() {
    // 2024-02-29 00:00:00 UTC
    assert_eq!(format_iso(1709164800), "2024-02-29T00:00:00Z");
}

#[test]
fn format_iso_with_time() {
    // 2026-05-17 13:45:30 UTC = 1778976000 + 49530
    assert_eq!(format_iso(1779025530), "2026-05-17T13:45:30Z");
}

// KIRKARDO 16 — fixture-based integration tests

fn fixture(name: &str) -> String {
    // Delegates to the shared helper (card-test-fixtures-rust-infra).
    crate::test_support::load_fixture("recall", name)
}

#[test]
fn fixture_simple_extracts_files_and_decisions() {
    let d = digest_jsonl(&fixture("session_simple.jsonl"));
    assert_eq!(d.message_count, 5);
    assert!(
        d.files.iter().any(|f| f.contains("oauth")),
        "expected oauth in files, got {:?}",
        d.files
    );
    assert!(!d.decisions.is_empty(), "expected a decision");
    assert!(d.last_user_message.is_some());
    assert!(d.last_assistant_message.is_some());
}

#[test]
fn fixture_malformed_tolerates_bad_lines() {
    let d = digest_jsonl(&fixture("session_malformed.jsonl"));
    assert!(d.message_count <= 4);
    assert!(
        d.last_assistant_message.is_some(),
        "valid assistant line must still parse"
    );
}

#[test]
fn fixture_decisions_extracts_multiple() {
    let d = digest_jsonl(&fixture("session_decisions.jsonl"));
    assert!(!d.decisions.is_empty());
    assert!(d.files.iter().any(|f| f.contains("webhook")));
}

fn make_jsonl() -> String {
    // Two user turns + one assistant turn with a tool_use Edit + a
    // decision-flavoured assistant message.
    let lines = [
        r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Necesito refactorizar el módulo de autenticación para que soporte OAuth"}]}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"C:/proj/src/auth/oauth.rs"}}]}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK, hecho. Decisión: usar el flujo PKCE para el cliente desktop."}]}}"#,
        r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Perfecto, ahora añade tests"}]}}"#,
    ];
    lines.join("\n")
}

#[test]
fn digest_extracts_topics_files_decisions() {
    let text = make_jsonl();
    let d = digest_jsonl(&text);
    assert_eq!(d.message_count, 4);
    assert!(!d.topics.is_empty(), "expected at least one topic");
    assert!(
        d.files.iter().any(|f| f.contains("oauth.rs")),
        "expected oauth.rs in files, got {:?}",
        d.files
    );
    assert!(
        !d.decisions.is_empty(),
        "expected a decision-style message, got {:?}",
        d.decisions
    );
    assert!(d.last_user_message.is_some());
    assert!(d.last_assistant_message.is_some());
}

#[test]
fn digest_ignores_malformed_lines() {
    let raw =
        "not json\n{\"type\":\"user\",\"message\":{\"content\":\"hola mundo de prueba largo\"}}";
    let d = digest_jsonl(raw);
    assert_eq!(d.message_count, 2);
    assert!(d.last_user_message.is_some());
}

#[test]
fn slug_for_matches_claude_convention() {
    assert_eq!(
        slug_for("C:\\Users\\user\\.ultron"),
        "C--Users-user--ultron"
    );
    assert_eq!(slug_for("/home/foo/bar"), "home-foo-bar");
}

#[test]
fn short_path_collapses_long_paths() {
    assert_eq!(short_path("C:/a/b/c/file.rs"), "…/c/file.rs");
    assert_eq!(short_path("a/b"), "a/b");
}

#[test]
fn render_summary_includes_topics_when_present() {
    let d = SessionDigest {
        topics: vec!["oauth".into(), "tokens".into()],
        message_count: 3,
        ..Default::default()
    };
    let md = render_summary_md(Some("C:/proj"), Some("2026-05-26T10:00:00Z"), &d);
    assert!(md.contains("oauth"));
    assert!(md.contains("C:/proj"));
    assert!(md.contains("2026-05-26"));
}

#[test]
fn suggested_prompt_uses_topic_when_available() {
    let d = SessionDigest {
        topics: vec!["refactor".into()],
        last_assistant_message: Some("Movimos el handler a auth.rs".into()),
        ..Default::default()
    };
    let p = render_suggested_prompt(Some("C:/proj"), &d);
    assert!(p.starts_with("Continuamos con refactor"));
    assert!(p.contains("auth.rs"));
}
