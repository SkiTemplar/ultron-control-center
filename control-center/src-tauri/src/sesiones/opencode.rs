// sesiones/opencode.rs — Motor OpenCode (tareas en segundo plano).
//
//   opencode run --format json --pure --print-logs --log-level ERROR
//     [-m <proveedor/modelo>] --dir <cwd> --title <t> [--session <id>]
//     (--auto | --agent plan) [-f <encargo.md>] -- <mensaje>
//
// Comprobado con OpenCode 1.19.4 el 2026-10-26. `run` no lee el prompt de
// stdin (stdin se cierra siempre): va como argumento tras `--` y, si no cabe
// en la línea de órdenes de Windows, se adjunta como fichero con `-f` (el
// mensaje solo remite a él). Las opiniones son de solo lectura: agente `plan`,
// sin `--auto` (en `run`, lo que pide permiso se rechaza solo) y
// `OPENCODE_PERMISSION` con `PERMISOS_OPINION`, que deniega editar, escribir,
// bash, subagentes, directorios externos y leer `.env` (las reglas de esa
// variable van detrás de las del agente y ganan: `opencode debug agent plan`).
// Las tareas siguen con `--auto`. La sesión de OpenCode de cada sesión de
// Sesiones se recuerda para continuarla con `--session` (`opencode_sesion`).
// Las keys se inyectan solo a este proceso (`opencode_entorno`). Si el turno
// falla del todo y OpenCode se cuelga, `opencode_parse::fallo_stderr` lo
// detecta y `motor` lo mata.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::codex_parse::evt;
use super::motor::{self, Launch, LineParser, TaskSpec};
use super::motores;
use super::opencode_entorno as entorno;
use super::opencode_parse::{fallo_stderr, OpencodeParser};
use super::relevo::RetryCheck;
use super::types::{CodexEvent, EngineTask};

#[path = "opencode_sesion.rs"]
mod sesion;
#[cfg(test)]
pub use sesion::sesion_para as sesion_recordada;
use sesion::{al_terminar, sesion_para, Reintento};
pub use sesion::{olvidar_todo as olvidar_sesion, sembrar as sembrar_sesion, sesion_valida};

/// Tope del prompt como argumento (el límite de Windows es 32 767).
pub const PROMPT_ARG_MAX: usize = 24_000;
/// Mensaje cuando el encargo va en un fichero adjunto.
pub const MENSAJE_ADJUNTO: &str = "El encargo completo está en el fichero adjunto: síguelo.";
/// Los ficheros de encargo que no se borraron (tarea cancelada) caducan.
const ENCARGO_TTL: Duration = Duration::from_secs(24 * 3600);
/// Variable con la que OpenCode 1.19 añade reglas de permisos a su config.
pub const VAR_PERMISOS: &str = "OPENCODE_PERMISSION";
/// Permisos de una opinión: nada que modifique el repo ni salga del cwd.
pub const PERMISOS_OPINION: &str = r#"{"edit":"deny","write":"deny","bash":"deny","task":"deny","external_directory":"deny","read":{"*.env":"deny","*.env.*":"deny"}}"#;

/// Base de una sesión persistente que no está en bypass: todo pide permiso
/// (llega a ULTRON como `session/request_permission` y abre la tarjeta) salvo
/// leer y las herramientas sin efectos. Las reglas se añaden detrás de las del
/// agente y gana la última que encaja (comprobado con `opencode debug agent`).
const PERMISOS_BASE: &str = r#""*":"ask","read":{"*":"allow","*.env":"deny","*.env.*":"deny"},"glob":"allow","grep":"allow","list":"allow","lsp":"allow","todowrite":"allow","todoread":"allow","question":"allow""#;

/// Reglas de `OPENCODE_PERMISSION` del proceso persistente de una sesión según
/// su modo. `None` en bypass: el agente `build` ya lo permite todo.
pub fn permisos_sesion(mode: super::types::PermissionMode) -> Option<String> {
    use super::types::PermissionMode;
    let extra = match mode {
        PermissionMode::BypassPermissions => return None,
        PermissionMode::AcceptEdits => r#","edit":"allow""#,
        PermissionMode::Plan => r#","edit":"deny","task":"deny""#,
        _ => "",
    };
    Some(format!("{{{PERMISOS_BASE}{extra}}}"))
}

fn es_opinion(kind: &str) -> bool {
    kind == "opinion"
}

/// Entorno de permisos del hijo según el tipo de turno (solo las opiniones).
pub fn aplicar_permisos(cmd: &mut Command, kind: &str) {
    if es_opinion(kind) {
        cmd.env(VAR_PERMISOS, PERMISOS_OPINION);
    }
}

