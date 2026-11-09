// Mascota — freno del chat de Pupus como hook PreToolUse por HTTP.
//
// El `claude -p` del chat de Pupus se lanza con `--settings` apuntando a un
// fichero que declara un hook PreToolUse de tipo `http` contra el puente
// (`POST /v1/pretool`, bridge.rs) con `onFailure: "block"`. Así el freno:
//   * ve TODAS las herramientas, también las que el `SAFE_TOOL` del MCP de
//     escritorio aprueba sin preguntar (Write, Edit, WebFetch, el teclado
//     del MCP) y las que una regla `allow` del settings.json del usuario
//     dejaría pasar sin consultar `--permission-prompt-tool`;
//   * falla cerrado: si el puente no responde, Claude Code bloquea la
//     herramienta en vez de ejecutarla (medido con claude 2.1.302).
//
// Qué pide confirmación en el bocadillo (approve.rs):
//   * comandos destructivos (los mismos patrones que el MCP), ejecutar
//     scripts o programas y escribir en rutas de arranque o de
//     configuración (Bash, PowerShell, Monitor, Write, Edit, type_text);
//   * lo que se teclea con el MCP, acumulado hasta el Enter, para que
//     trocear un comando en varios type_text no lo esconda;
//   * cualquier acción (comando, escritura, clic, teclado) y también otro
//     WebFetch o WebSearch con el turno marcado. Marcan el turno lo que trae
//     contenido de fuera: WebFetch, WebSearch, un comando de red (curl, wget,
//     iwr, irm…), Read, NotebookRead, Grep, ReadMcpResourceTool y los comandos
//     que leen ficheros (cat, Get-Content, grep…). Lo que traen puede llevar
//     instrucciones inyectadas, y la URL de un WebFetch puede sacar lo leído.
//     Leer y mirar la pantalla siguen sin preguntar con el turno marcado: lo
//     que frena la fuga es la salida, no la lectura;
//   * enviar datos a la red aunque el turno esté limpio (curl -d, -F o -T,
//     Invoke-RestMethod -Body, scp, nc…);
//   * credenciales (secrets.rs): `.env`, `.claude.json`, claves, tokens de CLI
//     y volcados del entorno, con cualquier herramienta. `deny-secrets` pide
//     permiso para varias, y en `claude -p` no hay terminal a quien preguntar;
//   * cualquier comando que contacte con el puente local (loopback, su API o
//     su cabecera) o que lea los ficheros de su token, y la lectura de esos
//     ficheros con Read, Grep o Glob: con el token se teclea y se clica sin
//     pasar por este freno;
//   * sobrescribir o mover ficheros por shell (`>`, Set-Content, Out-File,
//     mv, Move-Item, Copy-Item -Force…);
//   * cualquier herramienta desconocida o de un MCP de terceros.
// Lo que no reconoce como peligroso sigue su camino normal (lista
// `--allowedTools` y puerta `approve_tool_use` del MCP). Solo lee el texto de
// la acción: es un freno, no un sandbox. Pasan sin preguntar con el turno
// marcado: Read, Grep, Glob, captura, mover el cursor, rueda y esperar.
//
// El turno nace marcado si la conversación ya lo estaba (`begin_turn`): cada
// mensaje lanza un `claude -p` nuevo con `--session-id` propio, y el historial
// reinyecta lo que trajo el anterior. Una sesión que `chat.rs` no registró se
// trata como marcada (falla cerrado).
//
// Piezas:
//   * chat_gate.rs          — clasificación pura y estado por turno.
//   * chat_gate/patterns.rs — patrones de comandos, scripts y rutas.
//   * chat_gate/secrets.rs  — credenciales y volcados del entorno.
//   * chat_gate/hook.rs     — respuesta del hook y `--settings` del chat.

mod hook;
mod patterns;
mod secrets;

pub use hook::{pretool, write_hook_settings};

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::Value;

