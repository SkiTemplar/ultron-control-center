// Mascota — confirmaciones en el bocadillo.
//
// El chat de Pupus lanza `claude -p` con `--permission-prompt-tool` apuntando
// a `approve_tool_use` del MCP de escritorio. Ese MCP deja pasar lo seguro y,
// para lo destructivo (borrar, git push, registro, matar procesos…), llama a
// POST /v1/approve del puente. Aquí se pregunta al usuario en el bocadillo de
// la mascota y se espera su clic (o se deniega al agotar el plazo).
//
// Los permisos de Claude Code en terminal (permission.rs) usan la misma
// tarjeta con `ask_until`: plazo propio, origen visible y cancelación cuando
// el hook se corta (el usuario contestó en la terminal).

use std::collections::HashMap;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const WAIT: Duration = Duration::from_secs(120);
/// Cada cuánto se mira si quien pregunta sigue esperando.
const CANCEL_POLL: Duration = Duration::from_millis(300);

/// Resultado de una confirmación.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Allow,
    Deny,
    /// No se pudo preguntar; lleva el motivo.
    CannotAsk(String),
    /// Nadie contestó dentro del plazo.
    Expired,
    /// Quien preguntaba dejó de esperar.
    Cancelled,
}

static PENDING: Lazy<Mutex<HashMap<String, Sender<bool>>>> = Lazy::new(Default::default);

fn pending() -> std::sync::MutexGuard<'static, HashMap<String, Sender<bool>>> {
    PENDING.lock().unwrap_or_else(|p| p.into_inner())
}

fn deny(message: &str) -> Value {
    json!({"ok": true, "allow": false, "message": message})
}

/// Motivo para denegar sin preguntar: sin ventana, o con Pupus escondido
/// (llamada, pantalla completa o a mano) o en silencio de juego, donde el
/// bocadillo no se ve y la pregunta caducaría a los 2 minutos. Pura.
pub fn cannot_ask(has_window: bool, hidden: Option<&str>, quiet: bool) -> Option<&'static str> {
    if !has_window {
        return Some("Pupus no está en pantalla para pedir confirmación.");
    }
    match hidden {
        Some("manual") => Some("Pupus está oculto a mano; muéstralo y repite."),
        Some("call") => Some("Pupus está escondido por una llamada; repite cuando termine."),
        Some(_) => Some("Pupus está oculto por una pantalla completa; repite cuando salgas."),
        None if quiet => Some("Pupus está en silencio por un juego; repite cuando termine."),
        None => None,
    }
}

/// Pregunta en el bocadillo y bloquea hasta la respuesta o el plazo.
pub fn ask(app: &AppHandle, v: &Value) -> Value {
    match ask_until(app, v, WAIT, &|| false) {
        Answer::Allow => json!({"ok": true, "allow": true}),
        Answer::Deny => deny("El usuario no lo ha permitido."),
        Answer::CannotAsk(reason) => deny(&reason),
        Answer::Expired | Answer::Cancelled => deny("Nadie contestó en 2 minutos; no se ejecuta."),
    }
}

/// Tarjeta del bocadillo: `tool`, `reason`, `summary` y, opcionales,
/// `origin` (quién pide), `context` (lo último que dijo Claude) y `source`.
fn card(id: &str, v: &Value) -> Value {
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    json!({
        "id": id,
        "tool": text("tool"),
        "reason": text("reason"),
        "summary": text("summary"),
        "origin": text("origin"),
        "context": text("context"),
        "source": v.get("source").and_then(Value::as_str).unwrap_or("pupus"),
    })
}

/// Pregunta en el bocadillo y espera la respuesta, el plazo `wait` o a que
/// `cancelled()` diga que quien pregunta ya no espera (se mira cada 300 ms).
/// Al caducar o cancelarse, la tarjeta se retira del bocadillo.
pub fn ask_until(
    app: &AppHandle,
    v: &Value,
    wait: Duration,
    cancelled: &dyn Fn() -> bool,
) -> Answer {
    let quiet = super::desk_watch::current().is_some_and(|s| s.quiet);
    let has_window = app.get_webview_window(super::LABEL).is_some();
    if let Some(reason) = cannot_ask(has_window, super::screens::hidden_reason(), quiet) {
        return Answer::CannotAsk(reason.to_string());
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = channel();
    pending().insert(id.clone(), tx);
    if let Err(e) = app.emit_to(super::LABEL, "mascot:approve", card(&id, v)) {
        pending().remove(&id);
        return Answer::CannotAsk(format!("No se pudo preguntar al usuario: {e}"));
    }
    let deadline = Instant::now() + wait;
    let answer = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break Answer::Expired;
        }
        match rx.recv_timeout(left.min(CANCEL_POLL)) {
            Ok(true) => break Answer::Allow,
            Ok(false) => break Answer::Deny,
            Err(RecvTimeoutError::Disconnected) => break Answer::Expired,
            Err(RecvTimeoutError::Timeout) if cancelled() => break Answer::Cancelled,
            Err(RecvTimeoutError::Timeout) => {}
        }
    };
    pending().remove(&id);
    if matches!(answer, Answer::Expired | Answer::Cancelled) {
        let _ = app.emit_to(super::LABEL, "mascot:approve-expired", json!({"id": id}));
    }
    answer
}

/// Respuesta del usuario desde el bocadillo.
#[tauri::command]
pub fn mascot_approve_answer(id: String, allow: bool) -> Result<(), String> {
    let tx = pending()
        .remove(&id)
        .ok_or_else(|| "esa confirmación ya no está pendiente".to_string())?;
    tx.send(allow)
        .map_err(|_| "la acción ya había terminado".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responder_desbloquea_a_quien_espera() {
        let (tx, rx) = channel();
        pending().insert("abc".into(), tx);
        mascot_approve_answer("abc".into(), true).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_millis(100)), Ok(true));
    }

    #[test]
    fn escondido_o_en_silencio_de_juego_se_deniega_al_momento() {
        assert!(
            cannot_ask(true, None, false).is_none(),
            "visible: se pregunta"
        );
        // Casos negativos: cada motivo de ocultación da su propio mensaje.
        let call = cannot_ask(true, Some("call"), false).unwrap();
        assert!(call.contains("llamada"), "{call}");
        let manual = cannot_ask(true, Some("manual"), false).unwrap();
        assert!(
            manual.contains("a mano") && !manual.contains("llamada"),
            "{manual}"
        );
        let full = cannot_ask(true, Some("fullscreen"), false).unwrap();
        assert!(full.contains("pantalla completa"), "{full}");
        let quiet = cannot_ask(true, None, true).unwrap();
        assert!(
            quiet.contains("juego") && !quiet.contains("llamada"),
            "{quiet}"
        );
        assert!(cannot_ask(false, None, false)
            .unwrap()
            .contains("no está en pantalla"));
    }

    #[test]
    fn responder_dos_veces_o_a_un_id_falso_es_error() {
        let (tx, _rx) = channel();
        pending().insert("xyz".into(), tx);
        mascot_approve_answer("xyz".into(), false).unwrap();
        assert!(mascot_approve_answer("xyz".into(), true).is_err());
        assert!(mascot_approve_answer("no-existe".into(), true).is_err());
    }
}
