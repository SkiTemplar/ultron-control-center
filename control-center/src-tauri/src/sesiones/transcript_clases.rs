// sesiones/transcript_clases.rs — Clasificación fina de las líneas del
// transcript (contrato de estabilidad, §5.1): comandos locales y su salida,
// `!cmd`, interrupciones, resúmenes de compactación, notificaciones de
// tareas y mensajes absorbidos a mitad de turno. También extrae las señales
// `Tx*` del hilo principal y las operaciones de la cola nativa de la CLI.
//
// Propiedad: WP-ESTADO.

use std::collections::VecDeque;

use serde_json::Value;

use super::{parse_content, str_field, ParseState};
use crate::sesiones::senales::Senal;
use crate::sesiones::types::{Block, ChatMessage, CommandOutput, MessageKind};

/// Comandos recientes cuya salida puede llegar en una línea posterior.
const COMANDOS_RECIENTES: usize = 16;
const INTERRUMPIDO: &str = "[Request interrupted by user";

/// Qué hacer con una línea `user` (o `system/local_command`).
pub enum Clase {
    /// Sigue el camino normal de prompt o resultado de herramienta.
    Normal,
    /// No es un mensaje del chat.
    NoEmitir,
    Mensaje(Box<ChatMessage>),
}

/// Primer texto del contenido, sin espacios iniciales.
fn primer_texto(blocks: &[Block]) -> Option<&str> {
    blocks.iter().find_map(|b| match b {
        Block::Text { text } => Some(text.trim_start()),
        _ => None,
    })
}

fn flag(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool) == Some(true)
}

/// Mensaje base de sistema con la clase dada.
fn sistema(v: &Value, blocks: Vec<Block>, kind: MessageKind, agent: Option<String>) -> ChatMessage {
    ChatMessage {
        uuid: str_field(v, "uuid"),
        role: "system".to_string(),
        timestamp: str_field(v, "timestamp"),
        blocks,
        agent_id: agent,
        model: None,
        usage: None,
        kind,
        queued: false,
        client_id: None,
        stream_key: None,
        command: None,
    }
}

/// Clasifica una línea `user` ya parseada en bloques.
pub fn usuario(v: &Value, blocks: &[Block], agent: Option<String>, st: &mut ParseState) -> Clase {
    if flag(v, "isCompactSummary") || flag(v, "isVisibleInTranscriptOnly") {
        let m = sistema(v, blocks.to_vec(), MessageKind::CompactSummary, agent);
        return Clase::Mensaje(Box::new(m));
    }
    let solo_resultados =
        !blocks.is_empty() && blocks.iter().all(|b| matches!(b, Block::ToolResult { .. }));
    if solo_resultados {
        return Clase::Normal;
    }
    let Some(t) = primer_texto(blocks) else {
        return Clase::Normal;
    };
    if t.starts_with("<local-command-caveat>") {
        return Clase::NoEmitir;
    }
    if t.starts_with("<command-name>") {
        return comando(v, t, agent, st);
    }
    if t.starts_with("<local-command-stdout>") || t.starts_with("<local-command-stderr>") {
        let padre = v.get("parentUuid").and_then(Value::as_str);
        return salida(v, padre, t, None, st);
    }
    if let Some(entrada) = entre(t, "<bash-input>", "</bash-input>") {
        let out = CommandOutput {
            name: "!".to_string(),
            args: entrada.to_string(),
            stdout: String::new(),
            is_error: false,
        };
        return guardar(v, MessageKind::Bash, out, blocks.to_vec(), agent, st);
    }
    if t.starts_with("<bash-stdout>") || t.starts_with("<bash-stderr>") {
        let padre = v.get("parentUuid").and_then(Value::as_str);
        return salida(v, padre, t, None, st);
    }
    let kind = if t.starts_with(INTERRUMPIDO) {
        MessageKind::Interrupted
    } else if t.starts_with("<task-notification>") {
        MessageKind::TaskNotification
    } else if t.starts_with("<system-reminder>") {
        MessageKind::Meta
    } else {
        return Clase::Normal;
    };
    Clase::Mensaje(Box::new(sistema(v, blocks.to_vec(), kind, agent)))
}

