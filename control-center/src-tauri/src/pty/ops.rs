// pty/ops.rs — Lanzamiento de un PTY y su hilo lector.
//
// `spawn_with` admite tamaño, argumentos y entorno, evento en vivo,
// callback de salida, alimentación de la pantalla (`on_output`) y la vista
// que consulta el escritor (G2/G3). El núcleo, `lanzar`, no depende de Tauri
// para poder probarlo con un `CommandBuilder` cualquiera.

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Runtime};

use super::arbol::Arbol;
use super::escritor::{Escritor, FuenteVista, Trabajo, Vista};
use super::registry::{self, new_ulid};
use super::salida::{self, OnExit};
use super::spawn::{
    build_command, log_pty_failure, resolve_cwd, strip_api_key_for_claude, strip_private_vars,
};
use super::types::{bloquear, PtySession, PtyStatus, Salida, PTY_REPLAY_BUFFER_MAX};

/// Destino de los eventos del PTY (la app en producción, un espía en tests).
pub type Emisor = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;
/// Recibe cada bloque de salida en el hilo lector, fuera de todo lock.
pub type FnSalida = dyn Fn(&[u8]) + Send + 'static;
pub type OnOutput = Box<FnSalida>;

/// Opciones completas de lanzamiento de un PTY.
pub struct SpawnOptions {
    pub project_id: String,
    pub card_id: Option<String>,
    pub provider: String,
    pub agent: Option<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    /// Argumentos añadidos tras el comando base (ya validados por el llamador:
    /// en Windows pasan por `cmd.exe /C`).
    pub extra_args: Vec<String>,
    /// Variables de entorno añadidas tras heredar el entorno del proceso.
    pub extra_env: Vec<(String, String)>,
    /// Variables heredadas que el hijo no debe recibir (secretos).
    pub env_excluir: Vec<String>,
    /// Evento de emisión en vivo (ver `PtySession::live_event`).
    pub live_event: Option<String>,
    pub on_exit: Option<OnExit>,
    pub on_output: Option<OnOutput>,
    /// Pantalla actual para G2/G3 del escritor; sin ella, `Unknown`.
    pub vista: Option<FuenteVista>,
}

/// true si hay que añadir la bandera de saltarse permisos: solo `claude`,
/// sin `--permission-mode` explícito y con `claude_safe_mode` desactivado.
/// Hoy no se da nunca: el único llamante (Sessions) pasa siempre
/// `--permission-mode`; el llamante sin él era el RunBatch del kanban,
/// retirado el 2026-10-17.
pub(super) fn anadir_bandera_skip(provider: &str, args: &[String], safe_mode: bool) -> bool {
    provider == "claude" && !safe_mode && !args.iter().any(|a| a == "--permission-mode")
}

pub(super) fn construir(opts: &SpawnOptions) -> Result<(CommandBuilder, String), String> {
    let mut cmd = build_command(&opts.provider, opts.agent.as_deref()).map_err(|e| {
        log_pty_failure(&opts.provider, &opts.cwd, &format!("build_command: {e}"));
        e
    })?;
    let safe_mode = crate::features::read_features_inner().claude_safe_mode;
    if anadir_bandera_skip(&opts.provider, &opts.extra_args, safe_mode) {
        cmd.arg("--dangerously-skip-permissions");
    }
    for a in &opts.extra_args {
        cmd.arg(a);
    }
    let resolved_cwd = resolve_cwd(&opts.cwd);
    cmd.cwd(&resolved_cwd);
    // Hereda el entorno para que OAuth y PATH lleguen al hijo.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    // El bucle anterior volvía a meter ANTHROPIC_API_KEY después de que
    // `build_command` la quitara: se vuelve a quitar aquí, tras heredar.
    strip_api_key_for_claude(&mut cmd, &opts.provider);
    strip_private_vars(&mut cmd);
    for k in &opts.env_excluir {
        cmd.env_remove(k);
    }
    // TERM/COLORTERM para que las TUIs pinten cajas y color de 24 bits.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (k, v) in &opts.extra_env {
        cmd.env(k, v);
    }
    Ok((cmd, resolved_cwd))
}

