// pty/tests.rs — Unit tests for PTY module.

use super::ops::should_notify_session_error;
use super::spawn::build_command;

// card-vis-notif-session-error
#[test]
fn notify_only_on_positive_exit_and_when_enabled() {
    assert!(
        should_notify_session_error(1, true),
        "code 1 + enabled -> notify"
    );
    assert!(should_notify_session_error(2, true));
    assert!(
        !should_notify_session_error(0, true),
        "clean exit -> no notify"
    );
    assert!(
        !should_notify_session_error(-1, true),
        "manual kill (-1) -> no notify"
    );
    assert!(
        !should_notify_session_error(1, false),
        "toggle off -> no notify"
    );
}

#[test]
fn build_command_rejects_unknown_provider() {
    let r = build_command("nope", None);
    assert!(r.is_err(), "unknown provider should fail");
}

#[test]
fn build_command_rejects_empty_provider() {
    let r = build_command("   ", None);
    assert!(r.is_err(), "empty provider should fail");
}

#[test]
fn build_command_accepts_known_providers() {
    // powershell/powershell-admin no hacen probe de PATH: siempre Ok.
    for p in ["powershell", "powershell-admin"] {
        let r = build_command(p, None);
        assert!(r.is_ok(), "provider {p} should be accepted");
    }
    // claude/codex hacen un probe REAL de PATH (where/which). En un runner
    // de CI sin las CLIs instaladas eso es Err legitimo — el test hermetico
    // acepta Ok o el error especifico de PATH, y rechaza cualquier otro
    // fallo (provider desconocido, probe roto, etc.).
    for p in ["claude", "codex"] {
        match build_command(p, None) {
            Ok(_) => {}
            Err(e) => assert!(
                e.contains("not found on PATH"),
                "provider {p}: unexpected error kind: {e}"
            ),
        }
    }
}

// `capture_output_inner` and its fixture tests were retired 2026-09-14
// alongside `agent_orchestration::delegate` (kanban "comandos huérfanos" —
// zero frontend callers). Recoverable from git history if the feature gets
// wired to a UI later.
