// sesiones/gestor.rs — Operaciones sobre sesiones: crear, escribir, teclas,
// recuperar, reiniciar, matar, renombrar, historial, agentes y sesiones
// pasadas (contrato de estabilidad, §3 y §8.3 paso 5).
//
// Todo lo que se escribe en el PTY pasa por su escritor serializado (G1-G4,
// `pty/escritor.rs`). Las sesiones se lanzan con `--session-id` (o
// `--resume`) y `--permission-mode` (`lanzamiento.rs`), con el entorno
// heredado menos los secretos y con su pantalla emulada (`pantalla.rs`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;

use super::lanzamiento::{Arranque, Config};
use super::pagina::{self, HistoryPage};
use super::pantalla::{self, Monitor};
use super::preguntas::Broker;
use super::registro::{self, Sesion};
use super::senales::{self, EnvioKind, Senal};
use super::titulo::OrigenTitulo;
use super::types::{
    ev, AgentNode, KeyName, PastSession, PermissionMode, QueueItemKind, ScreenState, SessionInfo,
    SessionStatus,
};
use super::{agentes, ajustes, cola, entrada, lanzamiento, puente};
use crate::pty::escritor::{TeclaPty, Trabajo};
use crate::pty::types::bloquear;

pub const COLS: u16 = 160;
pub const ROWS: u16 = 48;
const TITLE_MAX: usize = 60;
const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub project_id: Option<String>,
    #[serde(default)]
    pub cwd: String,
    pub resume: Option<String>,
    pub model: Option<String>,
    /// `--effort` de arranque (contrato v0.2).
    #[serde(default)]
    pub effort: Option<String>,
    /// Modo de permisos de esta sesión; sustituye a
    /// `SessionPrefs.launchPermissionMode` (contrato de estabilidad, §2.5).
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    /// `/branch`: sesión nueva con `--resume <sid> --fork-session`.
    #[serde(default)]
    pub fork_from: Option<String>,
}

/// Título a partir de un prompt: primera línea, acotada.
pub fn title_from(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.chars().count() <= TITLE_MAX {
        return line.to_string();
    }
    let head: String = line.chars().take(TITLE_MAX).collect();
    format!("{}…", head.trim_end())
}

