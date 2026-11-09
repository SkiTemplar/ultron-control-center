// Mascota — permisos de Claude Code en terminal o VS Code, contestados desde
// el bocadillo de Pupus.
//
// Hook `PermissionRequest` global (hooks/scripts/pupus-permission.js) →
// POST /v1/permission del puente → tarjeta «¿Le dejo?» con el origen y lo
// último que dijo Claude. El diálogo de la terminal se pinta a la vez que
// corre el hook (medido con Claude Code 2.1.311) y una decisión tardía del
// hook lo cierra: gana quien conteste antes. Si el usuario contesta en la
// terminal, el hook se corta y la tarjeta se retira (`peer_closed` del puente).
//
// Sin decisión (Pupus oculto o en silencio de juego, nadie contesta en el
// plazo o el hook se corta) la salida va vacía y manda el diálogo de la
// terminal: no poder preguntar nunca deniega.
//
// Las sesiones de ULTRON Sessions no pasan por aquí: el script sale sin
// llamar si ve `ULTRON_SESION_ID`, y sus preguntas las enseña el bocadillo
// desde `sesiones_pending_asks` (useSessionAsks.ts).

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::approve::{self, Answer};

/// Lo que espera el bocadillo antes de dejarlo solo en la terminal.
const WAIT: Duration = Duration::from_secs(10 * 60);
/// Cola del transcript que se lee para encontrar lo último que dijo Claude.
const TAIL_BYTES: u64 = 256 * 1024;
/// El mismo tope que el freno y el MCP: se aprueba lo que se ve.
const MAX_SUMMARY: usize = 8_000;
const MAX_CONTEXT: usize = 1_200;

fn clip(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

/// Como `clip`, pero dice cuánto queda sin enseñar: nada se esconde tras un
/// recorte en lo que se pide aprobar.
fn clip_marked(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}… [+{} caracteres sin mostrar]", n - max)
}

fn str_at<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Lo que escribe `Write`, `Edit` o `NotebookEdit`.
fn written_text(input: &Value) -> &str {
    ["content", "new_string", "new_source"]
        .iter()
        .map(|k| str_at(input, k))
        .find(|s| !s.is_empty())
        .unwrap_or("")
}

/// Qué enseñar de la herramienta: el comando, la ruta (con lo que se escribe)
/// o la URL; si no, la entrada en JSON. Pura.
pub fn summary(tool: &str, input: &Value) -> String {
    let main = [
        "command",
        "file_path",
        "notebook_path",
        "url",
        "query",
        "pattern",
    ]
    .iter()
    .map(|k| str_at(input, k))
    .find(|s| !s.is_empty());
    let text = match (main, written_text(input)) {
        (Some(s), "") => s.to_string(),
        (Some(s), written) => format!("{s}\n{written}"),
        (None, _) if input.is_null() => tool.to_string(),
        (None, _) => input.to_string(),
    };
    clip_marked(&text, MAX_SUMMARY)
}

/// Quién pide: la carpeta de trabajo de la sesión. Pura.
pub fn origin(cwd: &str) -> String {
    let name = cwd
        .trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("");
    if name.is_empty() {
        "Claude Code".to_string()
    } else {
        format!("Claude Code · {name}")
    }
}

/// Primer texto de un mensaje del asistente (sin herramientas ni thinking).
fn assistant_text(line: &Value) -> Option<String> {
    if str_at(line, "type") != "assistant" || line.get("isSidechain") == Some(&Value::Bool(true)) {
        return None;
    }
    let items = line.pointer("/message/content")?.as_array()?;
    let text: Vec<&str> = items
        .iter()
        .filter(|i| str_at(i, "type") == "text")
        .map(|i| str_at(i, "text").trim())
        .filter(|t| !t.is_empty())
        .collect();
    (!text.is_empty()).then(|| text.join("\n"))
}

/// Lo último que dijo Claude en un transcript JSONL (las líneas, de la
/// última a la primera). Pura.
pub fn last_reply_in(jsonl: &str) -> Option<String> {
    jsonl
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find_map(|l| assistant_text(&l))
        .map(|t| clip(&t, MAX_CONTEXT))
}

/// `last_reply_in` sobre la cola del fichero.
pub fn last_reply(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    // La primera línea puede venir cortada: se descarta al no parsear.
    last_reply_in(&String::from_utf8_lossy(&buf))
}

/// Salida del hook. `None` = sin decisión (manda el diálogo de la terminal).
pub fn hook_output(allow: Option<bool>) -> Value {
    match allow {
        None => json!({}),
        Some(true) => json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {"behavior": "allow"},
            }
        }),
        Some(false) => json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "deny",
                    "message": "El usuario lo ha denegado desde Pupus. No lo intentes por otro camino.",
                },
            }
        }),
    }
}

/// Tarjeta del bocadillo a partir de la entrada del hook. Pura salvo la
/// lectura del transcript.
fn card(v: &Value) -> Value {
    let tool = str_at(v, "tool_name");
    let input = v.get("tool_input").cloned().unwrap_or(Value::Null);
    let transcript = str_at(v, "transcript_path");
    let context = if transcript.is_empty() {
        None
    } else {
        last_reply(Path::new(transcript))
    };
    json!({
        "tool": tool,
        "reason": format!("permiso para {tool}"),
        "summary": summary(tool, &input),
        "origin": origin(str_at(v, "cwd")),
        "context": context.unwrap_or_default(),
        "source": "terminal",
    })
}

/// `POST /v1/permission`: cuerpo = entrada del hook PermissionRequest.
/// `cancelled` dice si el hook ya no espera (conexión cerrada).
pub fn handle(app: &AppHandle, v: &Value, cancelled: &dyn Fn() -> bool) -> Value {
    let answer = approve::ask_until(app, &card(v), WAIT, cancelled);
    let allow = match answer {
        Answer::Allow => Some(true),
        Answer::Deny => Some(false),
        Answer::CannotAsk(reason) => {
            tracing::debug!(%reason, "mascota: permiso de terminal sin bocadillo");
            None
        }
        Answer::Expired | Answer::Cancelled => None,
    };
    hook_output(allow)
}

/// `mascot_session_context`: lo último que dijo Claude en una sesión de
/// ULTRON Sessions, para desplegar el chat en la tarjeta de su permiso.
/// `None` si la sesión no existe o aún no tiene transcript con texto.
#[tauri::command]
pub async fn mascot_session_context(session_id: String) -> Option<String> {
    use crate::sesiones::registro;
    tauri::async_runtime::spawn_blocking(move || {
        let (sid, cwd) = registro::read(&session_id, |s| {
            (s.info.claude_session_id.clone(), s.info.cwd.clone())
        })
        .ok()?;
        let path = registro::claude_projects_dir()?
            .join(registro::claude_slug(&cwd))
            .join(format!("{}.jsonl", sid?));
        last_reply(&path)
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
#[path = "tests_permission.rs"]
mod tests;
