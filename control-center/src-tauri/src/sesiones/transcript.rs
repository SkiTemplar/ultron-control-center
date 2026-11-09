// sesiones/transcript.rs — Parser del JSONL de transcripts de Claude Code.
//
// Formato observado en `~/.claude/projects/<slug>/<sessionId>.jsonl` (CLI
// 2.1.x): una línea por evento. Son mensajes del chat `user`, `assistant`,
// `attachment.queued_command` y `system/local_command`; el resto
// (`queue-operation`, `permission-mode`, `system/turn_duration`,
// `stop_hook_summary`, `last-prompt`, `ai-title`…) alimenta la cola y las
// señales de la máquina (`transcript_clases.rs`), no el chat. Cada bloque de
// contenido del asistente llega en su propia línea con el mismo `message.id`
// y el mismo `usage`; el uso solo se adjunta a la primera línea de cada
// `message.id` para que el frontend pueda sumar sin contar dos veces.
//
// Clasificación (contrato de estabilidad, §5.1): `isMeta` y
// `<local-command-caveat>` no se emiten; `<command-name>` es `command` y su
// salida (línea siguiente o `system/local_command`) rellena el mismo mensaje,
// que se reemite con el mismo `uuid`; `<bash-input>` es `bash`;
// `[Request interrupted by user` es `interrupted`; `isCompactSummary` es
// `compactSummary`; las notificaciones de tareas son `taskNotification`.
//
// Propiedad: WP-ESTADO.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::path::Path;

use serde_json::Value;

use super::types::{Block, ChatMessage, MessageKind, Usage};

#[path = "transcript_clases.rs"]
pub mod clases;
use clases::Clase;

/// Límite de texto de un `tool_result` (los volcados de herramientas pueden
/// ocupar megas y viajan por IPC).
pub const TOOL_RESULT_MAX_CHARS: usize = 20_000;
const SUMMARY_MAX_CHARS: usize = 120;

/// Ids de `message.id` recordados para no contar dos veces el uso. Las
/// líneas de un mismo mensaje del asistente llegan juntas, así que basta con
/// los más recientes (la dedup del turno en curso no se rompe).
pub const IDS_RECIENTES: usize = 1_024;

/// Conjunto acotado: recuerda los últimos `cap` elementos insertados.
#[derive(Clone)]
pub struct IdsRecientes {
    cap: usize,
    vistos: HashSet<String>,
    orden: VecDeque<String>,
}

impl Default for IdsRecientes {
    fn default() -> Self {
        Self::con_capacidad(IDS_RECIENTES)
    }
}

impl IdsRecientes {
    pub fn con_capacidad(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            vistos: HashSet::new(),
            orden: VecDeque::new(),
        }
    }

    /// true si `id` no estaba entre los recientes (como `HashSet::insert`).
    pub fn insertar(&mut self, id: &str) -> bool {
        if self.vistos.contains(id) {
            return false;
        }
        self.vistos.insert(id.to_string());
        self.orden.push_back(id.to_string());
        while self.orden.len() > self.cap {
            if let Some(viejo) = self.orden.pop_front() {
                self.vistos.remove(&viejo);
            }
        }
        true
    }
}

/// Estado del parseo incremental de un fichero.
#[derive(Default)]
pub struct ParseState {
    seen_message_ids: IdsRecientes,
    /// Comandos recientes cuya salida puede llegar después.
    comandos: VecDeque<ChatMessage>,
}

/// Parsea una línea. `default_agent` se usa si la línea no trae `agentId`.
pub fn parse_line(
    line: &str,
    default_agent: Option<&str>,
    st: &mut ParseState,
) -> Option<ChatMessage> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    parse_value(&v, default_agent, st)
}

fn agente(v: &Value, default_agent: Option<&str>) -> Option<String> {
    v.get("agentId")
        .and_then(Value::as_str)
        .or(default_agent)
        .map(str::to_string)
}

pub fn parse_value(
    v: &Value,
    default_agent: Option<&str>,
    st: &mut ParseState,
) -> Option<ChatMessage> {
    match v.get("type").and_then(Value::as_str)? {
        "attachment" => clases::encolado(v, agente(v, default_agent)),
        "system" => clases::sistema_local(v, st),
        typ @ ("user" | "assistant") => mensaje(v, typ, default_agent, st),
        _ => None,
    }
}

fn mensaje(
    v: &Value,
    typ: &str,
    default_agent: Option<&str>,
    st: &mut ParseState,
) -> Option<ChatMessage> {
    if v.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let msg = v.get("message")?;
    let blocks = parse_content(msg.get("content")?);
    if blocks.is_empty() {
        return None;
    }
    let agent_id = agente(v, default_agent);
    if typ == "user" {
        match clases::usuario(v, &blocks, agent_id.clone(), st) {
            Clase::NoEmitir => return None,
            Clase::Mensaje(m) => return Some(*m),
            Clase::Normal => {}
        }
    }
    let (model, usage) = if typ == "assistant" {
        assistant_meta(msg, st)
    } else {
        (None, None)
    };
    let solo_resultados = blocks.iter().all(|b| matches!(b, Block::ToolResult { .. }));
    let kind = match typ {
        "assistant" => MessageKind::Answer,
        // Un resultado de herramienta es parte del turno del asistente:
        // nunca abre turno ni entra en el historial de prompts.
        _ if solo_resultados => MessageKind::Meta,
        _ => MessageKind::Prompt,
    };
    let blocks = if kind == MessageKind::Prompt {
        sin_pegados(blocks)
    } else {
        blocks
    };
    Some(ChatMessage {
        uuid: str_field(v, "uuid"),
        role: typ.to_string(),
        timestamp: str_field(v, "timestamp"),
        blocks,
        agent_id,
        model,
        usage,
        kind,
        queued: false,
        client_id: None,
        stream_key: None,
        command: None,
    })
}

