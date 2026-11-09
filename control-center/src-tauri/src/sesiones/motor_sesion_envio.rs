// sesiones/motor_sesion_envio.rs — Turnos de una sesión de motor
// (submódulo de `motor_sesion`): `sesiones_engine_session_send`.
//
// Cada turno es una `EngineTask` con `kind = "chat"` (permisos de `task`:
// Codex con `workspace-write`, Gemini con `--mode accept-edits`, OpenCode con
// `--auto`). Codex retoma el hilo de la sesión (`exec resume`, mapa de hilos
// de `codex.rs` con clave = id de la sesión) y OpenCode su sesión
// (`--session ses_…`, mapa de `opencode_sesion.rs` con la misma clave). `agy` no retoma: el prompt de Gemini lleva
// antes los turnos previos (`Usuario`/`Gemini`) recortados a
// `CONTEXT_BUDGET`, conservando los más recientes.

use super::{lock, Turno, MAX_TURNOS};
use crate::sesiones::intervencion::{
    pack_turns, split_attachments, with_attachment_list, Turn, CONTEXT_BUDGET,
};
use crate::sesiones::modelos::validate_model_for;
use crate::sesiones::motor::{self, TaskSpec, KIND_CHAT};
use crate::sesiones::types::{now_iso, EngineTask, PermissionMode};
use crate::sesiones::{codex, gemini, gestor, opencode, registro};

const CONTEXTO_INICIO: &str = "[Contexto: turnos anteriores de esta conversación contigo]\n\n";
const CONTEXTO_FIN: &str = "[Fin del contexto]\n\n";

/// Lanza el proceso del turno: (spec, prompt completo, imágenes, proyecto).
pub type Lanzador<'a> =
    &'a dyn Fn(TaskSpec, String, &[String], Option<&str>) -> Result<EngineTask, String>;

/// Lo que el turno necesita de la sesión, tomado al reservarlo.
struct Reserva {
    engine: &'static str,
    cwd: String,
    model: Option<String>,
    project_id: Option<String>,
}

/// Mensaje de `sesiones_engine_session_send`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Mensaje<'a> {
    pub text: &'a str,
    pub attachments: &'a [String],
    /// Modelo de este turno; pasa a ser el de la sesión (`None` = el de la
    /// sesión).
    pub model: Option<&'a str>,
}

/// Envía un mensaje a la sesión de motor `id` y devuelve el turno lanzado.
pub fn send(id: &str, msg: &Mensaje) -> Result<EngineTask, String> {
    send_con_vivo(
        id,
        msg,
        &lanzar_motor,
        Some(&crate::sesiones::motor_vivo::asegurar_real),
        &|id, texto| {
            registro::emit(
                crate::sesiones::types::ev::NOTICE,
                serde_json::json!({"id":id,"level":"warn","text":texto}),
            );
        },
    )
}

fn lanzar_motor(
    spec: TaskSpec,
    full: String,
    images: &[String],
    project_id: Option<&str>,
) -> Result<EngineTask, String> {
    match spec.engine {
        "codex" => codex::start(spec, full, project_id, images),
        "opencode" => opencode::start(spec, full),
        _ => gemini::start(spec, full),
    }
}

/// `send` con el lanzador inyectado (los tests no lanzan procesos).
#[cfg(test)]
pub fn send_con(id: &str, msg: &Mensaje, lanzar: Lanzador) -> Result<EngineTask, String> {
    send_con_vivo(id, msg, lanzar, None, &|_, _| {})
}

type Asegurador<'a> =
    &'a dyn Fn(&str) -> Result<std::sync::Arc<crate::sesiones::motor_vivo::Vivo>, String>;

pub(crate) fn send_con_vivo(
    id: &str,
    msg: &Mensaje,
    lanzar: Lanzador,
    vivo: Option<Asegurador>,
    avisar: &dyn Fn(&str, &str),
) -> Result<EngineTask, String> {
    let Mensaje {
        text,
        attachments,
        model,
    } = *msg;
    validar(text, attachments)?;
    let previos: Vec<EngineTask> = motor::turnos_de_sesion(id)
        .into_iter()
        .filter(|t| t.status != "running")
        .collect();
    let primero = previos.is_empty() && !crate::sesiones::motor_vivo::tiene_historial(id);
    let reserva = reservar(id, text, model, primero)?;
    registro::emit_sessions();
    if let Some(resultado) = intentar_vivo(id, msg, vivo, avisar) {
        return resultado;
    }
    motor::podar_turnos(id, MAX_TURNOS.saturating_sub(1));
    match lanzar_turno(id, &reserva, text, attachments, &previos, lanzar) {
        Ok(task) => {
            fijar(id, &task);
            crate::sesiones::motor_vivo::emitir_turno_exec(&task);
            Ok(task)
        }
        Err(e) => {
            liberar(id);
            Err(e)
        }
    }
}

