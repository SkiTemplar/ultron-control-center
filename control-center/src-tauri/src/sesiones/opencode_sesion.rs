// sesiones/opencode_sesion.rs — Continuidad de OpenCode por sesión de
// Sesiones (submódulo de `opencode`).
//
// La sesión de OpenCode (`ses_…`) de cada sesión de Sesiones se recuerda al
// terminar bien un turno y el siguiente la continúa con `--session`. Si la
// recordada ya no existe en OpenCode (borrada desde su TUI, base de datos
// reiniciada o migrada), `opencode run --session` sale con código 1 y solo
// `Error: Session not found` en stderr (comprobado con 1.19.4 el 2026-10-26).
// En ese caso se olvida y el turno se relanza una vez sin `--session`, con un
// aviso como primer evento de la tarea nueva.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::sesiones::motor::OnDone;
use crate::sesiones::types::EngineTask;

/// Texto de OpenCode cuando la sesión pedida con `--session` no existe.
const SESION_NO_ENCONTRADA: &str = "Session not found";

/// Sesión de OpenCode por sesión de Sesiones (continuidad).
fn sesiones_oc() -> &'static Mutex<HashMap<String, String>> {
    static T: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn sesion_para(session_id: Option<&str>) -> Option<String> {
    let sid = session_id?;
    sesiones_oc().lock().ok()?.get(sid).cloned()
}

fn recordar(sid: String, oc: String) {
    if let Ok(mut m) = sesiones_oc().lock() {
        m.insert(sid, oc);
    }
}

/// Siembra la sesión de OpenCode guardada de una sesión de motor (al reabrirla
/// o al arrancar la app). Un id que no tiene la forma de `ses_…` se ignora.
pub fn sembrar(sid: &str, oc: &str) {
    if sesion_valida(oc) {
        recordar(sid.to_string(), oc.to_string());
    }
}

/// Olvida la sesión de OpenCode de `sid` (al cerrar la sesión de motor).
pub fn olvidar_todo(sid: &str) {
    if let Ok(mut m) = sesiones_oc().lock() {
        m.remove(sid);
    }
}

/// Olvida `oc` como sesión de `sid` (si otra tarea ya recordó otra, se queda).
fn olvidar(sid: &str, oc: &str) {
    if let Ok(mut m) = sesiones_oc().lock() {
        if m.get(sid).is_some_and(|v| v == oc) {
            m.remove(sid);
        }
    }
}

/// Un id de sesión de OpenCode va como argumento: solo `ses_` + alfanuméricos.
pub fn sesion_valida(id: &str) -> bool {
    id.strip_prefix("ses_").is_some_and(|r| {
        !r.is_empty() && r.len() <= 64 && r.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

/// Tipos de evento que llevan errores del motor (stderr, `error` del JSON);
/// nunca `message`, que es texto del modelo y puede citar cualquier cosa.
const EVENTOS_DE_ERROR: &[&str] = &["error"];

/// La tarea falló porque la sesión de OpenCode pedida ya no existe.
pub fn sesion_caducada(t: &EngineTask) -> bool {
    t.status == "error"
        && t.events.iter().any(|e| {
            EVENTOS_DE_ERROR.contains(&e.kind.as_str()) && e.text.contains(SESION_NO_ENCONTRADA)
        })
}

/// Aviso con el que empieza la tarea relanzada.
pub fn aviso_sesion_caducada(oc: &str) -> String {
    format!(
        "La sesión de OpenCode recordada ({oc}) ya no existe: se olvidó y el turno se \
relanzó en una sesión nueva, sin la memoria de los turnos anteriores de OpenCode."
    )
}

/// Turno lanzado con `--session`: lo necesario para relanzarlo sin ella.
pub struct Reintento {
    pub sesion: String,
    pub prompt: String,
}

/// Relanza el turno de la tarea fallida sin `--session` (`opencode::relanzar`,
/// que valida la generación del relevo y, si el lanzamiento falla, avisa a
/// `Fin` para no perder el turno; los tests pasan uno que solo anota).
pub type Relanzar = fn(&EngineTask, String, String);

/// Aviso de fin de turno al relevo (`relevo::task_finished` en producción;
/// los tests pasan uno que solo anota).
pub type Fin = fn(&EngineTask);

/// Al terminar: borra el encargo adjunto; si fue bien, recuerda la sesión; si
/// la recordada ya no existía, la olvida y relanza el turno una vez. Salvo en
/// el relanzamiento (el turno sigue en la tarea nueva), avisa a `fin`: sin
/// eso, un relevo en OpenCode que falla no escala a Codex.
pub fn al_terminar(
    adjunto: Option<PathBuf>,
    reintento: Option<Reintento>,
    relanzar: Relanzar,
    fin: Fin,
) -> OnDone {
    Box::new(move |t: &EngineTask| {
        if let Some(f) = adjunto {
            if let Err(e) = std::fs::remove_file(&f) {
                // Si falla, lo poda `podar_encargos` al caducar.
                tracing::debug!(fichero = %f.display(), error = %e, "no se borró el encargo de OpenCode");
            }
        }
        if let Some(sid) = t.session_id.clone() {
            if let Some(r) = reintento.filter(|_| sesion_caducada(t)) {
                olvidar(&sid, &r.sesion);
                tracing::warn!(sesion = %sid, opencode = %r.sesion, "sesión de OpenCode caducada: se relanza sin ella");
                relanzar(t, r.prompt, aviso_sesion_caducada(&r.sesion));
                return;
            }
            let fue_bien = t.status == "done";
            if let Some(oc) = t
                .thread_id
                .clone()
                .filter(|oc| fue_bien && sesion_valida(oc))
            {
                recordar(sid, oc);
            }
        }
        fin(t);
    })
}

#[cfg(test)]
pub fn recordar_para_prueba(sid: &str, oc: &str) {
    recordar(sid.to_string(), oc.to_string());
}