/// cwd canónico sin el prefijo `\\?\` (el mismo que verá `claude`).
fn canonical_dir(cwd: &str) -> Result<String, String> {
    // Un UNC no funcionaba de todos modos: quitar `\\?\` de `\\?\UNC\host\s`
    // dejaba la ruta relativa `UNC\host\s`. Se rechaza con su motivo y antes de
    // abrir una conexión SMB; una unidad de red con letra sigue valiendo.
    if super::archivos::es_ruta_de_red(cwd) {
        return Err(super::archivos::ERROR_RUTA_DE_RED.to_string());
    }
    let p = Path::new(cwd.trim());
    if cwd.trim().is_empty() || !p.is_dir() {
        return Err(format!("el directorio de trabajo no existe: '{cwd}'"));
    }
    let c = std::fs::canonicalize(p).map_err(|e| format!("no se pudo resolver el cwd: {e}"))?;
    Ok(c.to_string_lossy().trim_start_matches(r"\\?\").to_string())
}

fn norm_path(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// (id, nombre, ruta) de un proyecto.
pub(super) type Proyecto = (String, String, Option<String>);

/// Proyecto por id o por ruta.
pub(super) fn find_project(project_id: Option<&str>, cwd: &str) -> Option<Proyecto> {
    let projects = crate::projects::list_projects_inner().ok()?;
    let p = match project_id {
        Some(id) => projects.into_iter().find(|p| p.id == id)?,
        None => projects
            .into_iter()
            .find(|p| p.path.as_deref().map(norm_path) == Some(norm_path(cwd)))?,
    };
    let name = p.name.clone().unwrap_or_else(|| p.id.clone());
    Some((p.id, name, p.path))
}

pub(super) fn folder_name(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| cwd.to_string())
}

/// Arranque de la conversación según la petición (nueva, reanudada o
/// bifurcada); el sid nuevo lo genera ULTRON (`--session-id`).
pub fn arranque_de(req: &CreateRequest) -> Arranque {
    let nuevo = || uuid::Uuid::new_v4().to_string();
    match (
        req.fork_from.as_deref().filter(|f| !f.is_empty()),
        req.resume.as_deref().filter(|r| !r.is_empty()),
    ) {
        (Some(desde), _) => Arranque::Bifurcar {
            desde: desde.to_string(),
            sid: nuevo(),
        },
        (None, Some(r)) => Arranque::Reanudar { sid: r.to_string() },
        (None, None) => Arranque::Nueva { sid: nuevo() },
    }
}

/// (proyecto, cwd canónico) de la petición.
pub(super) fn resolver_cwd(req: &CreateRequest) -> Result<(Option<Proyecto>, String), String> {
    let project = match req.project_id.as_deref() {
        Some(id) => Some(
            find_project(Some(id), "").ok_or_else(|| format!("no existe el proyecto '{id}'"))?,
        ),
        None => None,
    };
    let raw_cwd = if req.cwd.trim().is_empty() {
        project
            .as_ref()
            .and_then(|p| p.2.clone())
            .ok_or_else(|| "falta el directorio de trabajo".to_string())?
    } else {
        req.cwd.clone()
    };
    let cwd = canonical_dir(&raw_cwd)?;
    let project = project.or_else(|| find_project(None, &cwd));
    Ok((project, cwd))
}

/// Sesión de ULTRON que ya tiene la conversación que se pide retomar. Dos
/// procesos `claude` sobre el mismo `<sid>.jsonl` intercalan sus escrituras y
/// corrompen el transcript. Solo aplica a `Reanudar`: una sesión nueva o
/// bifurcada estrena sid (la bifurcación solo lee el original).
pub fn conversacion_abierta<'a>(
    abiertas: &'a [SessionInfo],
    arranque: &Arranque,
) -> Option<&'a SessionInfo> {
    let Arranque::Reanudar { sid } = arranque else {
        return None;
    };
    abiertas.iter().find(|s| {
        s.claude_session_id
            .as_deref()
            .is_some_and(|c| c.eq_ignore_ascii_case(sid))
    })
}

/// Mensaje de `sesiones_create` al retomar una conversación ya abierta.
pub fn error_conversacion_abierta(s: &SessionInfo) -> String {
    let sid: String = s
        .claude_session_id
        .as_deref()
        .unwrap_or_default()
        .chars()
        .take(8)
        .collect();
    let que_hacer = if s.status == SessionStatus::Exited {
        "está terminada: usa Reiniciar en ella o ciérrala antes de retomarla"
    } else {
        "cámbiate a ella en vez de retomarla otra vez"
    };
    format!(
        "La conversación {sid} ya está abierta en la sesión «{}»; {que_hacer}. \
         Dos procesos de claude sobre el mismo transcript lo corrompen.",
        s.title
    )
}

/// Err si la conversación que se pide retomar ya está en el registro.
pub(super) fn comprobar_reanudacion(arranque: &Arranque) -> Result<(), String> {
    match conversacion_abierta(&registro::list(), arranque) {
        Some(s) => Err(error_conversacion_abierta(s)),
        None => Ok(()),
    }
}

/// Serializa la comprobación de `conversacion_abierta` con el alta en el
/// registro: dos «Retomar» simultáneos de la misma conversación no pasan
/// los dos.
pub(super) fn alta() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

pub fn create(app: AppHandle, req: CreateRequest) -> Result<SessionInfo, String> {
    let (project, cwd) = resolver_cwd(&req)?;
    let id = uuid::Uuid::new_v4().to_string();
    let arranque = arranque_de(&req);
    let en_alta = bloquear(alta());
    comprobar_reanudacion(&arranque)?;
    let cfg = config_de(&req, project.as_ref(), &cwd, &id);
    // Valida los argumentos antes de registrar nada.
    if let Err(e) = lanzamiento::build(&cfg, &arranque) {
        lanzamiento::borrar_settings(&id);
        return Err(e);
    }
    registrar(&id, project.as_ref(), &cfg, &arranque)?;
    drop(en_alta);
    if let Err(e) = lanzar_pty(app, &id, &cfg, &arranque) {
        registro::remove(&id);
        pantalla::olvidar(&id);
        lanzamiento::borrar_settings(&id);
        return Err(format!("no se pudo lanzar claude: {e}"));
    }
    lanzamiento::tocar_proyecto(cfg.project_id.as_deref());
    guardar_lanzamiento(&id, cfg);
    entrada::spawn_watcher(id.clone());
    registro::read(&id, |s| s.info.clone())
}

