// pty/tests.rs — Unit tests for PTY module.

use base64::Engine;

use super::ops::{capture_output_inner, list_one_inner, should_notify_session_error};
use super::registry::registry;
use super::spawn::build_command;
use super::types::{PtySession, PtyStatus};

// card-vis-cli-model-indicator
#[test]
fn list_one_inner_unknown_id_is_none() {
    assert!(list_one_inner("does-not-exist-xyz").is_none());
}

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
    // claude/codex/gemini hacen un probe REAL de PATH (where/which). En un
    // runner de CI sin las CLIs instaladas eso es Err legitimo — el test
    // hermetico acepta Ok o el error especifico de PATH, y rechaza
    // cualquier otro fallo (provider desconocido, probe roto, etc.).
    for p in ["claude", "codex", "gemini"] {
        match build_command(p, None) {
            Ok(_) => {}
            Err(e) => assert!(
                e.contains("not found on PATH"),
                "provider {p}: unexpected error kind: {e}"
            ),
        }
    }
}

// ------------------------------------------------------------------
// capture_output_inner tests (operate on the global registry directly)
// ------------------------------------------------------------------

/// Inject a fake PtySession into the registry with pre-populated
/// output_buffer so we can test capture_output_inner without a real PTY.
///
/// Returns the session id that was inserted.
fn insert_fake_session(payload: &[u8]) -> String {
    use portable_pty::{native_pty_system, PtySize};

    // We need real portable-pty objects for the struct fields. Spawn a
    // minimal PTY just long enough to extract the handles, then discard
    // the child process immediately. This keeps the test hermetic — no
    // shell output leaks into our buffer.
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 10,
            cols: 40,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty for test");

    let cmd = portable_pty::CommandBuilder::new_default_prog();
    let child = pair
        .slave
        .spawn_command(cmd)
        .expect("spawn default prog for test");
    drop(pair.slave);

    let master = pair.master;
    let writer = master.take_writer().expect("take_writer for test");

    let id = format!("test-session-{}", payload.len());
    let session = PtySession {
        id: id.clone(),
        project_id: "test-project".to_string(),
        card_id: None,
        provider: "test".to_string(),
        started_at: "epoch:0".to_string(),
        status: PtyStatus::Running,
        master,
        writer,
        child,
        output_buffer: payload.to_vec(),
        subscribed: false,
    };

    let mut reg = registry().lock().expect("registry lock");
    reg.insert(id.clone(), session);
    id
}

#[test]
fn capture_output_since_zero_returns_full_buffer() {
    let payload = b"hello world sentinel";
    let id = insert_fake_session(payload);

    let result = capture_output_inner(&id, 0).expect("capture_output_inner");
    assert_eq!(result.new_offset, payload.len());

    let engine = base64::engine::general_purpose::STANDARD;
    let decoded = engine.decode(&result.data_b64).expect("base64 decode");
    assert_eq!(decoded, payload);
}

#[test]
fn capture_output_since_offset_returns_tail() {
    let payload = b"AAABBBCCC";
    let id = insert_fake_session(payload);

    // Offset 3 → should return b"BBBCCC"
    let result = capture_output_inner(&id, 3).expect("capture_output_inner with offset");
    assert_eq!(result.new_offset, payload.len());

    let engine = base64::engine::general_purpose::STANDARD;
    let decoded = engine.decode(&result.data_b64).expect("base64 decode");
    assert_eq!(decoded, b"BBBCCC");
}

#[test]
fn capture_output_unknown_session_returns_empty() {
    let result = capture_output_inner("nonexistent-session-xyz", 0).expect("should not error");
    assert!(
        result.data_b64.is_empty(),
        "unknown session should return empty data"
    );
    assert!(result.session_status.is_none());
}

#[test]
fn capture_output_offset_past_end_returns_empty_data() {
    let payload = b"short";
    let id = insert_fake_session(payload);

    // Offset beyond buffer length → no new bytes, new_offset == buf.len()
    let result = capture_output_inner(&id, 9999).expect("capture_output_inner past end");
    assert!(result.data_b64.is_empty());
    assert_eq!(result.new_offset, payload.len());
}
