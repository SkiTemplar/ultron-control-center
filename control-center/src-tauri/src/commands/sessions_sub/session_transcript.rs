// commands/sessions_sub/session_transcript.rs — lectura PAGINADA de un transcript completo.
//
// Hasta 2026-09-17 no habia forma de leer una conversacion entera: todo lo que
// existia estaba acotado a las 12 ultimas lineas (`read_jsonl_tail`, para el
// monitor de sesiones vivas) o al primer mensaje de usuario
// (`claude_sessions::extract_first_user_message`, 160 caracteres para el
// preview). La pestana Sessions podia LISTAR conversaciones pero no ensenar
// ninguna, asi que "abrir una conversacion antigua" significaba relanzar la CLI
// en una terminal externa.
//
// Este modulo cierra ese hueco para el navegador de conversaciones:
//
//   * Pagina por LINEAS, no por turnos. Contar lineas es un `memchr` sobre el
//     buffer; decidir "cuantos turnos hay" exigiria deserializar el fichero
//     entero, que es justo lo que queremos evitar (hay transcripts de varios
//     MB). El llamante pide [offset, offset+limit) y el propio resultado dice
//     si queda mas (`has_more`), asi que la UI puede seguir paginando sin
//     conocer el total de turnos por adelantado.
//   * Solo deserializa las lineas de la ventana pedida. Fuera de ella no se
//     parsea JSON.
//   * Nunca `read_to_string` del fichero completo: `BufReader::lines()` con
//     skip/take, mas un tope de caracteres por pagina (`MAX_PAGE_CHARS`) para
//     que un turno gigante no reviente el payload IPC.
//
// Reutiliza `session_summary::find_transcript` (ya es `pub` y ya esta endurecido
// contra path traversal) y los tipos tolerantes de `session_jsonl` en vez de
// duplicar el parseo.

use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;

use super::session_jsonl::extract_text;
use super::session_summary::find_transcript;

/// Lineas por pagina si el llamante no especifica. Una conversacion tipica de
/// trabajo ronda las 200-600 lineas, asi que 400 cubre la mayoria en una sola
/// llamada sin arriesgar un payload enorme.
const DEFAULT_LIMIT: usize = 400;

/// Tope duro de lineas por peticion: evita que un `limit` absurdo desde el
/// frontend materialice un fichero de varios MB en memoria y en el canal IPC.
const MAX_LIMIT: usize = 2_000;

/// Caracteres maximos de texto por turno. Un solo mensaje con un fichero
/// pegado dentro puede ocupar cientos de KB; el visor solo necesita lo
/// suficiente para leerlo, y marca el recorte.
const MAX_TURN_CHARS: usize = 12_000;

/// Presupuesto de caracteres de la pagina completa. Al alcanzarlo se deja de
/// anadir turnos y se marca `char_capped`, en vez de devolver un payload que
/// bloquee el render.
const MAX_PAGE_CHARS: usize = 240_000;

/// Un turno legible del transcript, ya normalizado para el visor.
#[derive(Debug, Serialize, PartialEq)]
pub struct TranscriptTurn {
    /// Indice de LINEA en el fichero (base 0). Es la unidad de paginacion y
    /// sirve de key estable en React.
    pub line: usize,
    /// "user" | "assistant" | "tool" | "system" | "other".
    ///
    /// `tool` son los `tool_result` que Claude Code emite como eventos de
    /// usuario: no los escribio la persona, asi que el visor debe poder
    /// colapsarlos aparte.
    pub role: String,
    /// ISO 8601 tal cual viene en el evento (sin reinterpretar la zona).
    pub timestamp: Option<String>,
    /// Texto legible del turno. `None` cuando el evento no aporta texto
    /// (p. ej. un turno que solo contiene tool_use).
    pub text: Option<String>,
    /// Modelo del turno assistant, si el evento lo trae.
    pub model: Option<String>,
    /// Nombres de las herramientas invocadas en el turno (`Bash`, `Edit`, …),
    /// para que el visor muestre chips sin tener que parsear el contenido.
    pub tools: Vec<String>,
    /// true cuando `text` se recorto por `MAX_TURN_CHARS`.
    pub truncated: bool,
}

