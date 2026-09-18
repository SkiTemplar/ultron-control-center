// mar.ia — supervisor del sidecar de voz.
//
// Lanza `voice/maria_voice.py` como proceso hijo y habla con el por tuberias:
// una linea JSON por mensaje (mismo patron que el lector del PTY). Se eligio
// stdin/stdout y no un puerto porque el webview tiene un CSP estricto que
// bloquea `connect-src` a localhost, y porque un hijo con tuberias muere con su
// padre: no deja puertos ni procesos huerfanos si la app se cierra de golpe.
//
// Reparto de responsabilidades: el sidecar oye, transcribe y decide; la
// EJECUCION de cualquier herramienta se queda aqui, en la app, que es quien
// tiene los comandos, los permisos y el daemon. El sidecar nunca toca el
// sistema por su cuenta.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter, Runtime};

/// Proceso vivo + su stdin. Mutex y no canal: las ordenes son esporadicas
/// (una por pulsacion de tecla), no un flujo.
struct VoiceProc {
    child: Child,
    stdin: ChildStdin,
}

static VOICE: Lazy<Mutex<Option<VoiceProc>>> = Lazy::new(|| Mutex::new(None));

/// Raiz del fork (donde vive `voice/`). El repo de mar.ia no esta en
/// `~/.ultron` (ahi vive el ESTADO: memoria, hooks, skills), asi que la ruta
/// se resuelve por variable de entorno y, si falta, junto al ejecutable.
fn voice_script() -> Result<std::path::PathBuf, String> {
    if let Ok(dir) = std::env::var("MARIA_HOME") {
        let p = std::path::Path::new(&dir).join("voice").join("maria_voice.py");
        if p.exists() {
            return Ok(p);
        }
    }
    // Desarrollo: el ejecutable vive en <repo>/control-center/src-tauri/target/<perfil>/
    if let Ok(exe) = std::env::current_exe() {
        for up in [4usize, 5] {
            let mut base = exe.clone();
            for _ in 0..up {
                base.pop();
            }
            let p = base.join("voice").join("maria_voice.py");
            if p.exists() {
                return Ok(p);
            }
        }
    }
    Err("no encuentro voice/maria_voice.py (define MARIA_HOME con la raiz del repo)".into())
}

/// Interprete del entorno del sidecar. Su venv propio: faster-whisper arrastra
/// CTranslate2 y no tiene por que compartir entorno con los scripts del cockpit.
fn voice_python(script: &std::path::Path) -> std::path::PathBuf {
    let venv = script
        .parent()
        .map(|d| d.join(".venv").join("Scripts").join("python.exe"))
        .unwrap_or_default();
    if venv.exists() {
        venv
    } else {
        std::path::PathBuf::from("python")
    }
}

/// Reenvia al frontend lo que el sidecar escribe. Un evento por linea.
fn pump_events<R: Runtime>(app: AppHandle<R>, reader: BufReader<std::process::ChildStdout>) {
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            tracing::warn!(line = %trimmed, "linea del sidecar de voz ilegible");
            continue;
        };
        let kind = value.get("event").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            // El orbe solo entiende state/amp/text: se traduce aqui para no
            // atarlo al protocolo del sidecar.
            "state" => {
                let state = value.get("state").and_then(|v| v.as_str()).unwrap_or("idle");
                let _ = app.emit(
                    "maria:voice",
                    serde_json::json!({ "state": state }),
                );
            }
            "amp" => {
                let amp = value.get("amp").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
                let _ = app.emit("maria:voice", serde_json::json!({ "amp": amp }));
            }
            "transcript" | "reply" => {
                let text = value.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let _ = app.emit("maria:voice", serde_json::json!({ "text": text }));
            }
            // Las herramientas NO se ejecutan aqui todavia: se publican para
            // que la app decida. Prohibido el no-op silencioso, asi que queda
            // el rastro en el evento y en el log.
            "tool" => {
                let _ = app.emit("maria:tool", value.clone());
                tracing::info!(tool = %value, "el sidecar de voz pide una herramienta");
            }
            "error" => {
                let msg = value.get("message").and_then(|v| v.as_str()).unwrap_or("error");
                crate::toast_emit::record_alert_and_maybe_toast(&app, "maria_voice", "warn", msg);
            }
            "log" | "pong" => {
                tracing::debug!(payload = %value, "sidecar de voz");
            }
            _ => {}
        }
    }
    // stdout cerrado = el sidecar murio. Limpiamos para que el siguiente
    // `start` no crea que sigue vivo, y avisamos al orbe.
    let mut guard = VOICE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
    let _ = app.emit("maria:voice", serde_json::json!({ "state": "idle" }));
}

fn send_line(cmd: &str) -> Result<(), String> {
    let mut guard = VOICE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(proc) = guard.as_mut() else {
        return Err("el sidecar de voz no esta arrancado".into());
    };
    proc.stdin
        .write_all(format!("{cmd}\n").as_bytes())
        .and_then(|()| proc.stdin.flush())
        .map_err(|e| format!("no pude escribir al sidecar de voz: {e}"))
}