pub fn spawn_with<R: Runtime>(app: AppHandle<R>, mut opts: SpawnOptions) -> Result<String, String> {
    let (cmd, cwd) = construir(&opts)?;
    let id = new_ulid();
    let on_exit = notificar_salida(app.clone(), id.clone(), opts.on_exit.take());
    let emisor: Emisor = Arc::new(move |ev, payload| {
        crate::main_watchdog::count_emit();
        if let Err(e) = app.emit(ev, payload) {
            tracing::debug!(error = %e, ev, "emisión del PTY fallida");
        }
    });
    let l = Lanzamiento {
        id,
        provider: opts.provider.clone(),
        cols: opts.cols,
        rows: opts.rows,
        live_event: opts.live_event.take(),
        on_exit,
        on_output: opts.on_output.take(),
        vista: opts.vista.take(),
    };
    tracing::info!(
        pty = %l.id,
        provider = %l.provider,
        proyecto = %opts.project_id,
        tarjeta = ?opts.card_id,
        "lanzando PTY"
    );
    lanzar(cmd, l, emisor).inspect_err(|e| log_pty_failure(&opts.provider, &cwd, e))
}

/// Envuelve `on_exit` con la alerta de sesión terminada con error
/// (card-vis-notif-session-error).
fn notificar_salida<R: Runtime>(app: AppHandle<R>, id: String, cb: Option<OnExit>) -> OnExit {
    Box::new(move |code| {
        if let Some(cb) = cb {
            cb(code);
        }
        let enabled = crate::features::read_features_inner().errors_immediate_notify;
        if should_notify_session_error(code, enabled) {
            crate::toast_emit::record_alert_and_maybe_toast(
                &app,
                &format!("session:{id}"),
                "critical",
                &format!("La sesion termino con error (codigo {code})"),
            );
        }
    })
}

/// Datos de un lanzamiento ya resuelto.
pub(crate) struct Lanzamiento {
    pub id: String,
    pub provider: String,
    pub cols: u16,
    pub rows: u16,
    pub live_event: Option<String>,
    pub on_exit: OnExit,
    pub on_output: Option<OnOutput>,
    pub vista: Option<FuenteVista>,
}

/// Abre la pseudoconsola, lanza `cmd`, registra la sesión y arranca el
/// escritor, el lector y el esperador.
pub(crate) fn lanzar(
    cmd: CommandBuilder,
    l: Lanzamiento,
    emisor: Emisor,
) -> Result<String, String> {
    let (child, master) = abrir(cmd, &l)?;
    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;
    let fuente: FuenteVista = l
        .vista
        .unwrap_or_else(|| -> FuenteVista { Arc::new(Vista::default) });
    let escritor =
        Escritor::lanzar(&l.id, writer, fuente).map_err(|e| format!("hilo escritor: {e}"))?;
    let s = Arc::new(PtySession {
        id: l.id.clone(),
        provider: l.provider,
        estado: Mutex::new(PtyStatus::Running),
        salida: Mutex::new(Salida {
            buffer: Vec::with_capacity(8 * 1024),
            subscribed: false,
        }),
        live_event: l.live_event,
        escritor,
        master: Mutex::new(Some(master)),
        killer: Mutex::new(Some(child.clone_killer())),
        arbol: Mutex::new(Some(Arbol::crear(child.process_id()))),
    });
    registry::insert(s.clone());
    let s_lector = s.clone();
    let on_output = l.on_output;
    let emisor2 = emisor.clone();
    thread::Builder::new()
        .name(format!("pty-lector-{}", l.id))
        .spawn(move || reader_loop(&s_lector, reader, on_output.as_deref(), &emisor2))
        .map_err(|e| format!("hilo lector: {e}"))?;
    salida::lanzar_esperador(s, child, con_evento_de_salida(&l.id, l.on_exit, emisor))
        .map_err(|e| format!("hilo esperador: {e}"))?;
    tracing::info!(pty = %l.id, "PTY lanzado");
    Ok(l.id)
}

type Hijo = Box<dyn portable_pty::Child + Send + Sync>;
type Maestro = Box<dyn portable_pty::MasterPty + Send>;

/// Abre la pseudoconsola y lanza `cmd` en ella.
fn abrir(cmd: CommandBuilder, l: &Lanzamiento) -> Result<(Hijo, Maestro), String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: l.rows,
            cols: l.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {}: {e}", l.provider))?;
    drop(pair.slave); // el hijo lo conserva
    Ok((child, pair.master))
}