/// Una pagina de transcript.
#[derive(Debug, Serialize)]
pub struct TranscriptPage {
    pub session_id: String,
    /// Ruta del `.jsonl` resuelto (util para depurar y para "abrir carpeta").
    pub path: String,
    /// Lineas no vacias del fichero. Barato: no deserializa nada.
    pub total_lines: usize,
    pub offset: usize,
    /// Lineas realmente consumidas en esta pagina (turnos + eventos sin texto).
    pub returned_lines: usize,
    pub has_more: bool,
    /// true si la pagina se corto por presupuesto de caracteres y no por
    /// `limit`: el llamante debe continuar desde `offset + returned_lines`.
    pub char_capped: bool,
    pub turns: Vec<TranscriptTurn>,
}

/// Texto legible de UN bloque de contenido.
///
/// `session_jsonl::extract_text` solo mira el campo `text`, que cubre los
/// bloques `{type:"text"}` pero deja fuera los `tool_result` — y esos guardan
/// su salida en `content`. Sin esto, un evento de tool_result se quedaba sin
/// texto y el rol "tool" no se emitia nunca (rama muerta).
///
/// Los bloques `thinking` se omiten a proposito: el visor muestra la
/// conversacion, no el razonamiento intermedio.
fn block_text(block: &serde_json::Value) -> Option<String> {
    match block.get("type").and_then(|v| v.as_str()) {
        Some("text") => block
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        Some("tool_result") => match block.get("content") {
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            Some(serde_json::Value::Array(inner)) => {
                let joined = inner
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join(" ");
                (!joined.is_empty()).then_some(joined)
            }
            _ => None,
        },
        _ => None,
    }
}

/// Texto legible del campo `content` completo de un mensaje. Tolera content
/// como string (mensaje de usuario normal) o como array de bloques.
fn content_text(content: &serde_json::Value, max_chars: usize) -> Option<String> {
    match content {
        serde_json::Value::Array(blocks) => {
            let joined = blocks
                .iter()
                .filter_map(block_text)
                .collect::<Vec<_>>()
                .join("\n");
            extract_text(&serde_json::Value::String(joined), max_chars)
        }
        other => extract_text(other, max_chars),
    }
}

/// Clasifica el evento y saca su texto. Pura: el test la ejercita sin I/O.
fn turn_from_event(line_no: usize, raw: &str) -> Option<TranscriptTurn> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    // `summary` y los eventos internos del harness no son conversacion.
    if matches!(event_type, "summary" | "file-history-snapshot") {
        return None;
    }
    let message = value.get("message");
    let content = message.and_then(|m| m.get("content"));

    // Herramientas invocadas en un turno assistant: bloques {type:"tool_use", name:…}.
    let mut tools: Vec<String> = Vec::new();
    let mut has_tool_result = false;
    if let Some(serde_json::Value::Array(blocks)) = content {
        for block in blocks {
            match block.get("type").and_then(|v| v.as_str()) {
                Some("tool_use") => {
                    if let Some(name) = block.get("name").and_then(|v| v.as_str()) {
                        if !tools.iter().any(|t| t == name) {
                            tools.push(name.to_string());
                        }
                    }
                }
                Some("tool_result") => has_tool_result = true,
                _ => {}
            }
        }
    }

    let role = match event_type {
        "assistant" => "assistant",
        // Un evento de usuario que solo trae tool_result lo emitio el harness,
        // no la persona.
        "user" if has_tool_result => "tool",
        "user" => "user",
        "system" => "system",
        _ => "other",
    };

    let text = content.and_then(|c| content_text(c, MAX_TURN_CHARS));
    let truncated = text.as_deref().is_some_and(|t| t.ends_with('…'));

    // Un evento sin texto ni herramientas no aporta nada al visor.
    if text.is_none() && tools.is_empty() {
        return None;
    }

    Some(TranscriptTurn {
        line: line_no,
        role: role.to_string(),
        timestamp: value
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        text,
        model: message
            .and_then(|m| m.get("model"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        tools,
        truncated,
    })
}

/// Cuenta lineas no vacias sin deserializar. O(bytes), sin parseo JSON.
fn count_lines(path: &Path) -> Result<usize, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("abrir transcript: {e}"))?;
    let mut count = 0usize;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| format!("leer transcript: {e}"))?;
        if !line.trim().is_empty() {
            count += 1;
        }
    }
    Ok(count)
}

