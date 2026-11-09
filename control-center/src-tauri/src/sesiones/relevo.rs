//! Relevo automatico de Claude a motores externos al alcanzar una cuota.
//!
//! Cadena: OpenCode con la API de Anthropic (si hay key de créditos) → Codex
//! → Gemini → error visible. Las operaciones que cambian el motor activo o
//! cierran el relevo se serializan sobre el estado de la sesión: `claim`
//! cambia de motor solo si el que falló sigue activo y el relevo no se está
//! cerrando, y un motor lanzado mientras se volvía a Claude se cancela.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use chrono::Local;
use serde::Serialize;
use serde_json::Value;

use super::intervencion;
#[cfg(not(test))]
use super::intervencion::RunRequest;
use super::types::{now_iso, ChatMessage, EngineTask, PlanUsage};
use super::{ajustes, lectura_final, motor, registro, transcript};

#[path = "relevo_aviso.rs"]
mod aviso;
#[path = "relevo_limite.rs"]
mod limite;
#[path = "relevo_prompt.rs"]
mod prompt;

pub use aviso::{
    detect_by_usage, detect_usage_limit, exhausted_window, pick_return, LimitKind, UsageLimit,
};
pub use prompt::compose_handoff;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayEvent {
    Limit,
    Failed,
    Reset { running: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayAction {
    StartApi,
    StartCodex,
    StartGemini,
    ShowError,
    ReturnToClaude,
    Wait,
}

pub fn transition(engine: Option<&str>, event: RelayEvent) -> RelayAction {
    match (engine, event) {
        (None, RelayEvent::Limit) => RelayAction::StartApi,
        (Some("opencode"), RelayEvent::Failed) => RelayAction::StartCodex,
        (Some("codex"), RelayEvent::Failed) => RelayAction::StartGemini,
        (Some("gemini"), RelayEvent::Failed) => RelayAction::ShowError,
        (Some(_), RelayEvent::Reset { running: false }) => RelayAction::ReturnToClaude,
        _ => RelayAction::Wait,
    }
}

/// Plazo de `git status` para el traspaso: un repositorio enorme o una unidad
/// colgada no pueden retener el relevo.
const PLAZO_GIT: Duration = Duration::from_secs(5);

/// Texto del traspaso cuando git no responde: el relevo sale igual.
const GIT_NO_DISPONIBLE: &str = "(no disponible)";

fn comando_git_status(cwd: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(["status", "--short"]).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Salida de `cmd` con su plazo; cualquier fallo da el texto degradado.
fn salida_o_degradado(cmd: Command, plazo: Duration) -> String {
    match super::cli_info::run_cli(cmd, plazo, "git status") {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(o) => {
            tracing::debug!(codigo = ?o.status.code(), "relevo: git status falló");
            GIT_NO_DISPONIBLE.into()
        }
        Err(e) => {
            tracing::warn!(error = %e, "relevo: git status sin resultado");
            GIT_NO_DISPONIBLE.into()
        }
    }
}

fn git_status(cwd: &str) -> String {
    salida_o_degradado(comando_git_status(cwd), PLAZO_GIT)
}

/// Muestra local de uso reciente (la escribe la línea de estado de Claude).
/// En los tests, nunca la real: una cuota llena en la máquina no puede cambiar
/// el resultado de la cola.
fn local_usage() -> Option<PlanUsage> {
    if cfg!(test) {
        return None;
    }
    let root = crate::ultron_root().ok()?;
    super::uso::uso_local_de(&root, chrono::Utc::now())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayState {
    pub session_id: String,
    pub active_engine: String,
    pub since: String,
    /// Vuelta automática a Claude; `None` = desconocida (vuelta manual).
    pub return_at: Option<String>,
    pub limit_kind: LimitKind,
    pub task_ids: Vec<String>,
    pub failed_prompt: String,
    pub error: Option<String>,
    #[serde(skip)]
    handoff: String,
    /// Cambia con cada escalado y al empezar la vuelta a Claude.
    #[serde(skip)]
    generation: u64,
    /// La vuelta a Claude está en curso: no se escala ni se lanza nada más.
    #[serde(skip)]
    closing: bool,
}

fn states() -> &'static Mutex<HashMap<String, RelayState>> {
    static STATES: OnceLock<Mutex<HashMap<String, RelayState>>> = OnceLock::new();
    STATES.get_or_init(Default::default)
}

/// El estado sigue siendo coherente aunque un hilo entrara en pánico con el
/// candado: cada operación lo deja completo antes de soltarlo.
fn lock_states() -> MutexGuard<'static, HashMap<String, RelayState>> {
    states().lock().unwrap_or_else(PoisonError::into_inner)
}

fn emit_state(session_id: &str) {
    let state = get(session_id);
    registro::emit(
        super::types::ev::RELAY,
        serde_json::json!({ "id": session_id, "relay": state }),
    );
}

pub fn get(session_id: &str) -> Option<RelayState> {
    lock_states().get(session_id).cloned()
}

pub fn list() -> Vec<RelayState> {
    lock_states().values().cloned().collect()
}

/// Modelo del primer relevo: la API de Anthropic (créditos del plan) a través
/// de OpenCode, con la key `ULTRON_KEY_ANTHROPIC_CREDITS`.
pub const API_MODEL: &str = "anthropic/claude-sonnet-5-5";

/// Modelo de un turno del relevo: OpenCode solo se usa aquí con la API de
/// Anthropic; Codex y Gemini van con el predeterminado de su CLI.
pub fn relay_model(engine: &str) -> Option<String> {
    (engine == "opencode").then(|| API_MODEL.to_string())
}

/// Primer motor del relevo: la API si hay key de créditos; si no, Codex.
pub fn first_engine(api_key: bool) -> &'static str {
    if api_key {
        "opencode"
    } else {
        "codex"
    }
}

/// Siguiente motor de la cadena Claude → API → Codex → Gemini.
pub fn next_engine(engine: &str) -> Option<&'static str> {
    match transition(Some(engine), RelayEvent::Failed) {
        RelayAction::StartCodex => Some("codex"),
        RelayAction::StartGemini => Some("gemini"),
        _ => None,
    }
}