/// Texto de un prompt sin las marcas `<pasted_content>` de la CLI: la burbuja
/// enseña lo pegado y el emparejamiento con la cola usa el mismo texto.
fn sin_pegados(blocks: Vec<Block>) -> Vec<Block> {
    blocks
        .into_iter()
        .map(|b| match b {
            Block::Text { text } => Block::Text {
                text: super::senales::sin_marcas_pegado(&text).unwrap_or(text),
            },
            otro => otro,
        })
        .collect()
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn assistant_meta(msg: &Value, st: &mut ParseState) -> (Option<String>, Option<Usage>) {
    let model = msg.get("model").and_then(Value::as_str).map(str::to_string);
    let first_time = match msg.get("id").and_then(Value::as_str) {
        Some(id) => st.seen_message_ids.insertar(id),
        None => true,
    };
    let usage = if first_time {
        msg.get("usage").map(parse_usage)
    } else {
        None
    };
    (model, usage)
}

/// `usage` de un mensaje del asistente, con la caché de escritura separada
/// en 5 min y 1 h y el modo rápido (`USO-02`).
pub fn parse_usage(u: &Value) -> Usage {
    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    let cc = |k: &str| {
        u.pointer(&format!("/cache_creation/{k}"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    Usage {
        input: n("input_tokens"),
        output: n("output_tokens"),
        cache_read: n("cache_read_input_tokens"),
        cache_write: n("cache_creation_input_tokens"),
        cache_write_5m: cc("ephemeral_5m_input_tokens"),
        cache_write_1h: cc("ephemeral_1h_input_tokens"),
        speed: u
            .get("speed")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        model: None,
    }
}

/// Contenido de `message.content`: cadena o array de bloques.
pub fn parse_content(content: &Value) -> Vec<Block> {
    if let Some(s) = content.as_str() {
        if s.trim().is_empty() {
            return Vec::new();
        }
        return vec![Block::Text {
            text: s.to_string(),
        }];
    }
    content
        .as_array()
        .map(|arr| arr.iter().filter_map(parse_block).collect())
        .unwrap_or_default()
}

fn parse_block(b: &Value) -> Option<Block> {
    match b.get("type").and_then(Value::as_str)? {
        "text" => {
            let text = b.get("text").and_then(Value::as_str)?;
            (!text.trim().is_empty()).then(|| Block::Text {
                text: text.to_string(),
            })
        }
        // El pensamiento suele venir vacío (solo firma): se omite.
        "thinking" => {
            let text = b.get("thinking").and_then(Value::as_str)?;
            (!text.trim().is_empty()).then(|| Block::Thinking {
                text: text.to_string(),
            })
        }
        "image" => image_block(b),
        "tool_use" => {
            let name = str_field(b, "name");
            let input = b.get("input").unwrap_or(&Value::Null);
            let summary = summarize_tool(&name, input);
            Some(Block::ToolUse {
                id: str_field(b, "id"),
                name,
                input: recortar_cadenas(input),
                summary,
            })
        }
        "tool_result" => Some(tool_result_block(b)),
        _ => None,
    }
}

/// Copia de `v` con cada cadena (también las anidadas) recortada a
/// `TOOL_RESULT_MAX_CHARS` con la misma marca que los `tool_result`: un
/// `Write` o un `Edit` de un fichero grande viaja por IPC (§7).
pub fn recortar_cadenas(v: &Value) -> Value {
    match v {
        Value::String(s) if s.len() > TOOL_RESULT_MAX_CHARS => {
            Value::String(truncate_chars(s, TOOL_RESULT_MAX_CHARS))
        }
        Value::Array(a) => Value::Array(a.iter().map(recortar_cadenas).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), recortar_cadenas(x)))
                .collect(),
        ),
        otro => otro.clone(),
    }
}

/// `data:` URL de un bloque `image` con fuente base64.
fn image_data_url(b: &Value) -> Option<(String, String)> {
    let src = b.get("source")?;
    if src.get("type").and_then(Value::as_str) != Some("base64") {
        return None;
    }
    let mt = src
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    let data = src.get("data").and_then(Value::as_str)?;
    Some((mt.to_string(), format!("data:{mt};base64,{data}")))
}

fn image_block(b: &Value) -> Option<Block> {
    if let Some((media_type, url)) = image_data_url(b) {
        return Some(Block::Image {
            media_type,
            data_url: Some(url),
            path: None,
        });
    }
    let src = b.get("source")?;
    let path = src
        .get("path")
        .or_else(|| src.get("file_path"))
        .and_then(Value::as_str)?;
    Some(Block::Image {
        media_type: str_field(src, "media_type"),
        data_url: None,
        path: Some(path.to_string()),
    })
}

fn tool_result_block(b: &Value) -> Block {
    let mut text = String::new();
    let mut images = Vec::new();
    match b.get("content") {
        Some(Value::String(s)) => text.push_str(s),
        Some(Value::Array(arr)) => {
            for item in arr {
                match item.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(item.get("text").and_then(Value::as_str).unwrap_or(""));
                    }
                    Some("image") => {
                        if let Some((_, url)) = image_data_url(item) {
                            images.push(url);
                        }
                    }
                    Some("tool_reference") => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(item.get("tool_name").and_then(Value::as_str).unwrap_or(""));
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Block::ToolResult {
        tool_use_id: str_field(b, "tool_use_id"),
        is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        text: truncate_chars(&text, TOOL_RESULT_MAX_CHARS),
        images: (!images.is_empty()).then_some(images),
    }
}

/// Resumen corto de una llamada a herramienta: ruta, comando o patrón.
pub fn summarize_tool(name: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    let raw = match name {
        "Bash" | "PowerShell" => s("command").map(|c| c.lines().next().unwrap_or("").to_string()),
        "Read" | "Write" | "Edit" | "MultiEdit" => s("file_path"),
        "NotebookEdit" => s("notebook_path"),
        "Grep" => s("pattern").map(|p| match s("path") {
            Some(path) => format!("{p} en {path}"),
            None => p,
        }),
        "Glob" => s("pattern"),
        "WebFetch" => s("url"),
        "WebSearch" => s("query"),
        "Agent" | "Task" => s("description").map(|d| match s("subagent_type") {
            Some(t) => format!("{t}: {d}"),
            None => d,
        }),
        "TodoWrite" => input
            .get("todos")
            .and_then(Value::as_array)
            .map(|t| format!("{} tareas", t.len())),
        _ => None,
    };
    let text = raw.or_else(|| first_string(input)).unwrap_or_default();
    truncate_chars(text.trim(), SUMMARY_MAX_CHARS)
}

fn first_string(v: &Value) -> Option<String> {
    v.as_object()?
        .values()
        .find_map(|x| x.as_str().map(str::to_string))
}

/// Recorta a `max` caracteres (no bytes) y marca el corte.
pub fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((idx, _)) => format!("{}… (recortado)", &s[..idx]),
        None => s.to_string(),
    }
}

/// Primer texto de usuario escrito por la persona (para el título).
pub fn first_user_text(msg: &ChatMessage) -> Option<String> {
    if msg.role != "user" || msg.agent_id.is_some() {
        return None;
    }
    msg.blocks.iter().find_map(|b| match b {
        Block::Text { text } => Some(text.trim().to_string()),
        _ => None,
    })
}

/// true si la línea es el fin de turno del asistente del hilo principal.
pub fn is_main_turn_end(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) == Some("assistant")
        && v.get("agentId").is_none()
        && v.get("isSidechain").and_then(Value::as_bool) != Some(true)
        && v.pointer("/message/stop_reason").and_then(Value::as_str) == Some("end_turn")
}