/// Lee la ventana [offset, offset+limit) de lineas no vacias y devuelve sus turnos.
pub(crate) fn read_page(
    path: &Path,
    session_id: &str,
    offset: usize,
    limit: usize,
) -> Result<TranscriptPage, String> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let total_lines = count_lines(path)?;
    let file = std::fs::File::open(path).map_err(|e| format!("abrir transcript: {e}"))?;

    let mut turns: Vec<TranscriptTurn> = Vec::new();
    let mut seen = 0usize; // lineas no vacias vistas
    let mut consumed = 0usize; // lineas de la ventana ya procesadas
    let mut budget = MAX_PAGE_CHARS;
    let mut char_capped = false;

    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| format!("leer transcript: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let index = seen;
        seen += 1;
        if index < offset {
            continue;
        }
        if consumed >= limit {
            break;
        }
        if let Some(turn) = turn_from_event(index, &line) {
            let cost = turn.text.as_deref().map_or(0, str::len);
            // Se admite siempre el primer turno de la pagina: si un unico turno
            // excede el presupuesto, devolver la pagina vacia dejaria a la UI
            // sin poder avanzar nunca (bucle infinito de paginacion).
            if cost > budget && !turns.is_empty() {
                char_capped = true;
                break;
            }
            budget = budget.saturating_sub(cost);
            turns.push(turn);
        }
        consumed += 1;
    }

    Ok(TranscriptPage {
        session_id: session_id.to_string(),
        path: path.to_string_lossy().to_string(),
        total_lines,
        offset,
        returned_lines: consumed,
        has_more: offset + consumed < total_lines,
        char_capped,
        turns,
    })
}

