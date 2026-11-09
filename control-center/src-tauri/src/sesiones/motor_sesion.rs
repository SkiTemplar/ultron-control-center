// sesiones/motor_sesion.rs — Sesiones nativas de Codex, Gemini y OpenCode en Sessions
//
// Una sesión de motor no tiene proceso de Claude ni PTY. `motor_vivo` conserva
// su servidor stdio entre turnos; si falla el arranque, `motor.rs` lanza una
// tarea `chat` con exec. La sesión vive en este
// registro, aparte de `registro.rs` (cuya persistencia relanzaría `claude`),
// y solo se fusiona en lo que ve la UI: `registro::emit_sessions` y
// `gestor::list`. `gestor::kill` y `gestor::rename` desvían aquí cuando el id
// es de una sesión de motor abierta.
//
// Regla de candados: nunca se llama a `motor` con el candado de este registro
// tomado. `motor::emit` avisa aquí de cada cambio de un turno
// (`turno_actualizado`) y el registro de `motor` toma este al iniciarse
// (`turnos_iniciales`).

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::Serialize;

use super::gestor::{self, CreateRequest, Proyecto};
use super::types::{now_iso, EngineTask, PermissionMode, SessionInfo, SessionStatus};
use super::{codex, motor, opencode, registro};

#[path = "motor_sesion_envio.rs"]
mod envio;
#[path = "motor_sesion_guardado.rs"]
mod guardado;
#[path = "motor_sesion_turnos.rs"]
mod turnos;
pub use turnos::{turno_actualizado, turnos_iniciales};
#[path = "motor_sesion_permisos.rs"]
mod permisos;
#[path = "motor_sesion_vivo.rs"]
mod vivo;
pub(super) use envio::liberar as liberar_comando;
#[cfg(test)]
pub(super) use envio::send_con_vivo;
#[cfg(test)]
pub use envio::{contexto_gemini, send_con};
pub use envio::{send, Mensaje};
#[cfg(not(test))]
pub(super) use guardado::directorio_guardado;
#[cfg(test)]
pub use guardado::{cargar_de, guardar_en};
use permisos::preferencias_iniciales;
pub use permisos::{ajustes, set_permission_mode};
pub(super) use vivo::{fijar_hilo, fijar_vivo, terminar_vivo, titulo_vivo};

/// Sesiones que se guardan como mucho (se podan antes las cerradas más
/// antiguas; una abierta no se poda).
pub const MAX_SESIONES: usize = 50;
/// Turnos que se guardan por sesión (los más recientes).
pub const MAX_TURNOS: usize = 200;
/// Sesiones cerradas que devuelve `past` sin límite explícito.
const PAST_LIMIT: usize = 30;

/// Turno de la sesión.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Turno {
    Libre,
    /// Reservado: el proceso del motor se está lanzando.
    Lanzando,
    /// Id de la tarea del turno en curso.
    EnCurso(String),
    /// Turno servido por el adaptador persistente, sin EngineTask registrada.
    Vivo(String),
}

/// Estado de una sesión de motor.
#[derive(Debug, Clone)]
pub struct SesionMotor {
    pub id: String,
    pub engine: String,
    pub project_id: Option<String>,
    pub project_name: String,
    pub cwd: String,
    pub title: String,
    /// El usuario la renombró: el primer mensaje ya no pone el título.
    pub title_manual: bool,
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    pub started_at: String,
    pub last_activity_at: String,
    pub open: bool,
    /// Hilo persistente de app-server o ACP; también admite los hilos antiguos
    /// guardados por exec de Codex y OpenCode.
    pub thread_id: Option<String>,
    /// Turnos de una sesión cerrada (con la sesión abierta viven en `motor`).
    pub turns: Vec<EngineTask>,
    pub turno: Turno,
    pub working_since: Option<String>,
}

/// Sesión de motor cerrada (`sesiones_engine_session_past`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineSessionPast {
    pub id: String,
    pub engine: String,
    pub project_id: Option<String>,
    pub project_name: String,
    pub cwd: String,
    pub title: String,
    pub started_at: String,
    pub last_activity_at: String,
    /// Número de turnos guardados.
    pub turns: usize,
}

type Mapa = HashMap<String, SesionMotor>;

fn sesiones() -> &'static Mutex<Mapa> {
    static S: OnceLock<Mutex<Mapa>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(guardado::cargar_inicial()))
}

fn lock() -> Result<MutexGuard<'static, Mapa>, String> {
    sesiones()
        .lock()
        .map_err(|_| "registro de sesiones de motor envenenado".to_string())
}