/// Guarda la configuración del último lanzamiento (para `restart`) y los
/// metadatos que lee `ajustes::settings`. `skip_permissions` refleja el modo
/// efectivo (bypass por `--permission-mode`), no `claude_safe_mode`.
pub(super) fn guardar_lanzamiento(id: &str, cfg: Config) {
    ajustes::record_launch(
        id,
        ajustes::LaunchMeta {
            skip_permissions: cfg.permission_mode == PermissionMode::BypassPermissions,
            settings_file: cfg.settings_file.clone(),
            effort: cfg.effort.clone(),
        },
    );
    lanzamiento::guardar(id, cfg);
}

/// Configuración del lanzamiento: lo de la petición y, si falta, las prefs.
/// Escribe los settings de la sesión (tema del proyecto fusionado).
fn config_de(req: &CreateRequest, project: Option<&Proyecto>, cwd: &str, id: &str) -> Config {
    let prefs = ajustes::prefs_actuales();
    Config {
        cwd: cwd.to_string(),
        project_id: project.map(|p| p.0.clone()),
        model: req.model.clone().or(prefs.launch_model.clone()),
        effort: req.effort.clone().or(prefs.launch_effort.clone()),
        permission_mode: lanzamiento::modo_lanzamiento(req.permission_mode, &prefs),
        settings_file: settings_de(id, project, cwd),
    }
}

/// Escribe los settings de lanzamiento de la sesión con el tema de su
/// proyecto (o del cwd) y devuelve su ruta.
pub(super) fn settings_de(id: &str, project: Option<&Proyecto>, cwd: &str) -> Option<String> {
    let theme_cwd = project
        .and_then(|p| p.2.clone())
        .unwrap_or_else(|| cwd.to_string());
    let tema = crate::sessions::project_theme_for_cwd(&theme_cwd);
    lanzamiento::escribir_settings(id, tema.as_deref())
}

/// Alta en el registro con el transcript ya fijado (`<slug>/<sid>.jsonl`):
/// nunca se adopta un transcript ajeno por fecha (AC-9).
pub(super) fn registrar(
    id: &str,
    project: Option<&Proyecto>,
    cfg: &Config,
    arranque: &Arranque,
) -> Result<(), String> {
    let slug_dir = registro::claude_projects_dir()
        .ok_or_else(|| "no hay directorio personal".to_string())?
        .join(registro::claude_slug(&cfg.cwd));
    let sid = arranque.sid().to_string();
    let corto = |x: &str| x.chars().take(8).collect::<String>();
    let title = match arranque {
        Arranque::Nueva { .. } => "Nueva sesión".to_string(),
        Arranque::Reanudar { sid } => format!("Reanudada {}", corto(sid)),
        Arranque::Bifurcar { desde, .. } => format!("Rama de {}", corto(desde)),
    };
    let info = info_inicial(id, project, &cfg.cwd, title, &sid, cfg.permission_mode);
    registro::insert(Sesion {
        info,
        pty_id: String::new(),
        spawned_at: SystemTime::now(),
        transcript: Some(slug_dir.join(format!("{sid}.jsonl"))),
        sid_confirmed: true,
        slug_dir,
        titulo: OrigenTitulo::Provisional,
        live_agents: HashMap::new(),
        historia_esperada: !matches!(arranque, Arranque::Nueva { .. }),
    })
}

fn info_inicial(
    id: &str,
    project: Option<&Proyecto>,
    cwd: &str,
    title: String,
    sid: &str,
    modo: PermissionMode,
) -> SessionInfo {
    SessionInfo {
        project_id: project.map(|p| p.0.clone()),
        project_name: project.map_or_else(|| folder_name(cwd), |p| p.1.clone()),
        title,
        claude_session_id: Some(sid.to_string()),
        ..SessionInfo::nueva(id, cwd, modo)
    }
}