/// Cómo llega el prompt a OpenCode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entrega {
    Argumento(String),
    Adjunto(PathBuf),
}

/// Argumentos de `opencode run`.
pub fn run_args(
    cwd: &str,
    kind: &str,
    model: Option<&str>,
    sesion: Option<&str>,
    entrega: &Entrega,
) -> Vec<String> {
    let mut a: Vec<String> = [
        "run",
        "--format",
        "json",
        "--pure",
        "--print-logs",
        "--log-level",
        "ERROR",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(m) = model {
        a.extend(["-m".into(), m.to_string()]);
    }
    a.extend(["--dir".into(), cwd.to_string()]);
    a.extend(["--title".into(), format!("ULTRON Sessions · {kind}")]);
    if let Some(s) = sesion.filter(|s| sesion_valida(s)) {
        a.extend(["--session".into(), s.to_string()]);
    }
    if es_opinion(kind) {
        a.extend(["--agent".into(), "plan".into()]);
    } else {
        a.push("--auto".into());
    }
    let mensaje = match entrega {
        Entrega::Argumento(p) => p.clone(),
        Entrega::Adjunto(f) => {
            a.extend(["-f".into(), f.to_string_lossy().into_owned()]);
            MENSAJE_ADJUNTO.to_string()
        }
    };
    a.extend(["--".into(), mensaje]);
    a
}

fn dir_encargos() -> PathBuf {
    std::env::temp_dir().join("ultron-opencode")
}

/// Borra los encargos de más de `ENCARGO_TTL` (tareas canceladas o vencidas).
fn podar_encargos(dir: &Path) {
    let Ok(entradas) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entradas.flatten() {
        let viejo = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|edad| edad > ENCARGO_TTL);
        if viejo {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Prompt corto como argumento; largo, en un fichero de `dir`.
pub fn entrega_para(prompt: &str, dir: &Path) -> Result<Entrega, String> {
    if prompt.chars().count() <= PROMPT_ARG_MAX {
        return Ok(Entrega::Argumento(prompt.to_string()));
    }
    adjuntar(prompt, dir)
}

/// Como `entrega_para`, pero el relevo va siempre en fichero: su prompt lleva
/// texto de la conversación y la línea de órdenes la ve cualquier proceso
/// del usuario.
pub fn entrega_segun(kind: &str, prompt: &str, dir: &Path) -> Result<Entrega, String> {
    if kind == "relay" {
        adjuntar(prompt, dir)
    } else {
        entrega_para(prompt, dir)
    }
}

fn adjuntar(prompt: &str, dir: &Path) -> Result<Entrega, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    podar_encargos(dir);
    let f = dir.join(format!("encargo-{}.md", uuid::Uuid::new_v4()));
    std::fs::write(&f, prompt).map_err(|e| format!("{}: {e}", f.display()))?;
    Ok(Entrega::Adjunto(f))
}

/// Lanza una intervención de OpenCode. `full_prompt` ya incluye el contexto.
pub fn start(spec: TaskSpec, full_prompt: String) -> Result<EngineTask, String> {
    if full_prompt.trim().is_empty() {
        return Err("el prompt para OpenCode está vacío".to_string());
    }
    if spec.mode != "local" {
        return Err(format!(
            "modo de OpenCode no válido: '{}' (solo 'local')",
            spec.mode
        ));
    }
    if !Path::new(&spec.cwd).is_dir() {
        return Err(format!("el directorio no existe: {}", spec.cwd));
    }
    let full_prompt = if es_opinion(&spec.kind) {
        super::gemini::opinion_prompt(&full_prompt)
    } else {
        full_prompt
    };
    lanzar(spec, full_prompt, None)
}

/// Lanza el proceso. Con `aviso` (relanzamiento) va sin `--session` y el
/// aviso es el primer evento de la tarea.
fn lanzar(spec: TaskSpec, prompt: String, aviso: Option<String>) -> Result<EngineTask, String> {
    let program = entorno::opencode_program()?;
    let claves = entorno::claves_para(entorno::claves(), &spec.kind, spec.model.as_deref());
    let entrega = entrega_segun(&spec.kind, &prompt, &dir_encargos())?;
    let sesion =
        sesion_para(spec.session_id.as_deref()).filter(|s| aviso.is_none() && sesion_valida(s));
    let mut cmd = motores::command_for_task(&program, &spec.cwd);
    cmd.args(run_args(
        &spec.cwd,
        &spec.kind,
        spec.model.as_deref(),
        sesion.as_deref(),
        &entrega,
    ));
    entorno::inyectar(&mut cmd, &claves);
    aplicar_permisos(&mut cmd, &spec.kind);
    let adjunto = match entrega {
        Entrega::Adjunto(f) => Some(f),
        Entrega::Argumento(_) => None,
    };
    let reintento = sesion.map(|sesion| Reintento { sesion, prompt });
    let launch = Launch {
        cmd,
        stdin: None,
        parser: parser_con_aviso(aviso),
        on_done: Some(al_terminar(
            adjunto,
            reintento,
            relanzar,
            super::relevo::task_finished,
        )),
        vigia_stderr: Some(fallo_stderr),
    };
    motor::spawn(spec, launch)
}

/// Intérprete de OpenCode; con `aviso`, lo pone en la primera línea que no
/// trae evento propio (la primera es `step_start`).
pub fn parser_con_aviso(aviso: Option<String>) -> LineParser {
    let mut parser = OpencodeParser::default();
    let mut aviso = aviso;
    Box::new(move |l: &str| {
        let mut o = parser.line(l);
        if o.event.is_none() {
            if let Some(a) = aviso.take() {
                o.event = evt("warning", a);
            }
        }
        o
    })
}

fn relanzar(t: &EngineTask, prompt: String, aviso: String) {
    relanzar_con(t, prompt, aviso, lanzar, super::relevo::task_finished);
}

/// Relanza sin `--session` el turno de una tarea cuya sesión caducó, con su
/// misma ancla en la conversación. Una tarea del relevo solo se relanza si el
/// relevo sigue en este motor, y la nueva se adopta solo si no cambió durante
/// el lanzamiento: si no, sobreviviría a la vuelta a Claude o competiría con
/// el motor al que se pasó. Si no se puede lanzar, el turno sigue la vía normal
/// de una tarea fallida (`fin`): el relevo escala con la petición pendiente.
pub fn relanzar_con(
    t: &EngineTask,
    prompt: String,
    aviso: String,
    lanza: impl FnOnce(TaskSpec, String, Option<String>) -> Result<EngineTask, String>,
    fin: sesion::Fin,
) {
    let generacion = match super::relevo::retry_generation(t) {
        RetryCheck::Stale => {
            tracing::info!(tarea = %t.id, "relevo cerrado o cambiado: no se relanza OpenCode");
            return;
        }
        RetryCheck::NotRelay => None,
        RetryCheck::Current(g) => Some(g),
    };
    match lanza(spec_de(t), prompt, Some(aviso)) {
        Ok(nueva) => {
            let anclada = tras_relanzar(&nueva, t, |n| {
                if let Some(g) = generacion {
                    super::relevo::adopt_retry(n, g);
                }
                // El turno de una sesión de motor sigue en la tarea nueva: sin
                // esto la sesión quedaba libre con OpenCode trabajando.
                if n.kind == motor::KIND_CHAT {
                    super::motor_sesion::adoptar_relanzado(n);
                }
            });
            if let Err(e) = anclada {
                tracing::debug!(tarea = %nueva.id, error = %e, "tarea relanzada sin ancla");
            }
        }
        Err(e) => {
            tracing::warn!(tarea = %t.id, error = %e, "no se pudo relanzar OpenCode sin la sesión caducada");
            let texto = format!("No se pudo relanzar el turno sin la sesión caducada: {e}");
            motor::anotar_error(&t.id, texto.clone());
            let mut fallida = t.clone();
            fallida.events.push(CodexEvent {
                kind: "error".into(),
                text: texto,
            });
            fin(&fallida);
        }
    }
}

fn spec_de(t: &EngineTask) -> TaskSpec {
    TaskSpec {
        engine: "opencode",
        kind: t.kind.clone(),
        mode: t.mode.clone(),
        cwd: t.cwd.clone(),
        prompt: t.prompt.clone(),
        session_id: t.session_id.clone(),
        context_chars: t.context_chars,
        model: t.model.clone(),
        group: t.group.clone(),
    }
}

/// La tarea relanzada entra en el relevo (`seguir`) y hereda el ancla de la
/// original. Sin el registro, el relevo no la veía en curso y podía volver a
/// Claude sin traer su resultado.
pub fn tras_relanzar(
    nueva: &EngineTask,
    original: &EngineTask,
    seguir: impl FnOnce(&EngineTask),
) -> Result<EngineTask, String> {
    seguir(nueva);
    motor::anclar(&nueva.id, original.anchor_message_uuid.clone())
}

#[cfg(test)]
#[path = "opencode_tests.rs"]
mod tests;