/// Motor admitido como sesión (`codex` | `gemini` | `opencode`).
pub fn validar_motor(engine: &str) -> Result<&'static str, String> {
    match engine {
        "codex" => Ok("codex"),
        "gemini" => Ok("gemini"),
        "opencode" => Ok("opencode"),
        other => Err(format!(
            "motor no válido para una sesión: '{other}' (solo codex, gemini u opencode)"
        )),
    }
}

/// Siembra el hilo guardado de la sesión en el mapa de continuidad de su motor.
pub(crate) fn sembrar_hilo(engine: &str, id: &str, hilo: &str) {
    match engine {
        "codex" => codex::sembrar_hilo(id, hilo),
        "opencode" => opencode::sembrar_sesion(id, hilo),
        _ => {}
    }
}

/// Sesiones de motor abiertas, en orden de alta.
pub fn infos() -> Vec<SessionInfo> {
    let mut v: Vec<SessionInfo> = lock()
        .map(|m| {
            m.values()
                .filter(|s| s.open)
                .map(SesionMotor::info)
                .collect()
        })
        .unwrap_or_default();
    v.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    v
}

/// ¿`id` es una sesión de motor abierta?
pub fn existe(id: &str) -> bool {
    lock().is_ok_and(|m| m.get(id).is_some_and(|s| s.open))
}

/// Copia de la sesión (abierta o cerrada), sin retener el candado del registro.
pub fn get(id: &str) -> Result<SesionMotor, String> {
    lock()?
        .get(id)
        .cloned()
        .ok_or_else(|| format!("no existe la sesión de motor '{id}'"))
}

/// Petición de `sesiones_engine_session_create`.
#[derive(Debug, Clone, Default)]
pub struct CreateEngineRequest {
    pub engine: String,
    pub project_id: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    /// Id de una sesión de motor cerrada que se reabre.
    pub resume: Option<String>,
}

/// Crea una sesión de motor (o reabre la cerrada de `resume`).
pub fn create(req: CreateEngineRequest) -> Result<SessionInfo, String> {
    let engine = validar_motor(&req.engine)?;
    if let Some(m) = &req.model {
        super::modelos::validate_model_for(engine, m)?;
    }
    if let Some(id) = req.resume.as_deref() {
        return reabrir(id, engine, req.model);
    }
    let (proyecto, cwd) = gestor::resolver_cwd(&CreateRequest {
        project_id: req.project_id,
        cwd: req.cwd.unwrap_or_default(),
        resume: None,
        model: None,
        effort: None,
        permission_mode: None,
        fork_from: None,
    })?;
    crear_en(engine, proyecto.as_ref(), cwd, req.model)
}

/// Alta de una sesión nueva con el cwd ya resuelto.
pub fn crear_en(
    engine: &'static str,
    proyecto: Option<&Proyecto>,
    cwd: String,
    model: Option<String>,
) -> Result<SessionInfo, String> {
    crear_con_preferencias(engine, proyecto, cwd, model, &preferencias_iniciales())
}

pub(super) fn crear_con_preferencias(
    engine: &'static str,
    proyecto: Option<&Proyecto>,
    cwd: String,
    model: Option<String>,
    prefs: &super::types::SessionPrefs,
) -> Result<SessionInfo, String> {
    let project_name = proyecto.map_or_else(|| gestor::folder_name(&cwd), |p| p.1.clone());
    let ahora = now_iso();
    let s = SesionMotor {
        id: uuid::Uuid::new_v4().to_string(),
        engine: engine.to_string(),
        project_id: proyecto.map(|p| p.0.clone()),
        title: format!("{} · {project_name}", motor::engine_label(engine)),
        project_name,
        cwd,
        title_manual: false,
        model,
        permission_mode: prefs.launch_permission_mode,
        started_at: ahora.clone(),
        last_activity_at: ahora,
        open: true,
        thread_id: None,
        turns: Vec::new(),
        turno: Turno::Libre,
        working_since: None,
    };
    let info = s.info();
    lock()?.insert(s.id.clone(), s);
    cambiado();
    Ok(info)
}

