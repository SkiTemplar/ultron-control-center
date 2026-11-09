// hooks_admin/test_runner.rs — Ejecución del botón «Test» de un hook.
//
// Claude Code entrega el payload del evento por la entrada estándar del
// comando del hook, y así lo leen todos los hooks de ULTRON. Hasta el
// 2026-10-17 (H16) la prueba metía el comando del hook por la stdin de
// PowerShell (`-Command -`) y el payload en una variable de entorno que
// ningún hook lee: el hook recibía el resto del guion como «payload» y el
// resultado no probaba nada. Ahora el comando va como argumento del shell y
// el payload por la stdin, que el comando hereda igual que con Claude Code.
//
// No hay sandbox: el hook se ejecuta de verdad, con el usuario y el
// directorio de trabajo actuales, y sus efectos son reales. La interfaz lo
// dice así. `ULTRON_HOOK_TEST=1` se exporta para el hook que quiera
// distinguir una prueba, pero ningún hook está obligado a respetarlo.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::sesiones::cli_info::Trabajo;

use super::types::HookTestResult;
use super::validation::TEST_TIMEOUT;

/// Tope de lo que se conserva de cada canal (stdout/stderr).
const MAX_OUTPUT: usize = 16_000;

/// Espera extra para vaciar las tuberías tras la salida del shell: un nieto
/// que herede stdout la mantiene abierta y no se puede esperar sin fin.
const DRAIN_GRACE: Duration = Duration::from_millis(500);

/// Payload que recibe el hook. Debe ser JSON válido (Claude Code siempre
/// manda JSON); si es un objeto sin `hook_event_name`, se añade el evento del
/// hook, porque muchos hooks deciden por ese campo.
pub(crate) fn build_test_payload(event: &str, mock: Option<&str>) -> Result<String, String> {
    let raw = mock
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(r#"{"tool_name":"Bash","tool_input":{"command":"echo hello"}}"#);
    let mut value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| format!("el payload de prueba no es JSON válido: {e}"))?;
    if let Some(obj) = value.as_object_mut() {
        obj.entry("hook_event_name".to_string())
            .or_insert_with(|| serde_json::Value::String(event.to_string()));
    }
    serde_json::to_string(&value).map_err(|e| format!("serializar el payload: {e}"))
}

/// Shell con el comando del hook como argumento (no por stdin, que queda
/// libre para el payload).
fn shell_for(command: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = Command::new("powershell.exe");
        // Salto de línea antes de `exit`: un comando que acabe en comentario
        // no se traga la orden de salida.
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!("{command}\nexit $LASTEXITCODE"),
        ])
        .creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("bash");
        c.args(["-c", command]);
        c
    }
}

/// Lee un canal del hijo en otro hilo. El búfer compartido conserva lo leído
/// aunque el hilo no llegue a EOF (un nieto con la tubería abierta).
fn reader<R: Read + Send + 'static>(src: Option<R>) -> (Arc<Mutex<Vec<u8>>>, mpsc::Receiver<()>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel();
    let sink = Arc::clone(&buf);
    std::thread::spawn(move || {
        if let Some(mut r) = src {
            let mut chunk = [0u8; 8192];
            loop {
                match r.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut b) = sink.lock() {
                            // Se sigue leyendo para no bloquear al hijo, pero
                            // no se acumula más allá del tope.
                            let room = (MAX_OUTPUT + 1).saturating_sub(b.len());
                            b.extend_from_slice(&chunk[..n.min(room)]);
                        }
                    }
                }
            }
        }
        let _ = tx.send(());
    });
    (buf, rx)
}

fn collect(buf: &Arc<Mutex<Vec<u8>>>, rx: &mpsc::Receiver<()>) -> String {
    let _ = rx.recv_timeout(DRAIN_GRACE);
    let bytes = buf.lock().map(|b| b.clone()).unwrap_or_default();
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if text.len() > MAX_OUTPUT {
        let mut cut = MAX_OUTPUT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n[...output truncated at 16KB]");
    }
    text
}

/// Mata el shell y su árbol (el hook suele ser un nieto: `node` bajo
/// PowerShell). `Child::kill` solo mataría el shell. El árbol es el Job
/// Object del hijo: `taskkill /T` lo reconstruía por PID padre y podía
/// llevarse un huérfano ajeno cuyo padre muerto tuviera el PID reutilizado.
fn kill_tree(child: &mut std::process::Child, job: Option<&Trabajo>) {
    if let Some(job) = job {
        if let Err(e) = job.terminar() {
            tracing::warn!(error = %e, "no se pudo terminar el job del hook");
        }
    }
    if let Err(e) = child.kill() {
        tracing::debug!(error = %e, "kill del shell del hook tras el tope");
    }
}

