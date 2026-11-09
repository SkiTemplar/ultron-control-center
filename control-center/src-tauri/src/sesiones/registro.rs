// sesiones/registro.rs — Registro global de sesiones vivas y salida de eventos.
//
// Cada sesión de la ventana Sesiones es un PTY (`crate::pty`) más metadatos:
// proyecto, título, id del transcript, estado y agentes notificados por el
// puente. Los eventos salen por un `Sink` intercambiable para poder probar el
// puente y el seguidor sin una app Tauri.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

use super::titulo::OrigenTitulo;
#[cfg(test)]
use super::types::SessionStatus;
use super::types::{ev, AgentNode, SessionInfo};

/// Cableado de la máquina de estados. ESTADO-B instala
/// `cableado::manejar_senal` y llama a `cableado::olvidar_sesion` y
/// `cableado::terminal_adjunta` desde el gestor.
#[path = "registro_estado.rs"]
pub mod cableado;
pub use cableado::{contexto, estado, pedir_drenaje, primer_token};

/// Etiqueta de la ventana Sesiones.
pub const WINDOW_LABEL: &str = "sesiones";

/// Destino de los eventos y consulta de si la ventana existe.
pub trait Sink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
    fn window_open(&self) -> bool;
    /// Aviso del Control Center cuando ninguna ventana de Sessions puede
    /// mostrar algo que espera al usuario (§4.1).
    fn avisar(&self, texto: &str) {
        tracing::warn!(texto, "aviso de Sesiones sin destino");
    }
}

/// ¿La ventana `label` es de ULTRON Sessions (la principal o una adicional)?
pub fn is_sessions_window(label: &str) -> bool {
    label == WINDOW_LABEL
        || label
            .strip_prefix(WINDOW_LABEL)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|rest| !rest.is_empty())
}

/// `Sink` real: emite a todas las ventanas de Sessions (cada una puede tener
/// abiertos chats distintos y todas necesitan el estado compartido).
pub struct AppSink(pub AppHandle);

impl Sink for AppSink {
    fn emit(&self, event: &str, payload: Value) {
        crate::main_watchdog::count_emit();
        let res = self.0.emit_filter(event, payload, |t| match t {
            EventTarget::WebviewWindow { label }
            | EventTarget::Window { label }
            | EventTarget::Webview { label } => is_sessions_window(label),
            _ => false,
        });
        if let Err(e) = res {
            tracing::debug!(error = %e, event, "emisión a las ventanas de Sessions fallida");
        }
    }
    fn window_open(&self) -> bool {
        self.0
            .webview_windows()
            .keys()
            .any(|l| is_sessions_window(l))
    }
    fn avisar(&self, texto: &str) {
        crate::toast_emit::record_alert_and_maybe_toast(&self.0, "sesiones", "warn", texto);
    }
}

static SINK: OnceLock<Arc<dyn Sink>> = OnceLock::new();

pub fn install(app: AppHandle) -> Arc<dyn Sink> {
    SINK.get_or_init(|| Arc::new(AppSink(app))).clone()
}

pub fn sink() -> Option<Arc<dyn Sink>> {
    SINK.get().cloned()
}

/// Emite si hay sink instalado (en tests no lo hay y es un no-op).
pub fn emit(event: &str, payload: Value) {
    if let Some(s) = sink() {
        s.emit(event, payload);
    }
}

/// Estado interno de una sesión.
pub struct Sesion {
    pub info: SessionInfo,
    pub pty_id: String,
    /// Lo fija `gestor::create`; el seguidor ya no adopta por fecha (F15).
    #[allow(
        dead_code,
        reason = "dato de diagnóstico; sin lector tras quitar newest_since"
    )]
    pub spawned_at: SystemTime,
    /// Directorio de transcripts de Claude para el cwd (`~/.claude/projects/<slug>`).
    pub slug_dir: PathBuf,
    /// Transcript principal localizado (o indicado por el puente).
    pub transcript: Option<PathBuf>,
    /// true si el transcript es definitivo (puente o escrito tras el spawn).
    pub sid_confirmed: bool,
    /// Quién puso el título (`titulo.rs`): decide qué fuente lo puede pisar.
    pub titulo: OrigenTitulo,
    /// Agentes notificados por el puente (`agentSpawn` / `agentEnd`).
    pub live_agents: HashMap<String, AgentNode>,
    /// true si la sesión se lanzó retomando o bifurcando una conversación: su
    /// transcript puede nacer con historia copiada. Una sesión nueva no: su
    /// primer prompt nunca es historia (CONTRATO-v3 §7).
    pub historia_esperada: bool,
}