/// Reabre una sesión cerrada con su id, sus turnos y su hilo (Codex u OpenCode).
fn reabrir(id: &str, engine: &str, model: Option<String>) -> Result<SessionInfo, String> {
    let (info, turnos, hilo) = {
        let mut m = lock()?;
        let s = m
            .get_mut(id)
            .ok_or_else(|| format!("no existe la sesión de motor '{id}'"))?;
        if s.open {
            return Err("la sesión de motor ya está abierta".to_string());
        }
        if s.engine != engine {
            return Err(format!(
                "la sesión '{id}' es de {}, no de {}",
                motor::engine_label(&s.engine),
                motor::engine_label(engine)
            ));
        }
        s.open = true;
        s.turno = Turno::Libre;
        s.working_since = None;
        s.last_activity_at = now_iso();
        if model.is_some() {
            s.model = model;
        }
        (s.info(), std::mem::take(&mut s.turns), s.thread_id.clone())
    };
    motor::insertar_turnos(turnos);
    if let Some(h) = hilo {
        sembrar_hilo(engine, id, &h);
    }
    cambiado();
    Ok(info)
}

/// Cierra la sesión: cancela el turno vivo, guarda sus turnos y la quita de
/// la lista (sigue en `past`).
pub fn kill(id: &str) -> Result<(), String> {
    {
        let mut m = lock()?;
        let s = m
            .get_mut(id)
            .filter(|s| s.open)
            .ok_or_else(|| format!("no existe la sesión de motor abierta '{id}'"))?;
        s.open = false;
        s.turno = Turno::Libre;
        s.working_since = None;
        s.last_activity_at = now_iso();
    }
    super::motor_cola::olvidar(id);
    motor::cancelar_de_sesion(id);
    super::motor_vivo::cerrar(id);
    let turnos = motor::retirar_turnos(id);
    let podadas = {
        let mut m = lock()?;
        if let Some(s) = m.get_mut(id) {
            s.turns = guardado::recortar(turnos, MAX_TURNOS);
        }
        guardado::podar_cerradas(&mut m, MAX_SESIONES)
    };
    for id in podadas {
        super::motor_vivo::olvidar(&id);
    }
    codex::olvidar_hilo(id);
    opencode::olvidar_sesion(id);
    cambiado();
    Ok(())
}

/// Renombra una sesión de motor abierta (`title` ya validado por el gestor).
pub fn rename(id: &str, title: &str) -> Result<(), String> {
    {
        let mut m = lock()?;
        let s = m
            .get_mut(id)
            .filter(|s| s.open)
            .ok_or_else(|| format!("no existe la sesión de motor abierta '{id}'"))?;
        s.title = title.to_string();
        s.title_manual = true;
    }
    cambiado();
    Ok(())
}

/// Sesiones de motor cerradas, más recientes primero.
pub fn past(limit: Option<usize>) -> Vec<EngineSessionPast> {
    let mut v: Vec<EngineSessionPast> = lock()
        .map(|m| {
            m.values()
                .filter(|s| !s.open)
                .map(|s| EngineSessionPast {
                    id: s.id.clone(),
                    engine: s.engine.clone(),
                    project_id: s.project_id.clone(),
                    project_name: s.project_name.clone(),
                    cwd: s.cwd.clone(),
                    title: s.title.clone(),
                    started_at: s.started_at.clone(),
                    last_activity_at: s.last_activity_at.clone(),
                    turns: s.turns.len(),
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
    v.truncate(limit.unwrap_or(PAST_LIMIT).min(MAX_SESIONES));
    v
}

/// Un turno relanzado (OpenCode con la sesión caducada) pasa a ser el turno en
/// curso de su sesión, que quedó libre al fallar la tarea original. Si entre
/// tanto se lanzó otro turno o se cerró la sesión, no se toca.
pub fn adoptar_relanzado(t: &EngineTask) {
    let Some(sid) = t.session_id.as_deref() else {
        return;
    };
    let adoptado = lock().is_ok_and(|mut m| {
        let Some(s) = m.get_mut(sid).filter(|s| s.open && s.turno == Turno::Libre) else {
            return false;
        };
        let ahora = now_iso();
        s.turno = Turno::EnCurso(t.id.clone());
        s.working_since = Some(ahora.clone());
        s.last_activity_at = ahora;
        true
    });
    if !adoptado {
        return;
    }
    cambiado();
    // Si ya terminó mientras se adoptaba, se cierra aquí.
    if let Some(fin) = motor::get(&t.id).ok().filter(|x| x.status != "running") {
        turno_actualizado(&fin);
    }
}

/// Persiste y reemite la lista de sesiones. Sin el candado tomado.
fn cambiado() {
    guardado::guardar();
    registro::emit_sessions();
}

#[cfg(test)]
#[path = "tests_motor_sesion.rs"]
mod tests;
