// sesiones/comando_run.rs — Ejecución de `/x args` desde el composer
// (`sesiones_run_command`, contrato de estabilidad §2.2 con el cambio de
// diseño del 2026-10-08: todos los slash commands desde el chat).
//
// Resolución en el catálogo (lista viva de la sesión o estático) y ruta:
// - `unsupported`: nota con el porqué; no toca el PTY.
// - `menu` y `exit`: se escriben en el PTY con el prompt a la vista (la TUI
//   abre su menú y el chat pinta el bloque de menú con `waiting{menu}`).
// - `prompt` y `local`: con la sesión en reposo y puente v2, por el buzón
//   (`command.run`); sin él, por el PTY con el prompt a la vista.
// - Sesión ocupada: un comando `immediate` va por el PTY con la pantalla
//   ocupada (la TUI lo ejecuta al momento); el resto se encola en la cola
//   de ULTRON como elemento `command`. En `waiting` nunca se escribe.
//
// Propiedad: WP-ESTADO.

use super::ajustes::ESPERA_OP;
use super::buzon::{self, InboxOp};
use super::catalogo::{self, meta, Resuelto};
use super::cola::{self, Contexto, Envio, Escritor};
use super::maquina::Ms;
use super::registro;
use super::types::{
    CommandDef, CommandDisposition, CommandKind, CommandOutcome, OpResult, QueueItemInput,
    QueueItemKind, ScreenState, SessionStatus,
};

/// Camino de un comando resuelto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ruta {
    Nota,
    Buzon,
    Pty,
    Encolar,
}

/// Ruta según la clase, si es inmediato y el estado de la sesión.
pub fn decidir(kind: CommandKind, immediate: bool, ctx: &Contexto) -> Ruta {
    let libre = ctx.status == SessionStatus::Idle && ctx.screen == ScreenState::Prompt;
    let inmediato_ya =
        immediate && ctx.status == SessionStatus::Working && ctx.screen == ScreenState::Busy;
    match kind {
        CommandKind::Unsupported | CommandKind::Panel | CommandKind::Terminal => Ruta::Nota,
        _ if ctx.status == SessionStatus::Waiting => Ruta::Encolar,
        CommandKind::Menu | CommandKind::Exit if libre || inmediato_ya => Ruta::Pty,
        CommandKind::Prompt | CommandKind::Local
            if ctx.status == SessionStatus::Idle && ctx.protocolo >= 2 =>
        {
            Ruta::Buzon
        }
        CommandKind::Prompt | CommandKind::Local if libre || inmediato_ya => Ruta::Pty,
        _ => Ruta::Encolar,
    }
}

/// Petición de ejecución con todo lo que hace falta para decidir.
pub struct Peticion<'a> {
    pub id: &'a str,
    pub command: &'a str,
    pub args: &'a str,
    pub client_id: &'a str,
    pub ctx: Contexto,
    pub catalogo: &'a [CommandDef],
    pub viva: bool,
}

fn linea(nombre: &str, args: &str) -> String {
    let args = args.trim();
    if args.is_empty() {
        format!("/{nombre}")
    } else {
        format!("/{nombre} {args}")
    }
}

fn salida(
    disposition: CommandDisposition,
    note: Option<String>,
    text: Option<String>,
) -> CommandOutcome {
    CommandOutcome {
        disposition,
        panel: None,
        note,
        text,
    }
}

/// Ejecuta con el escritor y la cola dados (núcleo probado con un espía).
pub fn ejecutar_con(
    p: &Peticion<'_>,
    w: &dyn Escritor,
    ahora: Ms,
) -> Result<CommandOutcome, String> {
    if p.ctx.status == SessionStatus::Exited {
        return Err("la sesión terminó".to_string());
    }
    let r = catalogo::resolver(p.command, p.args, p.catalogo, p.viva)?;
    match decidir(r.kind, r.immediate, &p.ctx) {
        Ruta::Nota => {
            Ok(salida(
                CommandDisposition::Unsupported,
                Some(r.note.clone().unwrap_or_else(|| {
                    format!("/{} no está disponible en ULTRON Sessions", r.nombre)
                })),
                None,
            ))
        }
        Ruta::Buzon => por_buzon(p, &r, w),
        Ruta::Pty => por_pty(p, &r, w),
        Ruta::Encolar => encolar(p, &r, ahora),
    }
}

fn por_pty(p: &Peticion<'_>, r: &Resuelto, w: &dyn Escritor) -> Result<CommandOutcome, String> {
    let envio = Envio {
        client_id: p.client_id.to_string(),
        kind: QueueItemKind::Command,
        texto: linea(&r.nombre, p.args),
        adjuntos: Vec::new(),
    };
    w.escribir(p.id, &envio)?;
    let d = if r.kind == CommandKind::Menu {
        CommandDisposition::Menu
    } else {
        CommandDisposition::Written
    };
    Ok(salida(d, r.note.clone(), None))
}

fn por_buzon(p: &Peticion<'_>, r: &Resuelto, w: &dyn Escritor) -> Result<CommandOutcome, String> {
    let op = InboxOp::CommandRun {
        op_id: String::new(),
        command: r.nombre.clone(),
        args: p.args.trim().to_string(),
    };
    match buzon::ejecutar(p.id, op, ESPERA_OP) {
        Ok(res) if res.ok || res.pending => {
            let note = if res.pending {
                Some("En curso: el resultado llegará al terminar".to_string())
            } else {
                r.note.clone()
            };
            Ok(salida(CommandDisposition::Written, note, res.text))
        }
        Ok(res) => reserva(p, r, w, res.error.unwrap_or_default()),
        Err(e) => reserva(p, r, w, e),
    }
}