fn api_key_present() -> bool {
    super::opencode_entorno::claves()
        .iter()
        .any(|(p, _)| p.id == "anthropic")
}

/// En los tests nunca se lanza un motor real: el relevo lleva acceso total.
#[cfg(test)]
fn run_relay(_session_id: &str, engine: &str, _prompt: String) -> Result<EngineTask, String> {
    Err(format!("{engine} no se lanza en los tests"))
}

#[cfg(not(test))]
fn run_relay(session_id: &str, engine: &str, prompt: String) -> Result<EngineTask, String> {
    intervencion::run(RunRequest {
        session_id: session_id.to_string(),
        engine: engine.to_string(),
        prompt,
        kind: "relay".into(),
        include_context: false,
        mode: Some("local".into()),
        model: relay_model(engine),
        group: None,
        turn_id: None,
        attachments: Vec::new(),
    })
}

/// Registra una tarea del relevo. No cambia el motor activo: lo fijan `claim`
/// e `insert_new`, y los turnos del usuario solo van al motor activo
/// (`engineSendKind`). Si lo cambiara, un lanzamiento que acaba después de
/// `switch_to_gemini` o el fallo tardío de un motor anterior devolverían el
/// relevo a ese motor.
pub fn track_task(task: &EngineTask) {
    if task.kind != "relay" {
        return;
    }
    let Some(sid) = task.session_id.as_deref() else {
        return;
    };
    {
        let mut all = lock_states();
        if let Some(s) = all.get_mut(sid) {
            if !s.task_ids.contains(&task.id) {
                s.task_ids.push(task.id.clone());
            }
        }
    }
    emit_state(sid);
}

/// Inserta el estado si la sesión no tiene relevo; false si ya lo tenía.
fn insert_new(state: RelayState) -> bool {
    let mut all = lock_states();
    if all.contains_key(&state.session_id) {
        return false;
    }
    all.insert(state.session_id.clone(), state);
    true
}

fn detect(value: &Value) -> Option<UsageLimit> {
    detect_usage_limit(value).or_else(|| detect_by_usage(value, local_usage().as_ref()))
}

/// Se llama para cada linea viva del transcript; es idempotente por sesion.
/// Corre en el hilo que sigue a todas las sesiones: lo caro va en otro hilo.
pub fn observe(session_id: &str, value: &Value, transcript_path: &Path) {
    let Some(limit) = detect(value) else {
        return;
    };
    // Con o sin relevo automático, la cola no se vacía contra el aviso.
    limite::pausar(session_id, pick_return(&limit, local_usage().as_ref()));
    if !ajustes::prefs_actuales().automatic_relay || get(session_id).is_some() {
        return;
    }
    start_relay(session_id, limit, transcript_path);
}