/// `on_exit` precedido del evento histórico `pty:exit:<id>`.
fn con_evento_de_salida(id: &str, user_exit: OnExit, emisor: Emisor) -> OnExit {
    let id = id.to_string();
    Box::new(move |code| {
        emisor(
            &format!("pty:exit:{id}"),
            serde_json::json!({ "exit_code": code }),
        );
        user_exit(code);
    })
}

/// Hilo lector: entrega cada bloque a `on_output`, lo acumula en el búfer
/// circular y, con la terminal enganchada, lo emite en vivo. El EOF ya no es
/// la señal de salida (la da el esperador, `salida.rs`).
fn reader_loop(
    s: &PtySession,
    mut reader: Box<dyn Read + Send>,
    on_output: Option<&FnSalida>,
    emisor: &Emisor,
) {
    let mut buf = [0u8; 4096];
    let engine = base64::engine::general_purpose::STANDARD;
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                tracing::debug!(pty = %s.id, error = %e, "lectura del PTY terminada");
                break;
            }
        };
        let slice = &buf[..n];
        if let Some(f) = on_output {
            f(slice);
        }
        if let Some(target) = capture_chunk(s, slice) {
            let chunk = engine.encode(slice);
            match target {
                Some(event) => emisor(&event, serde_json::Value::String(chunk)),
                None => emisor(
                    &format!("pty:data:{}", s.id),
                    serde_json::json!({ "data": chunk }),
                ),
            }
        }
    }
    tracing::debug!(pty = %s.id, "lector del PTY terminado (EOF)");
}

/// Consulta de posición del cursor (DSR) que ConPTY emite al arrancar.
const CURSOR_QUERY: &[u8] = b"\x1b[6n";
/// Respuesta neutra: el cursor en la esquina superior izquierda.
const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";

/// Quita del búfer la primera consulta DSR que empiece en `from` o después
/// (cubre una secuencia partida entre dos lecturas). Devuelve si la había.
pub(super) fn take_cursor_query(buf: &mut Vec<u8>, from: usize) -> bool {
    let start = from.saturating_sub(CURSOR_QUERY.len() - 1);
    let Some(pos) = buf.get(start..).and_then(|tail| {
        tail.windows(CURSOR_QUERY.len())
            .position(|w| w == CURSOR_QUERY)
    }) else {
        return false;
    };
    let at = start + pos;
    buf.drain(at..at + CURSOR_QUERY.len());
    true
}

/// Añade `slice` al búfer circular. Devuelve `Some(evento)` si hay que emitir
/// (`Some(None)` = formato histórico) o `None` si no hay terminal enganchado.
///
/// portable-pty crea la ConPTY con `PSEUDOCONSOLE_INHERIT_CURSOR`: conhost
/// pide la posición del cursor y no lanza el proceso hasta recibirla. Con un
/// xterm enganchado responde él; sin terminal (chat de Sesiones) se
/// responde aquí, por el escritor como trabajo exento, y la consulta sale del
/// búfer para que un xterm que se enganche después no la conteste otra vez.
fn capture_chunk(s: &PtySession, slice: &[u8]) -> Option<Option<String>> {
    let mut sal = bloquear(&s.salida);
    let before = sal.buffer.len();
    sal.buffer.extend_from_slice(slice);
    if !sal.subscribed && take_cursor_query(&mut sal.buffer, before) {
        s.escritor.encargar(Trabajo::Exento(CURSOR_REPLY.to_vec()));
    }
    if sal.buffer.len() > PTY_REPLAY_BUFFER_MAX {
        let drop_n = sal.buffer.len() - PTY_REPLAY_BUFFER_MAX;
        sal.buffer.drain(0..drop_n);
    }
    sal.subscribed.then(|| s.live_event.clone())
}

/// Whether a PTY exit warrants an error notification. Only genuine non-zero
/// process exits (`code > 0`) qualify — a manual kill or `wait()` failure maps
/// to `-1` and must NOT nag the user — and only when the user toggle is on.
/// card-vis-notif-session-error.
pub(super) fn should_notify_session_error(exit_code: i32, enabled: bool) -> bool {
    enabled && exit_code > 0
}