type Mapa = HashMap<String, Sesion>;

fn mapa() -> &'static Mutex<Mapa> {
    static M: OnceLock<Mutex<Mapa>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> Result<std::sync::MutexGuard<'static, Mapa>, String> {
    mapa()
        .lock()
        .map_err(|_| "registro de sesiones envenenado".to_string())
}

pub fn insert(s: Sesion) -> Result<(), String> {
    let id = s.info.id.clone();
    lock()?.insert(id, s);
    emit_sessions();
    Ok(())
}

pub fn remove(id: &str) -> Option<Sesion> {
    let out = lock().ok()?.remove(id);
    if out.is_some() {
        emit_sessions();
    }
    out
}

pub fn exists(id: &str) -> bool {
    lock().map(|m| m.contains_key(id)).unwrap_or(false)
}

/// Aplica `f` a la sesión. Si `f` devuelve true se emite `sesiones://sessions`.
pub fn update<T>(id: &str, f: impl FnOnce(&mut Sesion) -> (bool, T)) -> Result<T, String> {
    let (changed, out) = {
        let mut m = lock()?;
        let s = m
            .get_mut(id)
            .ok_or_else(|| format!("no existe la sesión '{id}'"))?;
        f(s)
    };
    if changed {
        emit_sessions();
    }
    Ok(out)
}

/// Lectura sin cambios.
pub fn read<T>(id: &str, f: impl FnOnce(&Sesion) -> T) -> Result<T, String> {
    let m = lock()?;
    let s = m
        .get(id)
        .ok_or_else(|| format!("no existe la sesión '{id}'"))?;
    Ok(f(s))
}

/// Intervalo de sondeo de `esperar`.
const ESPERA_POLL: Duration = Duration::from_millis(50);

/// Espera hasta `timeout` a que `pred` se cumpla sobre la `SessionInfo` de la
/// sesión (firma congelada en la fase 0a; la usa `recover` de WP-PTY para
/// esperar `TurnoFin` o un cambio de `screen`). Devuelve false si vence el
/// plazo o la sesión no existe. El predicado se evalúa con el registro
/// bloqueado: debe ser puro y rápido.
///
/// Fase 0a: sondeo cada 50 ms; WP-ESTADO puede sustituirlo por una
/// notificación sin cambiar la firma.
#[allow(dead_code, reason = "fase 0a: lo usa WP-PTY (recover)")]
pub fn esperar(id: &str, pred: &dyn Fn(&SessionInfo) -> bool, timeout: Duration) -> bool {
    let inicio = Instant::now();
    loop {
        match read(id, |s| pred(&s.info)) {
            Ok(true) => return true,
            Ok(false) => {}
            Err(_) => return false,
        }
        let pasado = inicio.elapsed();
        if pasado >= timeout {
            return false;
        }
        std::thread::sleep(ESPERA_POLL.min(timeout - pasado));
    }
}

pub fn pty_id(id: &str) -> Result<String, String> {
    read(id, |s| s.pty_id.clone())
}

pub fn list() -> Vec<SessionInfo> {
    let mut v: Vec<SessionInfo> = lock()
        .map(|m| m.values().map(|s| s.info.clone()).collect())
        .unwrap_or_default();
    v.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    v
}

/// Si el transcript de la sesión puede traer historia copiada (sin sesión,
/// sí: es lo prudente, no reemite nada en vivo).
pub fn historia_esperada(id: &str) -> bool {
    read(id, |s| s.historia_esperada).unwrap_or(true)
}

/// Ids y datos que necesita el seguidor de transcripts en cada tick.
pub struct FollowTarget {
    pub id: String,
    pub claude_session_id: Option<String>,
    pub slug_dir: PathBuf,
    pub transcript: Option<PathBuf>,
    pub sid_confirmed: bool,
}