/// Prepara y lanza el relevo en su hilo; una sola vez por sesión a la vez.
fn start_relay(session_id: &str, limit: UsageLimit, transcript_path: &Path) {
    if transition(None, RelayEvent::Limit) != RelayAction::StartApi {
        return;
    }
    if !limite::reservar_entrada(session_id) {
        return;
    }
    let (sid, path) = (session_id.to_string(), transcript_path.to_path_buf());
    let en_hilo = en_hilo_propio(move || {
        enter_relay(&sid, &limit, &path);
        limite::liberar_entrada(&sid);
    });
    if !en_hilo {
        limite::liberar_entrada(session_id);
    }
}

/// Trabajo del relevo fuera del hilo del seguidor: transcript, git, lanzar el
/// motor y volver a Claude (G3 puede tardar casi 50 s). false si no se pudo
/// crear el hilo.
fn en_hilo_propio(f: impl FnOnce() + Send + 'static) -> bool {
    let hilo = std::thread::Builder::new()
        .name("sesiones-relevo".into())
        .spawn(f);
    if let Err(e) = &hilo {
        tracing::error!(error = %e, "relevo: no se pudo crear su hilo");
    }
    hilo.is_ok()
}

/// Mensajes recientes del transcript, sin leerlo entero (de 50 a 200 MB): la
/// ventana crece hasta cubrir el último prompt y los mensajes del traspaso.
fn recent_messages(path: &Path) -> std::io::Result<Vec<ChatMessage>> {
    let encontrados = lectura_final::buscar_desde_el_final(path, |fin| {
        let mensajes = transcript::parse_all(&fin.texto, None);
        let bastan = !prompt::failed_prompt(&mensajes).is_empty()
            && prompt::relay_messages(&mensajes).len() >= prompt::MAX_MESSAGES;
        (bastan || fin.completo).then_some(mensajes)
    })?;
    Ok(encontrados.unwrap_or_default())
}

/// Sin relevo que arranque, la cola sigue en pausa y el usuario tiene que
/// saberlo: `RELAY` no va a emitir nada.
fn notify_error(session_id: &str, text: String) {
    tracing::warn!(sesion = session_id, "{text}");
    registro::emit(
        super::types::ev::NOTICE,
        serde_json::json!({ "id": session_id, "level": "error", "text": text }),
    );
}

fn enter_relay(session_id: &str, limit: &UsageLimit, transcript_path: &Path) {
    let messages = match recent_messages(transcript_path) {
        Ok(m) => m,
        Err(e) => {
            notify_error(
                session_id,
                format!(
                    "Límite de uso alcanzado, pero el relevo no arranca: no se pudo leer el transcript ({e})"
                ),
            );
            return;
        }
    };
    let cwd = match registro::read(session_id, |s| s.info.cwd.clone()) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(sesion = session_id, error = %e, "relevo: sesión sin cwd");
            return;
        }
    };
    let first = first_engine(api_key_present());
    let state = new_state(session_id, first, limit, &messages, &cwd);
    let handoff = state.handoff.clone();
    if !insert_new(state) {
        return;
    }
    // Se cerró mientras se preparaba: `forget_session` ya no ve este estado.
    if !registro::exists(session_id) {
        lock_states().remove(session_id);
        return;
    }
    emit_state(session_id);
    launch(session_id, first, handoff, 0);
}

fn new_state(
    session_id: &str,
    first: &str,
    limit: &UsageLimit,
    messages: &[ChatMessage],
    cwd: &str,
) -> RelayState {
    let failed = prompt::failed_prompt(messages);
    let handoff = compose_handoff(&failed, &prompt::relay_messages(messages), &git_status(cwd));
    RelayState {
        session_id: session_id.into(),
        active_engine: first.into(),
        since: now_iso(),
        return_at: pick_return(limit, local_usage().as_ref()),
        limit_kind: limit.kind,
        task_ids: Vec::new(),
        failed_prompt: failed,
        error: None,
        handoff,
        generation: 0,
        closing: false,
    }
}