use patterns::{
    command_reason, fetches_network, reads_file, sensitive_write, touches_bridge, BRIDGE,
};
use secrets::{secret_path, SECRET};

/// Lo que se enseña en la tarjeta: el texto entero, con un tope de seguridad.
const MAX_SUMMARY: usize = 8_000;
/// Lo tecleado que se recuerda hasta el Enter.
const MAX_TYPED: usize = 4_000;
/// Un turno de Pupus dura como mucho 7 min; se olvida pasado este margen.
const TURN_TTL: Duration = Duration::from_secs(2 * 60 * 60);
const DESKTOP: &str = "mcp__ultron-desktop__";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    /// Sin objeción: sigue el camino normal de permisos.
    Pass,
    /// Pide confirmación al usuario en el bocadillo.
    Ask {
        reason: &'static str,
        summary: String,
    },
}

/// Decisión para una herramienta y efecto sobre el estado del turno.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub gate: Gate,
    /// La herramienta trae contenido de fuera: el turno queda contaminado.
    pub taints: bool,
    /// Nuevo texto tecleado pendiente de Enter (`None` = sin cambios).
    pub typed: Option<String>,
}

impl Step {
    fn pass() -> Self {
        Self {
            gate: Gate::Pass,
            taints: false,
            typed: None,
        }
    }

    fn ask(reason: &'static str, summary: &str) -> Self {
        Self {
            gate: Gate::Ask {
                reason,
                summary: clip(summary),
            },
            taints: false,
            typed: None,
        }
    }
}

fn clip(s: &str) -> String {
    let n = s.chars().count();
    if n <= MAX_SUMMARY {
        return s.to_string();
    }
    let head: String = s.chars().take(MAX_SUMMARY).collect();
    format!("{head}… [+{} caracteres sin mostrar]", n - MAX_SUMMARY)
}

const AFTER_WEB: &str = "actuar después de leer la web o un fichero";
const LEAK: &str = "salir a la web después de leer la web o un fichero";

// ---------------------------------------------------------------------------
// Clasificación (pura)
// ---------------------------------------------------------------------------

/// Herramientas pasivas que traen contenido al turno. `Glob` y `LS` solo
/// devuelven nombres.
const BRINGS_CONTENT: &[&str] = &["Read", "NotebookRead", "Grep", "ReadMcpResourceTool"];

/// Herramientas que solo leen o no actúan fuera de Claude Code.
const PASSIVE: &[&str] = &[
    "Read",
    "Glob",
    "Grep",
    "LS",
    "NotebookRead",
    "TodoWrite",
    "TodoRead",
    "ToolSearch",
    "Agent",
    "Task",
    "TaskOutput",
    "TaskStop",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet",
    "Skill",
    "BashOutput",
    "KillShell",
    "ListMcpResourcesTool",
    "ReadMcpResourceTool",
    "StructuredOutput",
    "ExitPlanMode",
    "EnterPlanMode",
    "AskUserQuestion",
];

