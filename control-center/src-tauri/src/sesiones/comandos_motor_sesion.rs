// sesiones/comandos_motor_sesion.rs — Comandos Tauri de las sesiones nativas
// de Codex y Gemini (plans/2026-11-04-sesiones-de-motor.md, «Contrato»).
// Envoltorios finos: la lógica vive en `motor_sesion`. `sesiones_kill` y
// `sesiones_rename` desvían a `motor_sesion` desde `gestor`.

use super::comandos::blocking;
use super::motor_sesion::{self, CreateEngineRequest, EngineSessionPast, Mensaje};
use super::types::{EngineTask, SessionInfo};

fn no_vacio(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.trim().is_empty())
}

/// Interrumpe el turno conservando abierta la sesión de motor.
#[tauri::command]
pub async fn sesiones_engine_session_interrupt(id: String) -> Result<(), String> {
    blocking(move || super::motor_vivo::interrumpir(&id)).await
}

/// Crea una sesión de motor (`engine` = `codex` | `gemini`) o reabre la
/// cerrada de `resume` con su id, sus turnos y su hilo de Codex.
#[tauri::command]
pub async fn sesiones_engine_session_create(
    engine: String,
    project_id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    resume: Option<String>,
) -> Result<SessionInfo, String> {
    let req = CreateEngineRequest {
        engine,
        project_id: no_vacio(project_id),
        cwd: no_vacio(cwd),
        model: no_vacio(model),
        resume: no_vacio(resume),
    };
    blocking(move || motor_sesion::create(req)).await
}

/// Envía un mensaje a la sesión de motor; devuelve el turno lanzado. Con
/// `model`, ese turno lo usa y pasa a ser el modelo de la sesión.
#[tauri::command]
pub async fn sesiones_engine_session_send(
    id: String,
    text: String,
    attachments: Option<Vec<String>>,
    model: Option<String>,
) -> Result<EngineTask, String> {
    blocking(move || {
        let attachments = attachments.unwrap_or_default();
        let model = no_vacio(model);
        let msg = Mensaje {
            text: &text,
            attachments: &attachments,
            model: model.as_deref(),
        };
        motor_sesion::send(&id, &msg)
    })
    .await
}

/// Sesiones de motor cerradas, más recientes primero.
#[tauri::command]
pub async fn sesiones_engine_session_past(
    limit: Option<usize>,
) -> Result<Vec<EngineSessionPast>, String> {
    blocking(move || Ok(motor_sesion::past(limit))).await
}