/// Lanza `engine` para la generación `generation` del relevo. Si entre tanto
/// empezó la vuelta a Claude (o cambió la generación), cancela lo lanzado.
fn launch(session_id: &str, engine: &str, prompt: String, generation: u64) {
    match run_relay(session_id, engine, prompt) {
        Ok(task) => {
            track_task(&task);
            if !is_current(session_id, generation) {
                tracing::info!(sesion = session_id, tarea = %task.id, "relevo cerrado durante el lanzamiento: se cancela");
                cancel_logged(&task.id);
            }
        }
        Err(e) => escalate_after(session_id, engine, &e, None),
    }
}

fn is_current(session_id: &str, generation: u64) -> bool {
    lock_states()
        .get(session_id)
        .is_some_and(|s| !s.closing && s.generation == generation)
}

fn cancel_logged(task_id: &str) {
    if let Err(e) = motor::cancel(task_id) {
        tracing::debug!(tarea = task_id, error = %e, "relevo: no se canceló la tarea");
    }
}

/// Tareas del relevo que existen todavía en el registro de motores.
fn tasks_of(state: &RelayState) -> Vec<EngineTask> {
    state
        .task_ids
        .iter()
        .filter_map(|id| motor::get(id).ok())
        .collect()
}

/// Cambia el motor activo de `from` a `to` si `from` sigue activo y el
/// relevo no se está cerrando. Dos fallos simultáneos del mismo motor solo
/// escalan una vez.
fn claim(session_id: &str, from: &str, to: &str) -> Option<RelayState> {
    let mut all = lock_states();
    let s = all.get_mut(session_id)?;
    if s.closing || s.active_engine != from {
        return None;
    }
    s.active_engine = to.into();
    s.error = None;
    s.generation += 1;
    Some(s.clone())
}

/// Pasa el relevo al motor siguiente al que ha fallado, o marca el error.
/// `failed_task` es la tarea que falló, si la hay (no la hay cuando el motor
/// ni siquiera arrancó).
fn escalate_after(session_id: &str, failed: &str, reason: &str, failed_task: Option<&EngineTask>) {
    match next_engine(failed) {
        Some(next) => escalate(session_id, failed, next, reason, failed_task),
        None => mark_error(session_id, failed, reason.to_string()),
    }
}

/// Prompt del motor siguiente. Si la tarea fallida era un turno de
/// seguimiento del usuario, su petición va como pendiente y no en el historial.
fn escalation_prompt(
    state: &RelayState,
    failed: &str,
    reason: &str,
    failed_task: Option<&EngineTask>,
) -> String {
    let pending = failed_task.and_then(prompt::pending_request);
    let skip = failed_task
        .filter(|_| pending.is_some())
        .map(|t| t.id.as_str());
    let history = prompt::relay_history(&tasks_of(state), skip);
    prompt::compose_escalation(&state.handoff, failed, &history, pending.as_deref(), reason)
}

fn escalate(
    session_id: &str,
    failed: &str,
    next: &str,
    reason: &str,
    failed_task: Option<&EngineTask>,
) {
    let Some(state) = claim(session_id, failed, next) else {
        return;
    };
    emit_state(session_id);
    let text = escalation_prompt(&state, failed, reason, failed_task);
    launch(session_id, next, text, state.generation);
}

fn mark_error(session_id: &str, engine: &str, reason: String) {
    {
        let mut all = lock_states();
        match all.get_mut(session_id) {
            Some(s) if !s.closing && s.active_engine == engine => s.error = Some(reason),
            _ => return,
        }
    }
    emit_state(session_id);
}

pub fn task_finished(task: &EngineTask) {
    if task.kind != "relay" {
        return;
    }
    let Some(session_id) = task.session_id.as_deref() else {
        return;
    };
    // Sin registrarla aquí: una tarea que nunca entró en el relevo (lanzada
    // tras cerrarse) no puede volver a él al terminar.
    emit_state(session_id);
    if task.status == "error" {
        let reason = task
            .events
            .iter()
            .rev()
            .find(|e| e.kind == "error")
            .map(|e| e.text.as_str())
            .unwrap_or("el motor fallo");
        escalate_after(session_id, &task.engine, reason, Some(task));
    } else {
        poll_return(session_id);
    }
}