/// `<command-name>/x</command-name>` (+ `<command-args>`).
fn comando(v: &Value, t: &str, agent: Option<String>, st: &mut ParseState) -> Clase {
    let name = entre(t, "<command-name>", "</command-name>")
        .unwrap_or_default()
        .trim()
        .trim_start_matches('/')
        .to_string();
    let args = entre(t, "<command-args>", "</command-args>")
        .unwrap_or_default()
        .trim()
        .to_string();
    let texto = if args.is_empty() {
        format!("/{name}")
    } else {
        format!("/{name} {args}")
    };
    let out = CommandOutput {
        name,
        args,
        stdout: String::new(),
        is_error: false,
    };
    let blocks = vec![Block::Text { text: texto }];
    guardar(v, MessageKind::Command, out, blocks, agent, st)
}

fn guardar(
    v: &Value,
    kind: MessageKind,
    out: CommandOutput,
    blocks: Vec<Block>,
    agent: Option<String>,
    st: &mut ParseState,
) -> Clase {
    let mut m = sistema(v, blocks, kind, agent);
    m.command = Some(out);
    recordar(&mut st.comandos, m.clone());
    Clase::Mensaje(Box::new(m))
}

fn recordar(cola: &mut VecDeque<ChatMessage>, m: ChatMessage) {
    cola.retain(|c| c.uuid != m.uuid);
    cola.push_back(m);
    while cola.len() > COMANDOS_RECIENTES {
        cola.pop_front();
    }
}

/// Salida de un comando local o de `!cmd`: rellena el mensaje del comando
/// (mismo `uuid`, que el frontend sustituye) o, si no se vio, crea uno.
fn salida(
    v: &Value,
    padre: Option<&str>,
    t: &str,
    run: Option<(&str, &str)>,
    st: &mut ParseState,
) -> Clase {
    let (stdout, is_error) = texto_salida(t);
    let previo = st
        .comandos
        .iter()
        .rposition(|c| padre.is_some_and(|p| c.uuid == p))
        .or_else(|| st.comandos.len().checked_sub(1).filter(|_| padre.is_none()));
    let mut m = match previo.and_then(|i| st.comandos.get(i).cloned()) {
        Some(m) => m,
        None => {
            let (name, args) = run.unwrap_or_default();
            let out = CommandOutput {
                name: name.to_string(),
                args: args.to_string(),
                stdout: String::new(),
                is_error: false,
            };
            let texto = format!("/{name}");
            let mut m = sistema(
                v,
                vec![Block::Text { text: texto }],
                MessageKind::Command,
                None,
            );
            m.command = Some(out);
            m
        }
    };
    if let Some(c) = m.command.as_mut() {
        c.stdout = stdout;
        c.is_error = is_error;
    }
    recordar(&mut st.comandos, m.clone());
    Clase::Mensaje(Box::new(m))
}

/// Texto de `<local-command-stdout|stderr>` y `<bash-stdout|stderr>` sin
/// ANSI; `is_error` si hay stderr con contenido.
fn texto_salida(t: &str) -> (String, bool) {
    let partes = [
        ("<local-command-stdout>", "</local-command-stdout>", false),
        ("<local-command-stderr>", "</local-command-stderr>", true),
        ("<bash-stdout>", "</bash-stdout>", false),
        ("<bash-stderr>", "</bash-stderr>", true),
    ];
    let mut out = Vec::new();
    let mut error = false;
    for (a, b, es_err) in partes {
        if let Some(x) = entre(t, a, b).filter(|x| !x.trim().is_empty()) {
            out.push(sin_ansi(x.trim_end()));
            error |= es_err;
        }
    }
    (out.join("\n"), error)
}

/// Línea `system/local_command` (salida de un comando local, §5.1).
pub fn sistema_local(v: &Value, st: &mut ParseState) -> Option<ChatMessage> {
    if v.get("subtype").and_then(Value::as_str) != Some("local_command") {
        return None;
    }
    let t = v.get("content").and_then(Value::as_str)?;
    let padre = v.get("parentUuid").and_then(Value::as_str);
    let run = v.get("commandRun").map(|r| {
        (
            r.get("command").and_then(Value::as_str).unwrap_or_default(),
            r.get("args").and_then(Value::as_str).unwrap_or_default(),
        )
    });
    match salida(v, padre, t, run, st) {
        Clase::Mensaje(m) => Some(*m),
        _ => None,
    }
}