/// Ejecuta `command` con `payload` por stdin y un tope de `timeout`.
pub(crate) fn run_hook_command(
    command: &str,
    payload: &str,
    timeout: Duration,
) -> Result<HookTestResult, String> {
    let start = Instant::now();
    let mut child = shell_for(command)
        .env("ULTRON_HOOK_TEST", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn test shell: {}", e))?;
    let job = Trabajo::solo_al_cortar(&child)
        .inspect_err(
            |e| tracing::warn!(error = %e, "hook sin Job Object: el tope solo mata el shell"),
        )
        .ok();

    // La escritura va en otro hilo: un hook que no lee stdin no debe
    // bloquear la prueba si el payload supera el búfer de la tubería. Al
    // terminar se suelta la stdin y el hook ve EOF.
    if let Some(mut stdin) = child.stdin.take() {
        let body = payload.as_bytes().to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&body);
        });
    }
    let (out_buf, out_rx) = reader(child.stdout.take());
    let (err_buf, err_rx) = reader(child.stderr.take());

    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    timed_out = true;
                    kill_tree(&mut child, job.as_ref());
                    break child.wait().map_err(|e| format!("reap: {}", e))?;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("try_wait: {}", e)),
        }
    };
    let elapsed = start.elapsed();

    Ok(HookTestResult {
        success: status.success() && !timed_out,
        exit_code: status.code(),
        stdout: collect(&out_buf, &out_rx),
        stderr: collect(&err_buf, &err_rx),
        elapsed_ms: elapsed.as_millis(),
        timed_out,
    })
}

/// Atajo con el tope estándar de la pestaña.
pub(crate) fn run_hook_test(command: &str, payload: &str) -> Result<HookTestResult, String> {
    run_hook_command(command, payload, TEST_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_gets_event_name_when_missing() {
        let p = build_test_payload("PreToolUse", Some(r#"{"tool_name":"Bash"}"#)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&p).unwrap();
        assert_eq!(v["hook_event_name"], "PreToolUse");
        assert_eq!(v["tool_name"], "Bash");
    }

    #[test]
    fn payload_keeps_explicit_event_name() {
        let p = build_test_payload("PreToolUse", Some(r#"{"hook_event_name":"Stop"}"#)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&p).unwrap();
        assert_eq!(v["hook_event_name"], "Stop");
    }

    #[test]
    fn payload_invalid_json_is_rejected() {
        assert!(build_test_payload("PreToolUse", Some("{no es json")).is_err());
    }

    #[test]
    fn payload_empty_uses_default() {
        let p = build_test_payload("PostToolUse", Some("   ")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&p).unwrap();
        assert_eq!(v["tool_name"], "Bash");
        assert_eq!(v["hook_event_name"], "PostToolUse");
    }

    /// H16: el hook lee el payload por stdin, como con Claude Code. Con el
    /// arreglo anterior (`-Command -` y payload en una variable de entorno)
    /// `node` leía el resto del guion de PowerShell y no veía `tool_name`.
    #[test]
    fn hook_receives_payload_on_stdin() {
        let cmd = r#"node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write('TOOL='+j.tool_name+' EV='+j.hook_event_name)})""#;
        let payload = build_test_payload("PreToolUse", Some(r#"{"tool_name":"Edit"}"#)).unwrap();
        let res = run_hook_command(cmd, &payload, Duration::from_secs(20)).expect("run");
        assert!(res.success, "stderr: {}", res.stderr);
        assert!(
            res.stdout.contains("TOOL=Edit EV=PreToolUse"),
            "stdout: {}",
            res.stdout
        );
        assert!(!res.timed_out);
    }

    /// Caso negativo: el código de salida del hook llega tal cual (un hook
    /// que bloquea con exit 2 no debe pintarse como OK).
    #[test]
    fn hook_exit_code_is_propagated() {
        let res = run_hook_command(
            r#"node -e "process.exit(2)""#,
            "{}",
            Duration::from_secs(20),
        )
        .expect("run");
        assert!(!res.success);
        assert_eq!(res.exit_code, Some(2));
    }

    #[test]
    fn hook_that_hangs_times_out() {
        let res = run_hook_command(
            r#"node -e "setTimeout(()=>{},60000)""#,
            "{}",
            Duration::from_secs(2),
        )
        .expect("run");
        assert!(res.timed_out);
        assert!(!res.success);
    }
}