/// Contexto de un turno de seguimiento para un motor que no conserva el
/// hilo (Gemini): traspaso y turnos previos del relevo. `None` sin relevo.
pub fn relay_context(session_id: &str) -> Option<String> {
    let state = get(session_id)?;
    let history = prompt::relay_history(&tasks_of(&state), None);
    Some(prompt::compose_relay_context(&state.handoff, &history))
}

fn return_due(state: &RelayState) -> bool {
    state
        .return_at
        .as_deref()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .is_some_and(|at| at <= Local::now())
}

fn running(state: &RelayState) -> bool {
    tasks_of(state).iter().any(|t| t.status == "running")
}

/// Si la muestra local reciente sigue al 100 %, la vuelta se aplaza a su
/// reinicio: volver ahora solo produciría otro aviso de límite.
fn postpone_if_exhausted(session_id: &str, usage: Option<&PlanUsage>) -> bool {
    let Some((_, window)) = exhausted_window(usage) else {
        return false;
    };
    if let Some(s) = lock_states().get_mut(session_id) {
        s.return_at = window.resets_at.clone();
    }
    emit_state(session_id);
    true
}

/// Se llama en cada vuelta del seguidor, así que no bloquea: la vuelta a Claude
/// se reserva aquí y se completa en su hilo.
pub fn poll_return(session_id: &str) {
    let Some(state) = get(session_id) else {
        limite::poll(session_id, local_usage);
        return;
    };
    // Un relevo en error espera a que el usuario actúe: sin reintentos en bucle.
    if state.error.is_some() || state.closing || !return_due(&state) {
        return;
    }
    let reset = RelayEvent::Reset {
        running: running(&state),
    };
    if transition(Some(&state.active_engine), reset) != RelayAction::ReturnToClaude {
        return;
    }
    if postpone_if_exhausted(session_id, local_usage().as_ref()) {
        return;
    }
    let ids = match begin_return(session_id) {
        Ok(ids) => ids,
        Err(e) => {
            tracing::debug!(sesion = session_id, error = %e, "relevo: vuelta no reservada");
            return;
        }
    };
    let (sid, engine) = (session_id.to_string(), state.active_engine);
    let en_hilo = en_hilo_propio(move || {
        if let Err(e) = complete_return(&sid, &ids) {
            mark_error(&sid, &engine, format!("no se pudo volver a Claude: {e}"));
        }
    });
    if !en_hilo {
        abort_return(session_id);
    }
}

pub fn switch_to_gemini(session_id: &str) -> Result<RelayState, String> {
    let current = get(session_id).ok_or("la sesion no tiene relevo activo")?;
    if current.active_engine == "gemini" {
        return Err("el relevo ya esta en Gemini".into());
    }
    let state = claim(session_id, &current.active_engine, "gemini")
        .ok_or("el relevo cambio mientras tanto: vuelve a intentarlo")?;
    emit_state(session_id);
    for t in tasks_of(&state).iter().filter(|t| t.status == "running") {
        cancel_logged(&t.id);
    }
    let reason = "cambio manual solicitado por el usuario";
    let text = escalation_prompt(&state, &current.active_engine, reason, None);
    launch(session_id, "gemini", text, state.generation);
    get(session_id).ok_or("no se pudo cambiar el relevo".into())
}

/// Marca el cierre y devuelve las tareas registradas en ese instante.
fn begin_return(session_id: &str) -> Result<Vec<String>, String> {
    let mut all = lock_states();
    let s = all
        .get_mut(session_id)
        .ok_or("la sesion no tiene relevo activo")?;
    if s.closing {
        return Err("la vuelta a Claude ya esta en curso".into());
    }
    s.closing = true;
    s.generation += 1;
    Ok(s.task_ids.clone())
}

fn abort_return(session_id: &str) {
    if let Some(s) = lock_states().get_mut(session_id) {
        s.closing = false;
    }
}

pub fn return_to_claude(session_id: &str, cancel_running: bool) -> Result<(), String> {
    let state = get(session_id).ok_or("la sesion no tiene relevo activo")?;
    if running(&state) && !cancel_running {
        return Err("el turno del motor sigue en curso".into());
    }
    let ids = begin_return(session_id)?;
    complete_return(session_id, &ids)
}