pub fn follow_targets() -> Vec<FollowTarget> {
    lock()
        .map(|m| {
            m.values()
                .map(|s| FollowTarget {
                    id: s.info.id.clone(),
                    claude_session_id: s.info.claude_session_id.clone(),
                    slug_dir: s.slug_dir.clone(),
                    transcript: s.transcript.clone(),
                    sid_confirmed: s.sid_confirmed,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Transcripts ya reclamados por otras sesiones (para no confundir dos
/// sesiones abiertas en el mismo cwd).
pub fn claimed_transcripts(except: &str) -> Vec<PathBuf> {
    lock()
        .map(|m| {
            m.values()
                .filter(|s| s.info.id != except)
                .filter_map(|s| s.transcript.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Paso único de todo alta, baja o cambio visible del registro: además de
/// avisar a las ventanas, marca `abiertas.json` para reescribirse
/// (`persistencia.rs`; solo escribe si cambia la proyección). La lista que
/// ven las ventanas lleva detrás las sesiones de motor abiertas
/// (`motor_sesion`), que no viven en este registro ni se persisten aquí.
pub fn emit_sessions() {
    let mut todas = list();
    todas.extend(super::motor_sesion::infos());
    if let Ok(v) = serde_json::to_value(todas) {
        emit(ev::SESSIONS, v);
    }
    super::persistencia::marcar();
}

/// Lo que `persistencia.rs` guarda de cada sesión abierta.
#[derive(Debug, Clone)]
pub struct Persistible {
    pub info: SessionInfo,
    pub transcript: Option<PathBuf>,
    pub titulo: OrigenTitulo,
}

/// Sesiones abiertas en orden de alta, con su transcript y su título
/// automático. Un registro envenenado es un error, no una lista vacía: la
/// persistencia reescribiría `abiertas.json` sin ninguna sesión.
pub fn persistibles() -> Result<Vec<Persistible>, String> {
    let mut v: Vec<Persistible> = lock()?
        .values()
        .map(|s| Persistible {
            info: s.info.clone(),
            transcript: s.transcript.clone(),
            titulo: s.titulo,
        })
        .collect();
    v.sort_by(|a, b| a.info.started_at.cmp(&b.info.started_at));
    Ok(v)
}

/// Slug que usa Claude Code para el directorio de transcripts de un cwd:
/// todo carácter no alfanumérico pasa a `-`.
pub fn claude_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

pub fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Sesión mínima para tests (sin PTY ni transcript).
#[cfg(test)]
pub fn sesion_de_prueba(id: &str) -> Sesion {
    use super::types::PermissionMode;
    Sesion {
        info: SessionInfo {
            project_name: "demo".into(),
            title: "demo".into(),
            ..SessionInfo::nueva(id, "demo", PermissionMode::Default)
        },
        pty_id: String::new(),
        spawned_at: SystemTime::now(),
        slug_dir: PathBuf::new(),
        transcript: None,
        sid_confirmed: false,
        titulo: OrigenTitulo::Provisional,
        live_agents: HashMap::new(),
        historia_esperada: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn esperar_sin_sesion_devuelve_false_al_momento() {
        let t = Instant::now();
        assert!(!esperar("no-existe", &|_| true, Duration::from_secs(5)));
        assert!(t.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn esperar_ve_el_cambio_de_estado_y_vence_si_no_llega() {
        let id = format!("esperar-{}", uuid::Uuid::new_v4());
        insert(sesion_de_prueba(&id)).expect("alta");
        let id2 = id.clone();
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let _ = update(&id2, |s| {
                s.info.status = SessionStatus::Idle;
                (true, ())
            });
        });
        let idle = |i: &SessionInfo| i.status == SessionStatus::Idle;
        assert!(esperar(&id, &idle, Duration::from_secs(5)));
        h.join().expect("hilo");
        let t = Instant::now();
        let exited = |i: &SessionInfo| i.status == SessionStatus::Exited;
        assert!(!esperar(&id, &exited, Duration::from_millis(120)));
        assert!(t.elapsed() >= Duration::from_millis(120));
        remove(&id);
    }

    #[test]
    fn slug_coincide_con_el_de_claude() {
        assert_eq!(
            claude_slug(r"C:\Users\demo\.ultron"),
            "C--Users-demo--ultron"
        );
        assert_eq!(claude_slug("/home/demo/my proj"), "-home-demo-my-proj");
    }
}
