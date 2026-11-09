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

// ConPTY con PSEUDOCONSOLE_INHERIT_CURSOR no lanza el hijo hasta que alguien
// responde a ESC[6n; sin xterm enganchado lo responde el lector.
#[test]
fn cursor_query_se_detecta_y_sale_del_bufer() {
    use super::ops::take_cursor_query;
    let mut buf = b"\x1b[6n\x1b[?25l".to_vec();
    assert!(take_cursor_query(&mut buf, 0));
    assert_eq!(buf, b"\x1b[?25l".to_vec());
}

#[test]
fn cursor_query_partida_entre_lecturas() {
    use super::ops::take_cursor_query;
    let mut buf = b"hola\x1b[".to_vec();
    assert!(!take_cursor_query(&mut buf, 0), "secuencia incompleta");
    let before = buf.len();
    buf.extend_from_slice(b"6nresto");
    assert!(take_cursor_query(&mut buf, before));
    assert_eq!(buf, b"holaresto".to_vec());
}

#[test]
fn cursor_query_ya_respondida_no_se_repite() {
    use super::ops::take_cursor_query;
    let mut buf = b"\x1b[6n antiguo ".to_vec();
    let before = buf.len();
    buf.extend_from_slice(b"nuevo sin consulta");
    assert!(
        !take_cursor_query(&mut buf, before),
        "una consulta anterior al trozo nuevo no se vuelve a contestar"
    );
    let mut otro = b"texto [6n sin escape".to_vec();
    assert!(!take_cursor_query(&mut otro, 0), "sin ESC no es DSR");
}

#[test]
fn claude_del_pty_no_hereda_la_sesion_que_lanzo_la_app() {
    use super::spawn::inherited_session_vars;
    let keys = [
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_PID",
        "CLAUDE_CODE_PLUGIN_DIRS",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ULTRON_SESION_ID",
        "PATH",
    ];
    let mut out = inherited_session_vars(keys.iter().map(|k| k.to_string()));
    out.sort();
    assert_eq!(
        out,
        vec![
            "CLAUDECODE",
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_MESSAGING_SOCKET",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_PID",
        ]
    );
}

#[test]
fn ningun_hijo_del_pty_recibe_la_url_del_calendario() {
    use super::ops::{construir, SpawnOptions};
    use crate::mascot::calendar_fetch::{scrub_process_env, ENV_KEY};
    const CONTROL: &str = "ULTRON_TEST_PTY_HEREDA";
    std::env::set_var(ENV_KEY, "https://cal.example.invalid/SECRETO.ics");
    std::env::set_var(CONTROL, "1");
    let opts = SpawnOptions {
        project_id: "test".into(),
        card_id: None,
        provider: "powershell".into(),
        agent: None,
        cwd: ".".into(),
        cols: 80,
        rows: 24,
        extra_args: vec![],
        extra_env: vec![],
        env_excluir: vec![],
        live_event: None,
        on_exit: None,
        on_output: None,
        vista: None,
    };
    let (cmd, _) = construir(&opts).expect("construir powershell");
    // Caso negativo: el resto del entorno sí se hereda.
    assert_eq!(cmd.get_env(CONTROL).and_then(|v| v.to_str()), Some("1"));
    assert!(
        cmd.get_env(ENV_KEY).is_none(),
        "la URL privada llegó al hijo"
    );
    scrub_process_env();
    std::env::remove_var(CONTROL);
    assert!(std::env::var_os(ENV_KEY).is_none());
}