/// Devuelve una pagina de la conversacion `session_id`.
///
/// `offset`/`limit` van en LINEAS no vacias del `.jsonl` (ver cabecera del
/// modulo). El id se resuelve con `find_transcript`, que ya rechaza separadores
/// de ruta y `..`, de modo que no se puede leer un fichero arbitrario.
#[tauri::command]
pub async fn read_session_transcript(
    session_id: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<TranscriptPage, String> {
    let path = find_transcript(&session_id)
        .ok_or_else(|| format!("no encuentro el transcript de la sesion '{session_id}'"))?;
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    // I/O bloqueante fuera del hilo async del runtime de Tauri.
    tauri::async_runtime::spawn_blocking(move || read_page(&path, &session_id, offset, limit))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_transcript(lines: &[&str]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sess.jsonl");
        let mut f = std::fs::File::create(&path).expect("create");
        for l in lines {
            writeln!(f, "{l}").expect("write");
        }
        (dir, path)
    }

    const USER: &str = r#"{"type":"user","timestamp":"2026-09-01T10:00:00Z","message":{"content":"arregla el login"}}"#;
    const ASSISTANT: &str = r#"{"type":"assistant","timestamp":"2026-09-01T10:00:05Z","message":{"model":"claude-opus-5","content":[{"type":"text","text":"voy a mirarlo"},{"type":"tool_use","name":"Bash","input":{}}]}}"#;
    const TOOL_RESULT: &str = r#"{"type":"user","timestamp":"2026-09-01T10:00:07Z","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#;

    #[test]
    fn lee_los_turnos_con_rol_modelo_y_herramientas() {
        let (_d, path) = write_transcript(&[USER, ASSISTANT, TOOL_RESULT]);
        let page = read_page(&path, "sess", 0, 100).expect("page");

        assert_eq!(page.total_lines, 3);
        assert_eq!(page.turns.len(), 3);
        assert!(!page.has_more);

        assert_eq!(page.turns[0].role, "user");
        assert_eq!(page.turns[0].text.as_deref(), Some("arregla el login"));
        assert_eq!(page.turns[0].timestamp.as_deref(), Some("2026-09-01T10:00:00Z"));

        assert_eq!(page.turns[1].role, "assistant");
        assert_eq!(page.turns[1].model.as_deref(), Some("claude-opus-5"));
        assert_eq!(page.turns[1].tools, vec!["Bash".to_string()]);

        // Un tool_result NO es un turno de la persona, y su salida se lee del
        // campo `content` del bloque (no de `text`).
        assert_eq!(page.turns[2].role, "tool");
        assert_eq!(page.turns[2].text.as_deref(), Some("ok"));
    }

    #[test]
    fn omite_los_bloques_de_razonamiento() {
        let thinking = r#"{"type":"assistant","message":{"model":"m","content":[{"type":"thinking","thinking":"deberia mirar el log"},{"type":"text","text":"mirando el log"}]}}"#;
        let (_d, path) = write_transcript(&[thinking]);
        let page = read_page(&path, "sess", 0, 10).expect("page");
        assert_eq!(page.turns[0].text.as_deref(), Some("mirando el log"));
    }

    #[test]
    fn pagina_por_lineas_y_marca_has_more() {
        let (_d, path) = write_transcript(&[USER, ASSISTANT, USER, ASSISTANT]);

        let first = read_page(&path, "sess", 0, 2).expect("page");
        assert_eq!(first.returned_lines, 2);
        assert_eq!(first.turns.len(), 2);
        assert!(first.has_more);

        let second = read_page(&path, "sess", 2, 2).expect("page");
        assert_eq!(second.turns.len(), 2);
        assert_eq!(second.turns[0].line, 2);
        assert!(!second.has_more);
    }

    #[test]
    fn ignora_lineas_malformadas_vacias_y_summary() {
        let summary = r#"{"type":"summary","summary":"titulo"}"#;
        let (_d, path) = write_transcript(&[USER, "", "{roto", summary, ASSISTANT]);
        let page = read_page(&path, "sess", 0, 100).expect("page");

        // La linea en blanco no cuenta; la malformada y el summary si ocupan
        // linea (la paginacion es por linea) pero no producen turno.
        assert_eq!(page.total_lines, 4);
        assert_eq!(page.turns.len(), 2);
        assert_eq!(page.turns[0].role, "user");
        assert_eq!(page.turns[1].role, "assistant");
    }

    #[test]
    fn recorta_un_turno_gigante_y_lo_marca() {
        let huge = format!(
            r#"{{"type":"user","message":{{"content":"{}"}}}}"#,
            "a".repeat(MAX_TURN_CHARS * 2)
        );
        let (_d, path) = write_transcript(&[&huge]);
        let page = read_page(&path, "sess", 0, 100).expect("page");

        let turn = &page.turns[0];
        assert!(turn.truncated);
        let len = turn.text.as_deref().map_or(0, str::len);
        assert!(len <= MAX_TURN_CHARS + 4, "longitud recortada: {len}");
    }

    #[test]
    fn nunca_devuelve_pagina_vacia_por_presupuesto() {
        // Caso negativo del tope de pagina: un unico turno que se pasa del
        // presupuesto DEBE salir igualmente, o la UI se queda sin poder avanzar.
        let big = "b".repeat(MAX_TURN_CHARS);
        let line = format!(r#"{{"type":"user","message":{{"content":"{big}"}}}}"#);
        let lines: Vec<&str> = (0..40).map(|_| line.as_str()).collect();
        let (_d, path) = write_transcript(&lines);

        let page = read_page(&path, "sess", 0, 100).expect("page");
        assert!(!page.turns.is_empty());
        assert!(page.char_capped, "deberia haberse cortado por presupuesto");
        assert!(page.has_more);

        // Y se puede continuar desde donde corto.
        let next = read_page(&path, "sess", page.returned_lines, 100).expect("page");
        assert!(!next.turns.is_empty());
    }

    #[test]
    fn offset_fuera_de_rango_devuelve_pagina_vacia_sin_error() {
        let (_d, path) = write_transcript(&[USER]);
        let page = read_page(&path, "sess", 99, 10).expect("page");
        assert!(page.turns.is_empty());
        assert!(!page.has_more);
        assert_eq!(page.total_lines, 1);
    }
}