/// Lista de mensajes en construcción: un mensaje que se reemite con el mismo
/// `uuid` (comando con su salida) sustituye al anterior en su sitio.
#[derive(Default)]
struct Acumulador {
    st: ParseState,
    out: Vec<ChatMessage>,
    indice: HashMap<String, usize>,
}

impl Acumulador {
    fn linea(&mut self, l: &str, default_agent: Option<&str>) {
        if l.trim().is_empty() {
            return;
        }
        let Some(m) = parse_line(l, default_agent, &mut self.st) else {
            return;
        };
        if m.uuid.is_empty() {
            self.out.push(m);
            return;
        }
        match self.indice.get(&m.uuid) {
            Some(&i) => self.out[i] = m,
            None => {
                self.indice.insert(m.uuid.clone(), self.out.len());
                self.out.push(m);
            }
        }
    }
}

/// Parsea un fichero completo ya leído.
pub fn parse_all(text: &str, default_agent: Option<&str>) -> Vec<ChatMessage> {
    let mut acc = Acumulador::default();
    for l in text.lines() {
        acc.linea(l, default_agent);
    }
    acc.out
}

/// Parsea un transcript del disco línea a línea, sin cargarlo entero en
/// memoria (los de días pesan 50-200 MB). Los bytes no UTF-8 se sustituyen.
pub fn parse_fichero(path: &Path, default_agent: Option<&str>) -> io::Result<Vec<ChatMessage>> {
    let mut r = BufReader::with_capacity(1 << 20, File::open(path)?);
    let mut acc = Acumulador::default();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if r.read_until(b'\n', &mut buf)? == 0 {
            return Ok(acc.out);
        }
        acc.linea(&String::from_utf8_lossy(&buf), default_agent);
    }
}