/// `attachment.queued_command`: mensaje absorbido a mitad de turno o
/// notificación de tarea (§5.1).
pub fn encolado(v: &Value, agent: Option<String>) -> Option<ChatMessage> {
    let att = v.get("attachment")?;
    if att.get("type").and_then(Value::as_str) != Some("queued_command") {
        return None;
    }
    let blocks = parse_content(att.get("prompt")?);
    if blocks.is_empty() {
        return None;
    }
    let modo = att.get("commandMode").and_then(Value::as_str);
    let origen = att.pointer("/origin/kind").and_then(Value::as_str);
    let es_tarea = modo.is_some_and(|m| m != "prompt")
        || origen.is_some_and(|o| o != "human")
        || primer_texto(&blocks).is_some_and(|t| t.starts_with("<task-notification>"));
    if es_tarea {
        return Some(sistema(v, blocks, MessageKind::TaskNotification, agent));
    }
    let mut m = sistema(v, blocks, MessageKind::Prompt, agent);
    m.role = "user".to_string();
    m.queued = true;
    Some(m)
}

/// Texto entre dos marcas.
fn entre<'a>(t: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let i = t.find(a)? + a.len();
    let j = t[i..].find(b).map_or(t.len(), |j| i + j);
    Some(&t[i..j])
}

/// Quita las secuencias ANSI CSI (`ESC [ … letra`) y OSC (`ESC ] … BEL`).
pub fn sin_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('[') => {
                for x in it.by_ref() {
                    if x.is_ascii_alphabetic() || x == '~' {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(x) = it.next() {
                    if x == '\u{7}' {
                        break;
                    }
                    if x == '\u{1b}' && it.peek() == Some(&'\\') {
                        it.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Señales del hilo principal y cola nativa
// ---------------------------------------------------------------------------

/// Señales `Tx*` de una línea del hilo principal (sin `agentId` ni
/// `isSidechain`). La actividad genérica la añade el seguidor.
pub fn senales(v: &Value) -> Vec<Senal> {
    if v.get("agentId").is_some() || flag(v, "isSidechain") {
        return Vec::new();
    }
    let typ = v.get("type").and_then(Value::as_str).unwrap_or_default();
    let s = match typ {
        "system" => match v.get("subtype").and_then(Value::as_str) {
            Some("turn_duration") => Some(Senal::TxTurnDuration),
            Some("local_command") => Some(Senal::TxSalidaLocal),
            _ => None,
        },
        "permission-mode" => {
            v.get("permissionMode")
                .and_then(Value::as_str)
                .map(|m| Senal::ModoPermisos {
                    modo: m.to_string(),
                })
        }
        "assistant" => super::is_main_turn_end(v).then_some(Senal::TxEndTurn),
        "user" => senal_usuario(v),
        _ => None,
    };
    s.into_iter().collect()
}

fn senal_usuario(v: &Value) -> Option<Senal> {
    let blocks = parse_content(v.pointer("/message/content")?);
    let t = primer_texto(&blocks)?;
    if t.starts_with(INTERRUMPIDO) {
        return Some(Senal::TxInterrumpido);
    }
    if t.starts_with("<local-command-stdout>") || t.starts_with("<local-command-stderr>") {
        return Some(Senal::TxSalidaLocal);
    }
    if t.starts_with("<bash-stdout>") || t.starts_with("<bash-stderr>") {
        return Some(Senal::TxSalidaBash);
    }
    crate::sesiones::historial::prompt_de_persona(v).map(|texto| Senal::TxPromptUsuario { texto })
}

/// Operación de la cola nativa de la CLI (`queue-operation`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpCola {
    Enqueue(String),
    Dequeue,
    Remove(String),
    PopAll(String),
}

pub fn op_cola(v: &Value) -> Option<OpCola> {
    if v.get("type").and_then(Value::as_str) != Some("queue-operation") {
        return None;
    }
    let content = || str_field(v, "content");
    match v.get("operation").and_then(Value::as_str)? {
        "enqueue" => Some(OpCola::Enqueue(content())),
        "dequeue" => Some(OpCola::Dequeue),
        "remove" => Some(OpCola::Remove(content())),
        "popAll" => Some(OpCola::PopAll(content())),
        _ => None,
    }
}