/// Lanza el PTY de la sesión `id` con su pantalla emulada y fija su
/// `pty_id`. Lo usan `create` y `restart`.
pub(super) fn lanzar_pty(
    app: AppHandle,
    id: &str,
    cfg: &Config,
    arranque: &Arranque,
) -> Result<(), String> {
    let args = lanzamiento::build(cfg, arranque)?;
    let env = entorno(id);
    let monitor = Arc::new(Monitor::nuevo(ROWS, COLS));
    pantalla::registrar(id, monitor.clone());
    let m_out = monitor.clone();
    let mio: Arc<OnceLock<String>> = Arc::new(OnceLock::new());
    let mio_exit = mio.clone();
    let id_exit = id.to_string();
    let opts = crate::pty::SpawnOptions {
        project_id: cfg.project_id.clone().unwrap_or_default(),
        card_id: None,
        provider: "claude".into(),
        agent: None,
        cwd: cfg.cwd.clone(),
        cols: COLS,
        rows: ROWS,
        extra_args: args,
        extra_env: env,
        env_excluir: lanzamiento::claves_excluidas(std::env::vars().map(|(k, _)| k)),
        live_event: Some(ev::pty(id)),
        on_exit: Some(Box::new(move |code| {
            on_exit(&id_exit, mio_exit.get().map(String::as_str), code);
        })),
        on_output: Some(Box::new(move |b| m_out.alimentar(b))),
        vista: Some(Arc::new(move || monitor.vista())),
    };
    let pty_id = crate::pty::spawn_with(app, opts)?;
    let _ = mio.set(pty_id.clone());
    tracing::info!(sesion = id, pty = %pty_id, modo = ?cfg.permission_mode, "sesión lanzada");
    registro::update(id, |s| {
        s.pty_id = pty_id;
        s.info.launch_permission_mode = cfg.permission_mode;
        s.info.exit_code = None;
        (true, ())
    })
}

/// Token del puente para un lanzamiento nuevo de la sesión: revoca el del
/// lanzamiento anterior antes de emitir otro (hallazgo #17c). Un proceso que
/// sobreviva al PTY anterior se queda sin autenticación.
pub(super) fn token_relanzamiento(id: &str) -> Option<String> {
    puente::revocar_token(id);
    puente::token_sesion(id)
}

/// Variables propias de la sesión: id, integración y puente (token por
/// sesión, rotado en cada lanzamiento).
fn entorno(id: &str) -> Vec<(String, String)> {
    let mut env = vec![
        ("ULTRON_SESION_ID".to_string(), id.to_string()),
        ("ULTRON_SESIONES".to_string(), "1".to_string()),
    ];
    match (puente::info(), token_relanzamiento(id)) {
        (Some(p), Some(token)) => {
            env.push(("ULTRON_PUENTE_URL".into(), p.url));
            env.push(("ULTRON_PUENTE_TOKEN".into(), token));
        }
        _ => tracing::warn!("puente de Sesiones no disponible: la sesión irá sin él"),
    }
    env
}

/// Sesiones con un reinicio en curso (su `ProcesoSalio` no las pasa a exited).
pub(super) fn reiniciando() -> &'static Mutex<HashSet<String>> {
    static M: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashSet::new()))
}

/// true si la salida del PTY `pty` es la del proceso actual de la sesión
/// (`actual`). Una salida antes de fijar el `pty_id`, o sin saber el PTY,
/// cuenta como vigente.
pub fn salida_vigente(actual: &str, pty: Option<&str>) -> bool {
    pty.is_none_or(|p| actual.is_empty() || p == actual)
}