fn str_field<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Los campos de texto de la entrada separados por espacios (rutas tal cual,
/// sin el escapado de JSON).
fn string_fields(input: &Value) -> String {
    input
        .as_object()
        .map(|o| {
            o.values()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

/// Lo que trae el contenido de un comando o de lo tecleado antes de un Enter.
fn brings_content(text: &str) -> bool {
    fetches_network(text) || reads_file(text)
}

/// Campos de una herramienta que nombran rutas (`pattern` de Grep es texto).
fn names_secret(tool: &str, input: &Value) -> bool {
    let keys: &[&str] = if tool == "Glob" {
        &["pattern", "path"]
    } else {
        &["file_path", "notebook_path", "path", "glob"]
    };
    keys.iter()
        .map(|k| str_field(input, k))
        .any(|v| !v.is_empty() && secret_path(v))
}

fn decide_passive(tool: &str, input: &Value) -> Step {
    let step = if touches_bridge(&string_fields(input)) {
        // Leer el token del puente da paso a teclado y ratón sin el freno.
        Step::ask(BRIDGE, &format!("{tool} {input}"))
    } else if names_secret(tool, input) {
        Step::ask(SECRET, &format!("{tool} {input}"))
    } else {
        Step::pass()
    };
    Step {
        taints: BRINGS_CONTENT.contains(&tool),
        ..step
    }
}

/// Lo que se escribe, para que la tarjeta no enseñe solo la ruta.
fn written_text(input: &Value) -> &str {
    ["content", "new_string", "new_source"]
        .iter()
        .map(|k| str_field(input, k))
        .find(|s| !s.is_empty())
        .unwrap_or("")
}

fn decide_write(tool: &str, input: &Value, tainted: bool) -> Step {
    let path = match str_field(input, "file_path") {
        "" => str_field(input, "notebook_path"),
        p => p,
    };
    let summary = match written_text(input) {
        "" => format!("{tool} {path}"),
        text => format!("{tool} {path}\n{text}"),
    };
    if secret_path(path) {
        Step::ask(SECRET, &summary)
    } else if sensitive_write(path) {
        Step::ask(
            "escribir en una ruta de arranque o de configuración",
            &summary,
        )
    } else if tainted {
        Step::ask(AFTER_WEB, &summary)
    } else {
        Step::pass()
    }
}

/// Decide qué hacer con `tool`. `tainted`: el turno ya trajo contenido de
/// fuera (ver la cabecera). `typed`: lo tecleado con el MCP desde el último
/// Enter.
pub fn decide(tool: &str, input: &Value, tainted: bool, typed: &str) -> Step {
    match tool {
        "WebFetch" | "WebSearch" => {
            // La URL o la búsqueda pueden sacar lo que el turno ya leyó.
            let step = if tainted {
                Step::ask(LEAK, &format!("{tool} {}", string_fields(input)))
            } else {
                Step::pass()
            };
            Step {
                taints: true,
                ..step
            }
        }
        "Bash" | "PowerShell" | "Monitor" => {
            let command = str_field(input, "command");
            let step = match command_reason(command) {
                Some(why) => Step::ask(why, command),
                None if tainted => Step::ask(AFTER_WEB, command),
                None => Step::pass(),
            };
            // curl, wget, cat, Get-Content… traen contenido igual que WebFetch.
            Step {
                taints: brings_content(command),
                ..step
            }
        }
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => decide_write(tool, input, tainted),
        t if t.starts_with(DESKTOP) => decide_desktop(&t[DESKTOP.len()..], input, tainted, typed),
        t if PASSIVE.contains(&t) => decide_passive(t, input),
        other => Step::ask("herramienta externa", &format!("{other} {}", input)),
    }
}

fn is_enter(combo: &str) -> bool {
    combo.split(['+', ' ', ',']).any(|k| {
        matches!(
            k.trim().to_lowercase().as_str(),
            "enter" | "return" | "intro"
        )
    })
}

fn tail(s: &str, max: usize) -> String {
    let n = s.chars().count();
    s.chars().skip(n.saturating_sub(max)).collect()
}

fn decide_desktop(action: &str, input: &Value, tainted: bool, typed: &str) -> Step {
    match action {
        "type_text" => {
            let text = str_field(input, "text");
            let pending = tail(&format!("{typed}{text}"), MAX_TYPED);
            // Un salto de línea dentro del texto ya es un Enter.
            let reason = command_reason(&pending).or(tainted.then_some(AFTER_WEB));
            let mut step = match reason {
                Some(why) => Step::ask(why, &format!("teclear: {pending}")),
                None => Step::pass(),
            };
            step.taints = brings_content(&pending);
            step.typed = Some(match pending.rfind(['\n', '\r']) {
                Some(i) => pending[i + 1..].to_string(),
                None => pending,
            });
            step
        }
        "press_keys" => {
            let combo = str_field(input, "combo");
            if !is_enter(combo) {
                return if tainted {
                    Step::ask(AFTER_WEB, &format!("teclas: {combo}"))
                } else {
                    Step::pass()
                };
            }
            // Enter: se ejecuta lo tecleado hasta ahora.
            let reason = command_reason(typed).or(tainted.then_some(AFTER_WEB));
            let mut step = match reason {
                Some(why) => Step::ask(why, &format!("Enter tras teclear: {typed}")),
                None => Step::pass(),
            };
            step.taints = brings_content(typed);
            step.typed = Some(String::new());
            step
        }
        "click" | "drag" if tainted => Step::ask(AFTER_WEB, &format!("{action} {input}")),
        // Mirar, mover el cursor, rueda, esperar y la propia puerta.
        _ => Step::pass(),
    }
}

// ---------------------------------------------------------------------------
// Estado por turno (session_id de Claude Code)
// ---------------------------------------------------------------------------

struct TurnState {
    tainted: bool,
    typed: String,
    seen: Instant,
}

static TURNS: Lazy<Mutex<HashMap<String, TurnState>>> = Lazy::new(Default::default);

fn turns() -> std::sync::MutexGuard<'static, HashMap<String, TurnState>> {
    TURNS.lock().unwrap_or_else(|p| p.into_inner())
}

fn snapshot(session: &str) -> (bool, String) {
    let mut map = turns();
    map.retain(|_, t| t.seen.elapsed() < TURN_TTL);
    map.get(session)
        .map(|t| (t.tainted, t.typed.clone()))
        .unwrap_or_default()
}

fn insert_turn(session: &str, tainted: bool) {
    turns().insert(
        session.to_string(),
        TurnState {
            tainted,
            typed: String::new(),
            seen: Instant::now(),
        },
    );
}

/// Registra el turno antes de lanzar `claude -p`. `tainted`: la conversación
/// ya está marcada (adjuntos o un mensaje anterior que trajo contenido).
pub fn begin_turn(session: &str, tainted: bool) {
    insert_turn(session, tainted);
}

/// Cierra el turno y dice si acabó marcado, para que la conversación lo herede.
/// Sin registro (no debería pasar) cuenta como marcado.
pub fn end_turn(session: &str) -> bool {
    turns().remove(session).is_none_or(|t| t.tainted)
}

/// Una sesión que `chat.rs` no registró no se sabe de dónde viene: marcada.
fn ensure_known(session: &str) {
    let known = turns().contains_key(session);
    if !known {
        tracing::warn!("freno de Pupus: sesión sin registrar; se trata como marcada");
        insert_turn(session, true);
    }
}

/// Guarda el efecto de una herramienta. Lo denegado no cuenta como tecleado.
fn record(session: &str, step: &Step, allowed: bool) {
    let mut map = turns();
    let t = map.entry(session.to_string()).or_insert_with(|| TurnState {
        tainted: false,
        typed: String::new(),
        seen: Instant::now(),
    });
    t.seen = Instant::now();
    t.tainted |= step.taints;
    if allowed {
        if let Some(typed) = &step.typed {
            t.typed = typed.clone();
        }
    }
}

/// Rutas de arranque o de configuración, para la paridad con el guardarraíl.
#[cfg(test)]
pub(super) fn sensitive_paths() -> &'static [&'static str] {
    patterns::SENSITIVE_PATHS
}

/// ¿El freno pregunta al escribir en `path`? Para la paridad con el guardarraíl.
#[cfg(test)]
pub(super) fn is_sensitive_path(path: &str) -> bool {
    sensitive_write(path) || secret_path(path)
}

#[cfg(test)]
#[path = "chat_gate/tests_taint.rs"]
mod tests_taint;

#[cfg(test)]
#[path = "chat_gate/tests.rs"]
mod tests;