/// Arranca el sidecar si no lo esta. Idempotente.
#[tauri::command]
pub async fn maria_voice_start<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    // El candado se sostiene durante TODO el arranque, no solo para mirar: con
    // check-then-spawn, dos invocaciones seguidas (el orbe y un atajo, o dos
    // clics rapidos) pasaban las dos la comprobacion y acababan con dos
    // sidecares peleandose por el microfono.
    let mut guard = VOICE.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return Ok(false);
    }
    let script = voice_script()?;
    let python = voice_python(&script);

    let mut command = Command::new(&python);
    command
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("no pude lanzar el sidecar de voz ({}): {e}", python.display()))?;
    let stdin = child.stdin.take().ok_or("el hijo no expone stdin")?;
    let stdout = child.stdout.take().ok_or("el hijo no expone stdout")?;

    *guard = Some(VoiceProc { child, stdin });
    drop(guard);

    let app_for_pump = app.clone();
    std::thread::spawn(move || pump_events(app_for_pump, BufReader::new(stdout)));
    Ok(true)
}

/// Pide una escucha (atajo de teclado o boton del orbe).
#[tauri::command]
pub async fn maria_voice_listen() -> Result<(), String> {
    send_line(r#"{"cmd":"listen"}"#)
}

/// Aborta la escucha o la respuesta en curso.
#[tauri::command]
pub async fn maria_voice_cancel() -> Result<(), String> {
    send_line(r#"{"cmd":"cancel"}"#)
}

/// Para el sidecar y libera el microfono.
#[tauri::command]
pub async fn maria_voice_stop() -> Result<bool, String> {
    let mut guard = VOICE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(mut proc) = guard.take() else {
        return Ok(false);
    };
    // Cierre ordenado y, si no responde, a la fuerza: un microfono abierto no
    // se queda colgado porque el hijo ignore la orden.
    let _ = proc.stdin.write_all(b"{\"cmd\":\"shutdown\"}\n");
    let _ = proc.stdin.flush();
    std::thread::sleep(std::time::Duration::from_millis(400));
    let _ = proc.child.kill();
    let _ = proc.child.wait();
    Ok(true)
}

/// ¿Esta vivo el sidecar? Lo consulta el orbe para pintar su estado.
#[tauri::command]
pub async fn maria_voice_running() -> Result<bool, String> {
    let guard = VOICE.lock().unwrap_or_else(|e| e.into_inner());
    Ok(guard.is_some())
}

// ---------------------------------------------------------------------------
// Pulsar para hablar (push-to-talk)
// ---------------------------------------------------------------------------

/// Combinacion por defecto. Elegida por el usuario sabiendo que muchos IDE la
/// usan para el autocompletado: al ser un atajo GLOBAL, mientras mar.ia corra
/// se la queda ella. Por eso es configurable.
pub const DEFAULT_PTT: &str = "Ctrl+Space";

fn ptt_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron").join(".tmp").join("maria-ptt.txt"))
}

/// Combinacion de pulsar-para-hablar. Fichero de texto plano, igual que el
/// hotkey principal de ULTRON: editable sin arrancar la aplicacion.
pub fn ptt_spec() -> String {
    ptt_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_PTT.to_string())
}

/// Atiende la tecla de hablar. Devuelve true si el atajo era el suyo.
///
/// Pulsar graba; SOLTAR cierra la toma y transcribe (`stop`), que no es lo
/// mismo que cancelar: soltar la tecla no puede tirar lo que acabas de decir.
pub fn handle_ptt(
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
    pressed: bool,
) -> bool {
    let Ok(expected) = crate::hotkeys::parse_hotkey(&ptt_spec()) else {
        return false;
    };
    if *shortcut != expected {
        return false;
    }
    let cmd = if pressed {
        r#"{"cmd":"listen"}"#
    } else {
        r#"{"cmd":"stop"}"#
    };
    if let Err(e) = send_line(cmd) {
        // Sin sidecar arrancado no hay nada que escuchar: se deja rastro en
        // vez de tragarselo (mandamiento 11).
        tracing::warn!(error = %e, pressed, "pulsar-para-hablar sin sidecar");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_interprete_cae_a_python_si_no_hay_venv() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("maria_voice.py");
        std::fs::write(&script, "").expect("write");
        assert_eq!(voice_python(&script), std::path::PathBuf::from("python"));
    }

    #[test]
    fn el_interprete_prefiere_el_venv_del_sidecar() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("maria_voice.py");
        std::fs::write(&script, "").expect("write");
        let venv = dir.path().join(".venv").join("Scripts");
        std::fs::create_dir_all(&venv).expect("mkdir");
        let exe = venv.join("python.exe");
        std::fs::write(&exe, "").expect("write");
        assert_eq!(voice_python(&script), exe);
    }

    #[test]
    fn el_ptt_por_defecto_es_una_combinacion_valida() {
        // Si DEFAULT_PTT dejase de parsearse, el atajo no se registraria y
        // hablar con la tecla seria un no-op silencioso.
        assert!(crate::hotkeys::parse_hotkey(DEFAULT_PTT).is_ok());
    }

    #[test]
    fn el_ptt_ignora_otras_combinaciones() {
        // Caso negativo: el manejador global lo llama con TODOS los atajos;
        // si respondiese que si a cualquiera, se comeria el hotkey de abrir
        // la ventana.
        let otro = crate::hotkeys::parse_hotkey("Ctrl+Alt+U").expect("valida");
        assert!(!handle_ptt(&otro, true));
    }

    #[test]
    fn sin_sidecar_las_ordenes_fallan_con_mensaje_claro() {
        // Caso negativo: nada de silencio si el sidecar no esta arrancado.
        let err = send_line(r#"{"cmd":"listen"}"#).unwrap_err();
        assert!(err.contains("no esta arrancado"), "mensaje inesperado: {err}");
    }
}