/// Salida del proceso de la sesión. La de un PTY anterior (ya sustituido por
/// un reinicio) solo se registra.
fn on_exit(id: &str, pty: Option<&str>, code: i32) {
    let actual = registro::pty_id(id).unwrap_or_default();
    if !salida_vigente(&actual, pty) {
        tracing::info!(sesion = id, code, "salida de un PTY anterior al reinicio");
        return;
    }
    let reinicio = bloquear(reiniciando()).contains(id);
    tracing::info!(
        sesion = id,
        code,
        reinicio,
        "proceso de la sesión terminado"
    );
    if !senales::hay_manejador() {
        entrada::reserva_salida(id, code, reinicio);
        if !reinicio {
            if let Some(sink) = registro::sink() {
                Broker::global().cancel(&*sink, Some(id));
            }
        }
    }
    senales::emitir(id, Senal::ProcesoSalio { code });
}

/// Bytes del pegado: `ESC[200~` + texto + ` @"ruta"` por adjunto + `ESC[201~`.
/// Se quitan del texto los caracteres de control salvo `\n` y `\t` (un ESC
/// podría cerrar el pegado; `seguridad-robustez:F14`).
pub fn paste_bytes(text: &str, attachments: &[String]) -> Result<Vec<u8>, String> {
    let clean: String = text
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect();
    if clean.trim().is_empty() && attachments.is_empty() {
        return Err("no hay nada que enviar".to_string());
    }
    let mut out = PASTE_START.to_vec();
    out.extend_from_slice(clean.as_bytes());
    for a in attachments {
        if a.is_empty() || a.contains('"') || a.chars().any(char::is_control) {
            return Err(format!("ruta de adjunto no válida: '{a}'"));
        }
        out.extend_from_slice(format!(" @\"{a}\"").as_bytes());
    }
    out.extend_from_slice(PASTE_END);
    Ok(out)
}

/// Escritor de la cola (§3): cada elemento drenado se escribe como un envío
/// completo por el PTY, con su `clientId` para emparejarlo después.
pub struct EscritorPty;

impl cola::Escritor for EscritorPty {
    fn escribir(&self, id: &str, envio: &cola::Envio) -> Result<(), String> {
        let kind = match envio.kind {
            QueueItemKind::Prompt => EnvioKind::Prompt,
            QueueItemKind::Bash => EnvioKind::Bash,
            QueueItemKind::Command => EnvioKind::Comando {
                nombre: envio.texto.clone(),
            },
        };
        send_envio(id, &envio.texto, &envio.adjuntos, &envio.client_id, kind)
    }
}

/// Envío desde el chat como prompt (compatibilidad: `comandos::sesiones_send`
/// y `motor::bring` lo llaman con tres argumentos).
pub fn send(id: &str, text: &str, attachments: &[String]) -> Result<(), String> {
    let client_id = uuid::Uuid::new_v4().to_string();
    send_envio(id, text, attachments, &client_id, EnvioKind::Prompt)
}

/// Envío completo (§8.3 paso 5): pegado + Enter por el escritor (G3), y
/// `Senal::EnvioEscrito` al terminar.
pub fn send_envio(
    id: &str,
    text: &str,
    attachments: &[String],
    client_id: &str,
    kind: EnvioKind,
) -> Result<(), String> {
    for a in attachments {
        if !Path::new(a).is_absolute() || !Path::new(a).is_file() {
            return Err(format!("el adjunto no existe: '{a}'"));
        }
    }
    let bytes = paste_bytes(text, attachments)?;
    escribir_pegado(id, bytes, Some(client_id))?;
    vigilar_enter(id, text);
    if !senales::hay_manejador() {
        entrada::reserva_envio(id);
    }
    let kind_titulo = kind.clone();
    senales::emitir(
        id,
        Senal::EnvioEscrito {
            client_id: client_id.to_string(),
            kind,
            texto: text.to_string(),
        },
    );
    // El título provisional sale del primer prompt, nunca de un `/comando`
    // ni de un `!bash`; el resumen de Claude Code lo sustituye al llegar.
    let title = if matches!(kind_titulo, EnvioKind::Prompt) {
        title_from(text)
    } else {
        String::new()
    };
    registro::update(id, |s| {
        let cambia = s.titulo.acepta_prompt() && !title.is_empty();
        if cambia {
            s.info.title = title;
            s.titulo = OrigenTitulo::Prompt;
        }
        (cambia, ())
    })
}