fn intentar_vivo(
    id: &str,
    msg: &Mensaje,
    asegurar: Option<Asegurador>,
    avisar: &dyn Fn(&str, &str),
) -> Option<Result<EngineTask, String>> {
    match asegurar?(id) {
        Ok(vivo) => {
            let resultado = crate::sesiones::motor_vivo::enviar(id, msg, vivo);
            if resultado.is_err() {
                liberar(id);
            }
            Some(resultado)
        }
        Err(error) => {
            let propio_codex = super::get(id).is_ok_and(|s| s.engine == "codex")
                && matches!(
                    msg.text.split_whitespace().next(),
                    Some("/compact" | "/clear" | "/rewind" | "/review")
                );
            if error.contains("no anuncia un modo equivalente")
                || error.contains("no tiene equivalente para el modo")
                || propio_codex
            {
                liberar(id);
                return Some(Err(error));
            }
            // `exec` corre con los permisos fijos de `kind = chat` (acceso total):
            // solo equivale a bypass. En otro modo, error explícito.
            if let Some(modo) = super::get(id)
                .ok()
                .map(|s| s.permission_mode)
                .filter(|m| *m != PermissionMode::BypassPermissions)
            {
                liberar(id);
                return Some(Err(format!(
                    "No se pudo iniciar el motor persistente ({error}) y la vía exec no respeta el modo {}: reintenta o cambia a bypass",
                    crate::sesiones::lanzamiento::modo_cli(modo)
                )));
            }
            avisar(
                id,
                &format!("No se pudo iniciar el motor persistente; se usa exec: {error}"),
            );
            None
        }
    }
}

fn validar(text: &str, attachments: &[String]) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("el mensaje está vacío".to_string());
    }
    if let Some(a) = attachments
        .iter()
        .find(|a| a.trim().is_empty() || a.chars().any(char::is_control))
    {
        return Err(format!("ruta de adjunto no válida: '{a}'"));
    }
    Ok(())
}

/// Reserva el turno (error si ya hay uno), fija el modelo si llega uno y pone
/// el título con el primer mensaje si el usuario no la renombró.
fn reservar(id: &str, text: &str, model: Option<&str>, primero: bool) -> Result<Reserva, String> {
    let mut m = lock()?;
    let s = m
        .get_mut(id)
        .filter(|s| s.open)
        .ok_or_else(|| format!("no existe la sesión de motor abierta '{id}'"))?;
    if s.turno != Turno::Libre {
        return Err("la sesión ya está trabajando".to_string());
    }
    let engine = super::validar_motor(&s.engine)?;
    if let Some(m) = model {
        validate_model_for(engine, m)?;
        s.model = Some(m.to_string());
    }
    let ahora = now_iso();
    s.turno = Turno::Lanzando;
    s.working_since = Some(ahora.clone());
    s.last_activity_at = ahora;
    if primero && !s.title_manual {
        s.title = gestor::title_from(text);
    }
    Ok(Reserva {
        engine,
        cwd: s.cwd.clone(),
        model: s.model.clone(),
        project_id: s.project_id.clone(),
    })
}

fn lanzar_turno(
    id: &str,
    r: &Reserva,
    text: &str,
    attachments: &[String],
    previos: &[EngineTask],
    lanzar: Lanzador,
) -> Result<EngineTask, String> {
    let contexto = (r.engine == "gemini")
        .then(|| contexto_gemini(previos))
        .flatten();
    let (images, files) = split_attachments(r.engine, attachments);
    let base = componer(text, contexto.as_deref());
    let spec = TaskSpec {
        engine: r.engine,
        kind: KIND_CHAT.to_string(),
        mode: "local".into(),
        cwd: r.cwd.clone(),
        prompt: text.trim().to_string(),
        session_id: Some(id.to_string()),
        context_chars: contexto.as_deref().map_or(0, |c| c.chars().count()),
        model: r.model.clone(),
        group: None,
    };
    lanzar(
        spec,
        with_attachment_list(&base, &files),
        &images,
        r.project_id.as_deref(),
    )
}

/// Turnos previos de la sesión para Gemini, recortados a `CONTEXT_BUDGET`
/// conservando los más recientes (`None` sin turnos).
pub fn contexto_gemini(previos: &[EngineTask]) -> Option<String> {
    let turnos: Vec<Turn> = previos
        .iter()
        .flat_map(|t| {
            let respuesta = t
                .summary
                .as_ref()
                .filter(|s| !s.trim().is_empty())
                .map(|s| ("Gemini", s.trim().to_string()));
            std::iter::once(("Usuario", t.prompt.clone())).chain(respuesta)
        })
        .collect();
    (!turnos.is_empty()).then(|| pack_turns(&turnos, CONTEXT_BUDGET))
}

fn componer(text: &str, contexto: Option<&str>) -> String {
    match contexto.filter(|c| !c.trim().is_empty()) {
        Some(c) => format!("{CONTEXTO_INICIO}{c}{CONTEXTO_FIN}{}", text.trim()),
        None => text.trim().to_string(),
    }
}

/// El turno quedó lanzado: la sesión lo sigue hasta que termine. Si ya
/// terminó antes de fijarlo (el aviso de `motor` llegó con la reserva), se
/// cierra aquí.
fn fijar(id: &str, task: &EngineTask) {
    if let Ok(mut m) = lock() {
        if let Some(s) = m.get_mut(id).filter(|s| s.turno == Turno::Lanzando) {
            s.turno = Turno::EnCurso(task.id.clone());
        }
    }
    super::cambiado();
    if let Some(t) = motor::get(&task.id).ok().filter(|t| t.status != "running") {
        super::turno_actualizado(&t);
    }
}

/// El lanzamiento falló: la sesión vuelve a estar libre.
pub(crate) fn liberar(id: &str) {
    if let Ok(mut m) = lock() {
        if let Some(s) = m.get_mut(id).filter(|s| s.turno == Turno::Lanzando) {
            s.turno = Turno::Libre;
            s.working_since = None;
        }
    }
    registro::emit_sessions();
}