/// Reserva del buzón: el PTY solo con el prompt a la vista (§2.2).
fn reserva(
    p: &Peticion<'_>,
    r: &Resuelto,
    w: &dyn Escritor,
    motivo: String,
) -> Result<CommandOutcome, String> {
    tracing::warn!(sesion = p.id, comando = %r.nombre, %motivo, "buzón fallido: reserva por el PTY");
    if p.ctx.screen == ScreenState::Prompt {
        return por_pty(p, r, w);
    }
    Err(format!("No se pudo ejecutar /{}: {motivo}", r.nombre))
}

fn encolar(p: &Peticion<'_>, r: &Resuelto, ahora: Ms) -> Result<CommandOutcome, String> {
    let input = QueueItemInput {
        client_id: p.client_id.to_string(),
        text: linea(&r.nombre, p.args),
        attachments: Vec::new(),
        delegate: false,
        kind: QueueItemKind::Command,
    };
    let items = cola::global().encolar(p.id, input, ahora)?;
    cola::emitir(p.id, &items);
    Ok(salida(CommandDisposition::Queued, r.note.clone(), None))
}

/// `sesiones_run_command`: contexto de la máquina, catálogo vivo o estático
/// y escritor instalado.
pub fn ejecutar(
    id: &str,
    command: &str,
    args: &str,
    client_id: &str,
) -> Result<CommandOutcome, String> {
    let ctx = registro::contexto(id);
    let (catalogo, viva) = match catalogo::lista_viva(id) {
        Some(v) => (v, true),
        None => {
            let cwd = registro::read(id, |s| s.info.cwd.clone())?;
            (catalogo::commands(&cwd).unwrap_or_default(), false)
        }
    };
    let p = Peticion {
        id,
        command,
        args,
        client_id,
        ctx,
        catalogo: &catalogo,
        viva,
    };
    let salida = ejecutar_con(&p, &*cola::escritor(), buzon::ahora_ms())?;
    Ok(aplicar_effort(id, command, args, salida))
}

/// Qué deja `/effort` en la `Config` de Reiniciar y de la restauración.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffortEscrito {
    /// No es `/effort` o no se escribió nada.
    Nada,
    /// `/effort <nivel>` escrito: la TUI lo aplica sin abrir el menú.
    Conservar(String),
    /// Sin nivel (el menú de la TUI) o aún en la cola: no se sabe cuál quedará.
    Avisar,
}

/// El chat no ve el nivel elegido en el menú de la TUI: el `status` del puente
/// no lleva effort y `/effort` va por el PTY, sin texto de confirmación.
pub const NOTA_EFFORT_SIN_CONSERVAR: &str = "Este effort no se conserva al reiniciar ni al \
reabrir ULTRON: para conservarlo, escribe `/effort <nivel>` con la sesión libre o usa el \
selector del HUD.";

pub fn effort_escrito(command: &str, args: &str, d: CommandDisposition) -> EffortEscrito {
    if command.trim().trim_start_matches('/') != "effort" {
        return EffortEscrito::Nada;
    }
    let nivel = args.trim();
    match d {
        CommandDisposition::Written | CommandDisposition::Menu
            if super::ajustes::EFFORTS.contains(&nivel) =>
        {
            EffortEscrito::Conservar(nivel.to_string())
        }
        CommandDisposition::Written | CommandDisposition::Menu | CommandDisposition::Queued => {
            EffortEscrito::Avisar
        }
        _ => EffortEscrito::Nada,
    }
}

/// H3: `/effort` por el composer también entra en la `Config`; lo que no se
/// puede saber se dice en la nota, en vez de perderse sin aviso al reiniciar.
fn aplicar_effort(id: &str, command: &str, args: &str, s: CommandOutcome) -> CommandOutcome {
    match effort_escrito(command, args, s.disposition) {
        EffortEscrito::Nada => s,
        EffortEscrito::Conservar(nivel) => {
            super::ajustes::recordar_effort(id, &nivel);
            s
        }
        EffortEscrito::Avisar => CommandOutcome {
            note: Some(match s.note.as_deref() {
                Some(n) => format!("{n} {NOTA_EFFORT_SIN_CONSERVAR}"),
                None => NOTA_EFFORT_SIN_CONSERVAR.to_string(),
            }),
            ..s
        },
    }
}

/// Ajuste por comando (`/model`, `/effort`, `/fast`) con su `OpResult`.
pub fn ajuste(id: &str, comando: &str, args: &str) -> Result<OpResult, String> {
    let ctx = registro::contexto(id);
    if ctx.status == SessionStatus::Exited {
        return Err("la sesión terminó".to_string());
    }
    let immediate = meta::builtin(comando).is_some_and(|m| m.immediate);
    match decidir(CommandKind::Local, immediate, &ctx) {
        Ruta::Buzon => {
            let op = InboxOp::CommandRun {
                op_id: String::new(),
                command: comando.to_string(),
                args: args.to_string(),
            };
            buzon::ejecutar(id, op, ESPERA_OP)
        }
        Ruta::Pty => {
            let envio = Envio {
                client_id: format!("ajuste:{}", uuid::Uuid::new_v4()),
                kind: QueueItemKind::Command,
                texto: linea(comando, args),
                adjuntos: Vec::new(),
            };
            cola::escritor().escribir(id, &envio)?;
            Ok(OpResult {
                ok: true,
                ..OpResult::default()
            })
        }
        _ => Err(
            "La sesión no admite el cambio ahora (espera una respuesta o un menú abierto)".into(),
        ),
    }
}

#[cfg(test)]
#[path = "tests_comando_run.rs"]
mod tests;