/// Tecla de `sesiones_key` (§3.2): Esc y Ctrl+C solo por `sesiones_recover`.
pub fn tecla_de(k: KeyName) -> TeclaPty {
    match k {
        KeyName::ShiftTab => TeclaPty::ShiftTab,
        KeyName::Up => TeclaPty::Arriba,
        KeyName::Down => TeclaPty::Abajo,
        KeyName::Enter => TeclaPty::Enter,
        KeyName::Tab => TeclaPty::Tab,
    }
}

pub fn key(id: &str, key: KeyName) -> Result<(), String> {
    let t = Trabajo::Tecla(tecla_de(key));
    crate::pty::io::enviar(&registro::pty_id(id)?, t).map_err(String::from)
}

/// Entrada de la terminal en superposición o del bloque de menú del chat
/// (§3.2): exenta de G1-G3, solo con la terminal enganchada o con un menú en
/// pantalla.
pub fn terminal_input(id: &str, data: &str) -> Result<(), String> {
    if data.is_empty() || data.len() > 4096 {
        return Err("'data' vacío o de más de 4096 bytes".to_string());
    }
    let pty = registro::pty_id(id)?;
    let menu = matches!(
        pantalla::actual(id).estado,
        ScreenState::Dialog | ScreenState::Trust
    );
    if !crate::pty::io::attached(&pty) && !menu {
        return Err("la terminal no está adjunta y no hay ningún menú abierto".to_string());
    }
    crate::pty::io::enviar(&pty, Trabajo::Exento(data.as_bytes().to_vec())).map_err(String::from)
}

pub fn kill(id: &str) -> Result<(), String> {
    if super::motor_sesion::existe(id) {
        return super::motor_sesion::kill(id);
    }
    let pty_id = registro::pty_id(id)?;
    // Primero el relevo: un motor cancelado después no puede escalar, y uno con
    // acceso total no sigue editando el repo sin sesión ni panel que lo muestre.
    super::relevo::forget_session(id);
    super::motor::cancelar_de_sesion(id);
    if !pty_id.is_empty() {
        // `/exit` con plazo antes de matar: sin salida ordenada, Claude no
        // dispara los hooks de SessionEnd (gestor_cierre.rs).
        cierre::cerrar_en_segundo_plano(id, pty_id);
    }
    registro::cableado::cerrar_estado(id);
    ajustes::forget(id);
    pantalla::olvidar(id);
    lanzamiento::olvidar(id);
    super::persistencia::olvidar_avisos(id);
    Ok(())
}

pub fn rename(id: &str, title: &str) -> Result<(), String> {
    let t = title.trim();
    if t.is_empty() || t.chars().count() > 200 {
        return Err("el título debe tener entre 1 y 200 caracteres".to_string());
    }
    if super::motor_sesion::existe(id) {
        return super::motor_sesion::rename(id, t);
    }
    registro::update(id, |s| {
        s.info.title = t.to_string();
        s.titulo = OrigenTitulo::Manual;
        (true, ())
    })
}