/// Segunda parte de la vuelta, ya reservada con `begin_return`: cancela lo que
/// siga en curso, trae los resultados y reanuda la cola.
fn complete_return(session_id: &str, ids: &[String]) -> Result<(), String> {
    for id in ids {
        if motor::get(id).is_ok_and(|t| t.status == "running") {
            cancel_logged(id);
        }
    }
    for id in ids {
        if motor::get(id).is_ok_and(|t| t.status == "done" && t.brought_at.is_none()) {
            let sent = intervencion::traer(id, session_id, &|sid, text| {
                super::gestor::send(sid, text, &[])
            });
            if let Err(e) = sent {
                abort_return(session_id);
                return Err(e);
            }
        }
    }
    lock_states().remove(session_id);
    emit_state(session_id);
    limite::levantar(session_id);
    Ok(())
}

/// Comprobación previa al drenaje de la cola (`registro_drenaje::drenar`):
/// true si Claude está en el límite y la cola queda retenida.
pub fn frena_drenaje(session_id: &str) -> bool {
    limite::frena_drenaje(session_id, local_usage)
}

/// La sesión se cerró (`gestor::kill`): sin ella no hay panel que enseñe el
/// relevo ni a quién volver. Sus tareas las cancela `motor::cancelar_de_sesion`.
pub fn forget_session(session_id: &str) {
    let tenia = lock_states().remove(session_id).is_some();
    limite::olvidar(session_id);
    if tenia {
        emit_state(session_id);
    }
}

/// Tareas de los relevos vivos: `motor` no las poda aunque estén terminadas,
/// porque el escalado y la vuelta a Claude todavía las leen.
pub fn active_task_ids() -> std::collections::HashSet<String> {
    lock_states()
        .values()
        .flat_map(|s| s.task_ids.iter().cloned())
        .collect()
}

/// Qué hacer con el reintento de una tarea cuya sesión de OpenCode caducó.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryCheck {
    /// No es del relevo: se relanza sin más.
    NotRelay,
    /// El relevo sigue en este motor: se relanza para esta generación.
    Current(u64),
    /// El relevo se cerró o cambió de motor: no se relanza.
    Stale,
}

pub fn retry_generation(task: &EngineTask) -> RetryCheck {
    if task.kind != "relay" {
        return RetryCheck::NotRelay;
    }
    let Some(sid) = task.session_id.as_deref() else {
        return RetryCheck::Stale;
    };
    match lock_states().get(sid) {
        Some(s) if !s.closing && s.active_engine == task.engine => {
            RetryCheck::Current(s.generation)
        }
        _ => RetryCheck::Stale,
    }
}

/// Registra la tarea relanzada si su generación sigue vigente, en la misma
/// sección crítica que la comprobación; si no, la cancela.
pub fn adopt_retry(task: &EngineTask, generation: u64) {
    let Some(sid) = task.session_id.as_deref() else {
        return;
    };
    let vigente = match lock_states().get_mut(sid) {
        Some(s) if !s.closing && s.generation == generation => {
            if !s.task_ids.contains(&task.id) {
                s.task_ids.push(task.id.clone());
            }
            true
        }
        _ => false,
    };
    if vigente {
        emit_state(sid);
    } else {
        tracing::info!(sesion = sid, tarea = %task.id, "relevo cambiado durante el reintento: se cancela");
        cancel_logged(&task.id);
    }
}

/// Hora de vuelta anotada si la sesión está en pausa por el límite.
#[cfg(test)]
pub(crate) fn pausa_anotada(session_id: &str) -> Option<Option<String>> {
    limite::vuelta_anotada(session_id)
}

#[cfg(test)]
pub(crate) fn claim_for_test(session_id: &str, from: &str, to: &str) {
    claim(session_id, from, to).expect("escalado de prueba");
}

#[cfg(test)]
pub(crate) fn insert_for_test(session_id: &str, engine: &str, handoff: &str) {
    let state = RelayState {
        session_id: session_id.into(),
        active_engine: engine.into(),
        since: now_iso(),
        return_at: None,
        limit_kind: LimitKind::Session,
        task_ids: Vec::new(),
        failed_prompt: String::new(),
        error: None,
        handoff: handoff.into(),
        generation: 0,
        closing: false,
    };
    lock_states().insert(session_id.into(), state);
}

#[cfg(test)]
#[path = "tests_relevo.rs"]
mod tests;

#[cfg(test)]
#[path = "tests_relevo_limite.rs"]
mod tests_limite;