fn valid_agent_id(a: &str) -> bool {
    !a.is_empty()
        && a.len() <= 64
        && a.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// (transcript, directorio de subagentes) de la sesión.
fn paths(id: &str) -> Result<(Option<PathBuf>, Option<PathBuf>), String> {
    registro::read(id, |s| {
        let sub = s
            .info
            .claude_session_id
            .as_ref()
            .map(|sid| agentes::subagents_dir(&s.slug_dir, sid));
        (s.transcript.clone(), sub)
    })
}

/// Página del historial (CONTRATO-v3 §7) del hilo principal o de un
/// subagente.
pub fn history(
    id: &str,
    agent_id: Option<&str>,
    before_uuid: Option<&str>,
    limit: Option<usize>,
) -> Result<HistoryPage, String> {
    if super::motor_sesion::get(id).is_ok() {
        return super::motor_vivo::history(id, before_uuid, limit);
    }
    let (main, sub) = paths(id)?;
    if agent_id.is_none() && before_uuid.is_none() {
        // Primera página del hilo: la ventana ya escucha, así que es el
        // momento de entregar las notas de la restauración (#35).
        super::persistencia::entregar_avisos(id);
    }
    let path = match agent_id {
        None => main,
        Some(a) if valid_agent_id(a) => sub.map(|d| agentes::agent_file(&d, a)),
        Some(a) => return Err(format!("id de agente no válido: '{a}'")),
    };
    pagina::leer(path.as_deref(), agent_id, before_uuid, limit)
}

/// Ficheros editados en el turno que empezó en `since` (ISO 8601), según el
/// transcript de la sesión y los de sus subagentes.
pub fn ediciones_turno(id: &str, since: &str) -> Result<Vec<String>, String> {
    let desde = chrono::DateTime::parse_from_rfc3339(since)
        .map_err(|e| format!("inicio de turno no válido '{since}': {e}"))?
        .with_timezone(&chrono::Utc);
    let (main, sub) = paths(id)?;
    Ok(super::ediciones_turno::editados(
        main.as_deref(),
        sub.as_deref(),
        desde,
    ))
}

/// Árbol de subagentes leyendo el disco (al abrir o reanudar la sesión).
pub fn agents(id: &str) -> Result<Vec<AgentNode>, String> {
    let (_, sub) = paths(id)?;
    let disk = sub.map(|d| agentes::scan(&d)).unwrap_or_default();
    let live = registro::read(id, |s| s.live_agents.clone())?;
    Ok(agentes::merge(disk, &live))
}

/// Emite el árbol en vivo con los nodos que mantiene el seguidor, sin
/// releer los JSONL de subagentes en cada cambio de estado.
pub fn emit_agents(id: &str) {
    let Ok(live) = registro::read(id, |s| s.live_agents.clone()) else {
        return;
    };
    let a = agentes::merge(agentes::nodos_en_cache(id), &live);
    registro::emit(ev::AGENTS, json!({ "id": id, "agents": a }));
}

pub fn past(project_id: Option<&str>, limit: Option<usize>) -> Result<Vec<PastSession>, String> {
    let filter_path = match project_id {
        Some(pid) => Some(
            find_project(Some(pid), "")
                .and_then(|p| p.2)
                .ok_or_else(|| format!("el proyecto '{pid}' no existe o no tiene ruta"))?,
        ),
        None => None,
    };
    let live: Vec<String> = registro::list()
        .into_iter()
        .filter_map(|s| s.claude_session_id)
        .collect();
    let projects = crate::projects::list_projects_inner().unwrap_or_default();
    let name_for = |cwd: &str| {
        projects
            .iter()
            .find(|p| p.path.as_deref().map(norm_path) == Some(norm_path(cwd)))
            .map_or_else(
                || folder_name(cwd),
                |p| p.name.clone().unwrap_or_else(|| p.id.clone()),
            )
    };
    // El filtro va antes del corte: solo se lee la vista previa de las
    // sesiones que se van a mostrar (antes se leían los 917 transcripts).
    let keep = |id: &str, cwd: &str| {
        !live.iter().any(|l| l == id)
            && filter_path
                .as_deref()
                .is_none_or(|fp| norm_path(fp) == norm_path(cwd))
    };
    let out = crate::claude_sessions::list_claude_sessions_light_where(
        Some(limit.unwrap_or(50).min(500)),
        keep,
    )?
    .into_iter()
    .map(|s| PastSession {
        project_name: name_for(&s.project_label),
        claude_session_id: s.id,
        cwd: s.project_label,
        preview: s.preview.unwrap_or_default(),
        last_activity: s.last_activity.unwrap_or_default(),
    })
    .collect();
    Ok(out)
}

/// Sesiones de Claude y, detrás, las de motor abiertas (`motor_sesion`).
pub fn list() -> Vec<SessionInfo> {
    let mut v = registro::list();
    v.extend(super::motor_sesion::infos());
    v
}

#[path = "gestor_pegado.rs"]
mod pegado;

#[path = "gestor_cierre.rs"]
mod cierre;
pub use pegado::escribir_pegado;
use pegado::vigilar_enter;

#[cfg(test)]
#[path = "tests_gestor.rs"]
mod tests;
