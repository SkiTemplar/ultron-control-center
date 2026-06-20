// commands/sessions_sub/session_manager.rs — Gestor de Sesiones multi-sesión (READ-ONLY).
//
// Escanea `~/.claude/projects/*/*.jsonl` y devuelve metadatos de cada sesión
// de Claude Code encontrada en disco. No escribe nada ni accede a ningún PID
// map; el estado se infiere por recencia del último evento.
//
// Patrón de lectura: igual que `live_session::read_jsonl_tail` — seek desde el
// final para que el coste sea O(TAIL_LINES), no O(tamaño del fichero). Los
// transcripts pesan MBs; no se leen enteros.
//
// Convención de nombres de fichero:
//   <session-uuid>.jsonl  -> sesión normal (is_subagent = false)
//   agent-*.jsonl         -> subagente      (is_subagent = true)
//   journal.jsonl         -> ignorado siempre

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::projects::read_ops::list_projects_inner;

// ---------------------------------------------------------------------------
// Umbrales de clasificación de estado (sin PID, inferidos por recencia)
// ---------------------------------------------------------------------------

/// Límite superior de "en curso / esperando respuesta del usuario" (segundos).
const THRESHOLD_WORKING_SECS: u64 = 90;
/// Hasta este umbral la sesión se considera "inactiva pero reciente" (5 horas).
const THRESHOLD_IDLE_SECS: u64 = 5 * 3600;

/// Ventana de contexto por defecto de Claude Code (modelos Sonnet/Opus estándar).
const CONTEXT_LIMIT_DEFAULT: u64 = 200_000;
/// Ventana extendida (beta "context-1m", sesiones lanzadas con el modelo `[1m]`).
const CONTEXT_LIMIT_EXTENDED: u64 = 1_000_000;

/// Bytes medios por línea JSONL en un transcript de Claude Code. Usado para
/// acotar el seek desde el final (igual que en live_session.rs).
const AVG_LINE_BYTES: u64 = 400;

/// Líneas de cola a leer de cada fichero. 12 es suficiente para capturar
/// el último turno assistant (con usage) + el último mensaje de usuario.
const TAIL_LINES: usize = 12;

/// Caracteres máximos del último prompt / resumen de actividad que se devuelven
/// al frontend para evitar payloads gigantes.
const MAX_SUMMARY_CHARS: usize = 200;

// ---------------------------------------------------------------------------
// Struct público de salida (contrato con el frontend — snake_case, sin rename)
// ---------------------------------------------------------------------------

/// Información de una sesión de Claude Code leída desde el transcript JSONL.
#[derive(Debug, Serialize)]
pub struct SessionInfo {
    /// UUID de la sesión (nombre del fichero sin extensión).
    pub session_id: String,
    /// Directorio de trabajo (`cwd`) de la sesión.
    pub project_path: String,
    /// Nombre legible derivado del `ProjectInfo` de ULTRON o del último componente del cwd.
    pub project_name: String,
    /// ID del proyecto ULTRON cuyo `path` coincide con el cwd de la sesión, si hay match.
    pub matched_project_id: Option<String>,
    /// Rama git en el momento del último evento.
    pub git_branch: Option<String>,
    /// Modelo usado en el último turno assistant (ej. "claude-opus-4-8").
    pub model: Option<String>,
    /// Contexto de ENTRADA del último turno assistant: input + cache_read + cache_creation
    /// (sin output, que no ocupa ventana de entrada).
    pub context_tokens: u64,
    /// Ventana de contexto inferida (200 000 estándar / 1 000 000 extendida `[1m]`).
    /// El denominador real usado para `context_pct`. Ver `context_window_for`.
    pub context_limit: u64,
    /// `context_tokens / context_limit * 100`, acotado a 100.0.
    pub context_pct: f32,
    /// `cache_read_input_tokens` del último turno assistant.
    pub cache_read_tokens: u64,
    /// `output_tokens` del último turno assistant.
    pub output_tokens: u64,
    /// Estado inferido: "working" | "waiting" | "idle" | "dead".
    pub status: String,
    /// Timestamp ISO 8601 del último evento.
    pub last_activity: String,
    /// Segundos transcurridos desde `last_activity` (calculado en el momento de la llamada).
    pub age_seconds: u64,
    /// Último mensaje de usuario, recortado a `MAX_SUMMARY_CHARS` chars.
    pub last_prompt: Option<String>,
    /// Resumen del último evento (texto assistant o nombre de tool), ~200 chars.
    pub last_activity_summary: Option<String>,
    /// Verdadero para ficheros cuyo nombre empieza por "agent-".
    pub is_subagent: bool,
}

// ---------------------------------------------------------------------------
// Tipos de deserialización de los eventos JSONL (campos opcionales para tolerar
// variaciones de esquema entre versiones de Claude Code)
// ---------------------------------------------------------------------------

/// Uso de tokens en un turno assistant.
#[derive(Debug, Deserialize, Default)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

/// Mensaje anidado dentro de un evento assistant.
#[derive(Debug, Deserialize)]
struct AssistantMessage {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<Usage>,
    // Contenido libre — sólo nos interesa el primer bloque de texto.
    #[serde(default)]
    content: Vec<serde_json::Value>,
    #[serde(default)]
    stop_reason: Option<String>,
}

/// Mensaje de usuario anidado (puede ser texto o tool_result).
#[derive(Debug, Deserialize)]
struct UserMessage {
    #[serde(default)]
    content: serde_json::Value,
}

/// Evento de un transcript JSONL de Claude Code (sólo los campos que nos interesan).
#[derive(Debug, Deserialize)]
struct TranscriptEvent {
    #[serde(rename = "type")]
    event_type: Option<String>,
    /// ISO 8601 con zona horaria (ej. "2026-06-20T10:30:00.123Z").
    timestamp: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(rename = "gitBranch", default)]
    git_branch: Option<String>,
    /// Presente en eventos "assistant".
    #[serde(default)]
    message: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Lectura de cola O(TAIL_LINES) — reutiliza la misma técnica que live_session
// ---------------------------------------------------------------------------

/// Lee las últimas `limit` líneas válidas de un `.jsonl`, de más nuevo a más viejo.
/// El seek desde el final mantiene el coste acotado independientemente del tamaño del
/// fichero. Las líneas en blanco, malformadas o de esquema antiguo se ignoran
/// silenciosamente. Devuelve `Vec::new()` si el fichero no existe o no es legible.
fn read_jsonl_tail<T: serde::de::DeserializeOwned>(path: &Path, limit: usize) -> Vec<T> {
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let file_len = file.seek(SeekFrom::End(0)).unwrap_or(0);
    // Cola suficiente para `limit` líneas con margen x4 para líneas malformadas.
    let want = (limit as u64 + 4)
        .saturating_mul(AVG_LINE_BYTES)
        .saturating_mul(4);
    let start = file_len.saturating_sub(want);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    // from_utf8_lossy evita panics si el seek partió un carácter multibyte.
    let text = String::from_utf8_lossy(&bytes);
    // Si no arrancamos desde el inicio, la primera línea puede venir cortada.
    let body: &str = if start > 0 {
        match text.find('\n') {
            Some(i) => &text[i + 1..],
            None => "",
        }
    } else {
        &text
    };
    let mut out: Vec<T> = body
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<T>(l).ok())
        .collect();
    if out.len() > limit {
        out = out.split_off(out.len() - limit);
    }
    out.reverse(); // más reciente primero
    out
}

// ---------------------------------------------------------------------------
// Parsing de timestamp ISO 8601 -> segundos UNIX (sin deps nuevas)
// ---------------------------------------------------------------------------

/// Convierte un timestamp ISO 8601 (con o sin zona horaria) a segundos UNIX.
/// Soporta los formatos que emite Claude Code:
///   "2026-06-20T10:30:00.123Z"
///   "2026-06-20T10:30:00Z"
///   "2026-06-20T10:30:00+00:00"
/// Devuelve `None` si el formato no es reconocible.
fn parse_iso8601_secs(ts: &str) -> Option<u64> {
    // chrono está disponible con feature "serde" según Cargo.toml.
    use chrono::DateTime;
    // Intentar con zona horaria fija (el formato más común en los JSONL).
    if let Ok(dt) = DateTime::parse_from_rfc3339(ts) {
        return u64::try_from(dt.timestamp()).ok();
    }
    // Fallback: naive UTC (sin zona explícita — toma los primeros 19 caracteres).
    if let Some(dt) = ts
        .get(..19)
        .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok())
    {
        return u64::try_from(dt.and_utc().timestamp()).ok();
    }
    None
}

/// Segundos UNIX actuales (nunca falla; devuelve 0 en el improbable caso de
/// que el reloj del sistema esté antes de UNIX epoch).
fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Inferencia de la ventana de contexto real
// ---------------------------------------------------------------------------

/// Infiere la ventana de contexto de la sesión a partir del contexto observado.
///
/// El transcript de Claude Code NO registra de forma estructurada si la sesión
/// usa la ventana extendida de 1M: el campo `model` es `"claude-opus-4-8"` sin
/// el sufijo `[1m]` (verificado en runtime sobre los `.jsonl` reales). Pero un
/// contexto que supera los 200 000 tokens sólo es físicamente posible en la
/// ventana de 1M — así que el propio uso ES la señal fiable.
///
/// ALCANCE (mandamiento 13): una sesión de 1M cuyo uso *actual* sea inferior a
/// 200 000 tokens se reportará sobre el límite de 200 000. No hay forma de
/// distinguirla de una sesión estándar sin una señal estructurada que el
/// transcript no expone.
fn context_window_for(context_tokens: u64) -> u64 {
    if context_tokens > CONTEXT_LIMIT_DEFAULT {
        CONTEXT_LIMIT_EXTENDED
    } else {
        CONTEXT_LIMIT_DEFAULT
    }
}

// ---------------------------------------------------------------------------
// Clasificación de estado (sin PID map)
// ---------------------------------------------------------------------------

/// Infiere el estado de la sesión a partir de la edad del último evento y el
/// tipo del último evento visible en la cola leída.
///
/// Umbrales documentados como constantes en la cabecera del módulo:
/// - `THRESHOLD_WORKING_SECS` = 90 s  → "working" o "waiting"
/// - `THRESHOLD_IDLE_SECS`    = 5 h   → "idle"
/// - más de 5 h               → "dead"
fn classify_status(
    age_secs: u64,
    last_event_type: &str,
    stop_reason: Option<&str>,
) -> &'static str {
    if age_secs < THRESHOLD_WORKING_SECS {
        // Sesión reciente: distinguir si el asistente terminó su turno o sigue
        // procesando.
        if last_event_type == "assistant"
            && matches!(stop_reason, Some("end_turn") | Some("stop_sequence"))
        {
            // El asistente terminó; está esperando que el usuario responda.
            "waiting"
        } else {
            // Evento user reciente, o assistant sin stop_reason (posiblemente en
            // curso) → consideramos que está trabajando.
            "working"
        }
    } else if age_secs < THRESHOLD_IDLE_SECS {
        "idle"
    } else {
        "dead"
    }
}

// ---------------------------------------------------------------------------
// Extracción de texto legible del contenido de un mensaje
// ---------------------------------------------------------------------------

/// Extrae hasta `max_chars` caracteres de texto del campo `content` de un
/// mensaje assistant o user. Tolera content como string, array de bloques
/// [{type:"text", text:"…"}], o cualquier otro valor JSON (se usa su repr).
fn extract_text(content: &serde_json::Value, max_chars: usize) -> Option<String> {
    let raw = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => {
            // Bloques de contenido de Claude: [{type:"text", text:"…"}, …]
            arr.iter()
                .filter_map(|block| {
                    block
                        .get("text")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
                .join(" ")
        }
        other => other.to_string(),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Recortar a max_chars en un límite de carácter Unicode válido.
    if trimmed.len() <= max_chars {
        Some(trimmed.to_string())
    } else {
        let cut: String = trimmed.chars().take(max_chars).collect();
        Some(format!("{cut}…"))
    }
}

// ---------------------------------------------------------------------------
// Match de sesión con proyecto ULTRON
// ---------------------------------------------------------------------------

/// Intenta encontrar un `ProjectInfo` cuyo `path` sea igual (o prefijo) del
/// `session_cwd`. Devuelve el `id` del primer proyecto que casa.
///
/// Estrategia: primero match exacto (normalizado con barras hacia adelante para
/// evitar diferencias Windows vs Unix), luego prefijo más largo.
fn match_project_id(
    session_cwd: &str,
    projects: &[crate::projects::types::ProjectInfo],
) -> Option<String> {
    // Normalizar separadores para la comparación.
    let norm_cwd = session_cwd.replace('\\', "/").to_lowercase();

    // 1. Match exacto (ignorando barra final).
    let exact = projects.iter().find(|p| {
        p.path
            .as_deref()
            .map(|pp| {
                let np = pp.replace('\\', "/").to_lowercase();
                np.trim_end_matches('/') == norm_cwd.trim_end_matches('/')
            })
            .unwrap_or(false)
    });
    if let Some(p) = exact {
        return Some(p.id.clone());
    }

    // 2. Prefijo más largo: el proyecto cuyo path es el prefijo más específico
    //    del cwd de la sesión (útil cuando la sesión es una subcarpeta).
    projects
        .iter()
        .filter_map(|p| {
            let pp = p.path.as_deref()?;
            let np = pp.replace('\\', "/").to_lowercase();
            let prefix = format!("{}/", np.trim_end_matches('/'));
            if norm_cwd.starts_with(&prefix) || norm_cwd == np.trim_end_matches('/') {
                Some((prefix.len(), p.id.clone()))
            } else {
                None
            }
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, id)| id)
}

// ---------------------------------------------------------------------------
// Nombre legible de un cwd
// ---------------------------------------------------------------------------

/// Devuelve el nombre del proyecto ULTRON si hay match; de lo contrario extrae
/// el último componente del cwd (separadores Windows y Unix).
fn readable_name(
    cwd: &str,
    matched_id: Option<&str>,
    projects: &[crate::projects::types::ProjectInfo],
) -> String {
    if let Some(id) = matched_id {
        if let Some(p) = projects.iter().find(|p| p.id == id) {
            if let Some(name) = p.name.as_deref().filter(|n| !n.is_empty()) {
                return name.to_string();
            }
        }
    }
    // Último componente del path (separadores mixtos).
    // `rfind` es O(n) pero desde el final, que es lo idiomático para clippy.
    let normalised = cwd.replace('\\', "/");
    normalised
        .split('/')
        .rfind(|s| !s.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

// ---------------------------------------------------------------------------
// Procesamiento de un único fichero JSONL
// ---------------------------------------------------------------------------

/// Procesa un fichero JSONL de transcript y devuelve un `SessionInfo` o `None`
/// si el fichero está vacío, malformado, o corresponde a `journal.jsonl`.
///
/// Fail-safe: nunca hace panic; los errores se propagan como `None`.
fn parse_session_file(
    path: &Path,
    is_subagent: bool,
    projects: &[crate::projects::types::ProjectInfo],
    now_secs: u64,
) -> Option<SessionInfo> {
    let file_name = path.file_name()?.to_string_lossy().to_string();

    // Ignorar journal.jsonl siempre.
    if file_name == "journal.jsonl" {
        return None;
    }

    // ID de sesión = nombre del fichero sin extensión.
    let session_id = file_name.trim_end_matches(".jsonl").to_string();

    // Leer la cola del fichero — suficiente para el último turno assistant
    // (con usage) + el último mensaje de usuario.
    let events: Vec<TranscriptEvent> = read_jsonl_tail(path, TAIL_LINES);
    if events.is_empty() {
        return None;
    }

    // El evento más reciente CON timestamp marca la recencia de la sesión.
    // Claude Code reescribe al final del fichero eventos de metadata SIN timestamp
    // (permission-mode, last-prompt, ai-title, mode, bridge-session, queue-operation…);
    // si tomáramos `events[0]` a ciegas, su timestamp ausente descartaría la sesión
    // entera (era el bug "faltan sesiones": la sesión en curso no aparecía).
    let last_ts_event = events.iter().find(|e| e.timestamp.is_some())?;
    let last_ts = last_ts_event.timestamp.clone().unwrap_or_default();
    let last_age = now_secs.saturating_sub(parse_iso8601_secs(&last_ts).unwrap_or(now_secs));

    // cwd y gitBranch del último evento (o de cualquier evento en la cola que
    // los tenga — Claude Code los emite en los primeros eventos de la sesión y
    // puede omitirlos en los intermedios).
    let cwd = events
        .iter()
        .find_map(|e| e.cwd.as_deref().filter(|s| !s.is_empty()))
        .unwrap_or("")
        .to_string();
    let git_branch = events
        .iter()
        .find_map(|e| e.git_branch.as_deref().filter(|s| !s.is_empty()))
        .map(str::to_string);

    // Búsqueda del último turno assistant con usage y del último prompt de usuario.
    let mut model: Option<String> = None;
    let mut context_tokens: u64 = 0;
    let mut cache_read_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut stop_reason: Option<String> = None;
    let mut last_activity_summary: Option<String> = None;
    let mut last_prompt: Option<String> = None;

    for event in &events {
        let etype = event.event_type.as_deref().unwrap_or("");

        if etype == "assistant" && model.is_none() {
            // Deserializar el campo `message` del evento assistant.
            if let Some(raw_msg) = &event.message {
                if let Ok(msg) = serde_json::from_value::<AssistantMessage>(raw_msg.clone()) {
                    if let Some(u) = &msg.usage {
                        // Contexto de ENTRADA del último turno = tamaño del prompt enviado
                        // (input no cacheado + cache leído + cache creado). El output_tokens
                        // es texto generado, NO ocupa ventana de entrada → no se suma (era la
                        // causa secundaria del context% inflado).
                        context_tokens = u.input_tokens
                            + u.cache_read_input_tokens
                            + u.cache_creation_input_tokens;
                        cache_read_tokens = u.cache_read_input_tokens;
                        output_tokens = u.output_tokens;
                    }
                    model = msg.model.filter(|s| !s.is_empty());
                    stop_reason = msg.stop_reason.clone();
                    // Resumen de actividad: primer bloque de texto del mensaje.
                    if let Some(first_content) = msg.content.first() {
                        last_activity_summary = extract_text(first_content, MAX_SUMMARY_CHARS);
                    }
                }
            }
        }

        // Último prompt de usuario (content como texto).
        if etype == "user" && last_prompt.is_none() {
            if let Some(raw_msg) = &event.message {
                if let Ok(umsg) = serde_json::from_value::<UserMessage>(raw_msg.clone()) {
                    last_prompt = extract_text(&umsg.content, MAX_SUMMARY_CHARS);
                }
            }
        }

        // Salir cuando ya tenemos todo lo que necesitamos.
        if model.is_some() && last_prompt.is_some() {
            break;
        }
    }

    let last_event_type = last_ts_event.event_type.as_deref().unwrap_or("");
    let status = classify_status(last_age, last_event_type, stop_reason.as_deref()).to_string();

    // Ventana real inferida del contexto observado (200k estándar / 1M extendida).
    let context_limit = context_window_for(context_tokens);
    let context_pct = ((context_tokens as f32 / context_limit as f32) * 100.0).min(100.0);

    // Match con proyectos ULTRON.
    let matched_project_id = if cwd.is_empty() {
        None
    } else {
        match_project_id(&cwd, projects)
    };
    let project_name = readable_name(&cwd, matched_project_id.as_deref(), projects);

    Some(SessionInfo {
        session_id,
        project_path: cwd,
        project_name,
        matched_project_id,
        git_branch,
        model,
        context_tokens,
        context_limit,
        context_pct,
        cache_read_tokens,
        output_tokens,
        status,
        last_activity: last_ts,
        age_seconds: last_age,
        last_prompt,
        last_activity_summary,
        is_subagent,
    })
}

// ---------------------------------------------------------------------------
// Función principal (lógica hermética, testeable sin Tauri)
// ---------------------------------------------------------------------------

/// Escanea `~/.claude/projects/*/*.jsonl`, infiere el estado de cada sesión y
/// devuelve la lista ordenada por `last_activity` descendente (más reciente primero).
///
/// - `journal.jsonl` se ignora siempre.
/// - Ficheros `agent-*.jsonl` se marcan con `is_subagent = true`.
/// - Una sesión malformada o vacía se omite sin propagar el error.
pub fn list_active_sessions_inner() -> Result<Vec<SessionInfo>, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "no se puede resolver el directorio home".to_string())?;
    let projects_dir = home.join(".claude").join("projects");

    // Cargar proyectos ULTRON una sola vez para el matching de cwd.
    // Si falla (proyectos no configurados) seguimos sin hacer match.
    let ultron_projects = list_projects_inner().unwrap_or_default();

    let now_secs = now_unix_secs();
    let mut sessions: Vec<SessionInfo> = Vec::new();

    // Iterar sobre las carpetas de proyecto de Claude Code.
    let Ok(project_dirs) = std::fs::read_dir(&projects_dir) else {
        // Si la carpeta no existe aún (usuario sin sesiones) devolvemos vacío.
        return Ok(Vec::new());
    };

    for dir_entry in project_dirs.flatten() {
        let dir_path = dir_entry.path();
        if !dir_path.is_dir() {
            continue;
        }

        let Ok(files) = std::fs::read_dir(&dir_path) else {
            continue;
        };

        for file_entry in files.flatten() {
            let file_path = file_entry.path();
            // Sólo procesar ficheros .jsonl.
            if file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let fname = file_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            // journal.jsonl se ignora antes de abrir el fichero.
            if fname == "journal.jsonl" {
                continue;
            }

            let is_subagent = fname.starts_with("agent-");

            if let Some(info) =
                parse_session_file(&file_path, is_subagent, &ultron_projects, now_secs)
            {
                sessions.push(info);
            }
        }
    }

    // Ordenar por last_activity descendente (ISO 8601 compara lexicográficamente).
    sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));

    Ok(sessions)
}

// ---------------------------------------------------------------------------
// Comando Tauri (wrapper asíncrono thin sobre la función hermética)
// ---------------------------------------------------------------------------

/// Devuelve todas las sesiones de Claude Code encontradas en disco, ordenadas
/// por actividad reciente. READ-ONLY — nunca escribe ni accede a PIDs.
#[tauri::command]
pub async fn list_active_sessions() -> Result<Vec<SessionInfo>, String> {
    list_active_sessions_inner()
}

// ---------------------------------------------------------------------------
// Tests unitarios herméticos (sin I/O de disco real, sin Tauri)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Helpers para construir JSONL de ejemplo en los tests
    // -----------------------------------------------------------------------

    /// Genera un evento assistant mínimo en formato JSONL con usage real.
    fn make_assistant_event(ts: &str, stop_reason: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "timestamp": ts,
            "cwd": "C:/Users/dev/projects/my-app",
            "gitBranch": "main",
            "sessionId": "test-session-001",
            "message": {
                "model": "claude-opus-4-8",
                "stop_reason": stop_reason,
                "usage": {
                    "input_tokens": 1500,
                    "output_tokens": 320,
                    "cache_read_input_tokens": 45000,
                    "cache_creation_input_tokens": 2000
                },
                "content": [
                    {"type": "text", "text": "Aquí está la implementación solicitada."}
                ]
            }
        })
        .to_string()
    }

    /// Genera un evento user mínimo en formato JSONL.
    fn make_user_event(ts: &str, prompt: &str) -> String {
        serde_json::json!({
            "type": "user",
            "timestamp": ts,
            "cwd": "C:/Users/dev/projects/my-app",
            "gitBranch": "main",
            "sessionId": "test-session-001",
            "message": {
                "content": prompt
            }
        })
        .to_string()
    }

    // -----------------------------------------------------------------------
    // Test 1: parseo de usage -> context_tokens
    // -----------------------------------------------------------------------

    #[test]
    fn context_tokens_suma_entrada_sin_output() {
        // Escenario: un transcript con un turno assistant y un turno user.
        let ts_assistant = "2026-06-20T10:00:00Z";
        let ts_user = "2026-06-20T10:00:30Z"; // más reciente

        let jsonl = format!(
            "{}\n{}\n",
            make_assistant_event(ts_assistant, "end_turn"),
            make_user_event(ts_user, "Añade tests unitarios")
        );

        // Escribir en fichero temporal para que parse_session_file lo procese.
        let dir = std::env::temp_dir().join("ultron_session_mgr_test_1");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-001.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        // Usamos un now_secs lejano para que la sesión quede como "dead"
        // (evita que el test dependa del reloj del sistema).
        let far_future = parse_iso8601_secs(ts_user).unwrap() + THRESHOLD_IDLE_SECS + 1;
        let info = parse_session_file(&file, false, &[], far_future).unwrap();

        // input(1500) + cache_read(45000) + cache_creation(2000) = 48500 (output NO suma)
        assert_eq!(
            info.context_tokens, 48_500,
            "context_tokens debe sumar la entrada (input + cache_read + cache_creation), sin output"
        );
        // 48 500 <= 200 000 → ventana estándar.
        assert_eq!(info.context_limit, 200_000);
        assert_eq!(info.cache_read_tokens, 45_000);
        assert_eq!(info.output_tokens, 320);
        assert_eq!(info.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(info.session_id, "test-session-001");
        assert_eq!(info.is_subagent, false);

        // Limpieza
        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 2: clasificación de status "working"
    // -----------------------------------------------------------------------

    #[test]
    fn status_working_cuando_evento_reciente_sin_stop_reason() {
        // Timestamp muy reciente (1 segundo atrás).
        let now_secs = now_unix_secs();
        let recent_ts = {
            use chrono::{TimeZone, Utc};
            Utc.timestamp_opt(now_secs as i64 - 1, 0)
                .single()
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| "2026-06-20T10:00:00Z".to_string())
        };

        let jsonl = format!(
            "{}\n",
            make_assistant_event(&recent_ts, "") // sin stop_reason válido
        );

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_2");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-working.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let info = parse_session_file(&file, false, &[], now_secs).unwrap();

        // age < 90s + último evento assistant SIN "end_turn" -> "working"
        assert_eq!(
            info.status, "working",
            "debe ser 'working' con evento reciente sin stop_reason end_turn"
        );

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 3: clasificación de status "dead"
    // -----------------------------------------------------------------------

    #[test]
    fn status_dead_cuando_ultimo_evento_supera_5_horas() {
        let old_ts = "2026-06-19T00:00:00Z"; // ayer
        let jsonl = format!("{}\n", make_assistant_event(old_ts, "end_turn"));

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_3");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-dead.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        // now = viejo + 6 horas (supera THRESHOLD_IDLE_SECS)
        let old_secs = parse_iso8601_secs(old_ts).unwrap();
        let simulated_now = old_secs + THRESHOLD_IDLE_SECS + 3600;

        let info = parse_session_file(&file, false, &[], simulated_now).unwrap();
        assert_eq!(info.status, "dead", "debe ser 'dead' con age >= 5h");

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 4: "waiting" cuando assistant termina con end_turn en < 90s
    // -----------------------------------------------------------------------

    #[test]
    fn status_waiting_cuando_end_turn_reciente() {
        let now_secs = now_unix_secs();
        let recent_ts = {
            use chrono::{TimeZone, Utc};
            Utc.timestamp_opt(now_secs as i64 - 30, 0)
                .single()
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| "2026-06-20T10:00:00Z".to_string())
        };

        let jsonl = format!("{}\n", make_assistant_event(&recent_ts, "end_turn"));

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_4");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-waiting.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let info = parse_session_file(&file, false, &[], now_secs).unwrap();
        assert_eq!(
            info.status, "waiting",
            "debe ser 'waiting' con end_turn reciente"
        );

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 5: journal.jsonl se ignora
    // -----------------------------------------------------------------------

    #[test]
    fn journal_jsonl_se_ignora() {
        let dir = std::env::temp_dir().join("ultron_session_mgr_test_5");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("journal.jsonl");
        std::fs::write(
            &file,
            make_assistant_event("2026-06-20T10:00:00Z", "end_turn"),
        )
        .unwrap();

        let result = parse_session_file(&file, false, &[], now_unix_secs());
        assert!(result.is_none(), "journal.jsonl debe retornar None");

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 6: fichero con líneas malformadas no hace panic
    // -----------------------------------------------------------------------

    #[test]
    fn lineas_malformadas_se_ignoran_silenciosamente() {
        let ts = "2026-06-20T08:00:00Z";
        let jsonl = format!(
            "NOT JSON\n\n{{}}\n{}\n",
            make_assistant_event(ts, "end_turn")
        );

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_6");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-malformed.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let old_secs = parse_iso8601_secs(ts).unwrap();
        let simulated_now = old_secs + THRESHOLD_IDLE_SECS + 1;

        // No debe hacer panic; debe devolver Some con los datos del evento válido.
        let result = parse_session_file(&file, false, &[], simulated_now);
        assert!(
            result.is_some(),
            "debe parsear correctamente ignorando líneas malformadas"
        );

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 7: context_pct se acota a 100.0
    // -----------------------------------------------------------------------

    #[test]
    fn context_pct_se_acota_a_100() {
        // Para acotar a 100 los tokens deben superar la ventana extendida (1M).
        let tokens_over_limit: u64 = CONTEXT_LIMIT_EXTENDED + 500_000;
        let limit = context_window_for(tokens_over_limit); // = 1M
        let pct = ((tokens_over_limit as f32 / limit as f32) * 100.0).min(100.0);
        assert!(
            (pct - 100.0f32).abs() < f32::EPSILON,
            "context_pct debe acotarse a 100.0 aunque los tokens superen el límite"
        );
    }

    // -----------------------------------------------------------------------
    // Test 11: la ventana se infiere del contexto observado (bug context% ~100%)
    // -----------------------------------------------------------------------

    #[test]
    fn ventana_se_infiere_del_contexto_observado() {
        // <= 200k → ventana estándar.
        assert_eq!(context_window_for(0), 200_000);
        assert_eq!(context_window_for(150_000), 200_000);
        assert_eq!(context_window_for(200_000), 200_000);
        // > 200k sólo cabe en la ventana de 1M.
        assert_eq!(context_window_for(200_001), 1_000_000);
        assert_eq!(context_window_for(491_112), 1_000_000);
    }

    // -----------------------------------------------------------------------
    // Test 12: contexto de 491k da ~49% sobre 1M, NO 100% sobre 200k (el bug)
    // -----------------------------------------------------------------------

    #[test]
    fn context_pct_no_satura_en_sesion_de_1m() {
        // Reproduce el caso real medido en runtime: cache_read ~490k.
        let ts = "2026-06-20T10:00:00Z";
        let jsonl = format!(
            "{}\n",
            serde_json::json!({
                "type": "assistant",
                "timestamp": ts,
                "cwd": "C:/Users/dev/projects/my-app",
                "message": {
                    "model": "claude-opus-4-8",
                    "stop_reason": "end_turn",
                    "usage": {
                        "input_tokens": 2,
                        "output_tokens": 784,
                        "cache_read_input_tokens": 490_460,
                        "cache_creation_input_tokens": 650
                    },
                    "content": [{"type": "text", "text": "ok"}]
                }
            })
        );

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_12");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-1m.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let old = parse_iso8601_secs(ts).unwrap();
        let info = parse_session_file(&file, false, &[], old + THRESHOLD_IDLE_SECS + 1).unwrap();

        // entrada = 2 + 490460 + 650 = 491112 (sin output)
        assert_eq!(info.context_tokens, 491_112);
        assert_eq!(
            info.context_limit, 1_000_000,
            "debe detectar la ventana de 1M"
        );
        assert!(
            (info.context_pct - 49.1112).abs() < 0.1,
            "context_pct debe ser ~49%, no saturar a 100% — fue {}",
            info.context_pct
        );

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 13: un evento de metadata SIN timestamp al final no descarta la sesión
    // -----------------------------------------------------------------------

    #[test]
    fn metadata_final_sin_timestamp_no_descarta_sesion() {
        // Caso real: Claude Code reescribe permission-mode/last-prompt SIN timestamp
        // al final del fichero. La sesión debe seguir detectándose, fechada por el
        // último evento que SÍ tiene timestamp (el turno assistant).
        let ts_assistant = "2026-06-20T10:00:00Z";
        let jsonl = format!(
            "{}\n{}\n{}\n",
            make_assistant_event(ts_assistant, "end_turn"),
            serde_json::json!({"type": "last-prompt", "leafUuid": "x", "sessionId": "s"}),
            serde_json::json!({"type": "permission-mode", "mode": "default", "sessionId": "s"}),
        );

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_13");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-metadata-tail.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let old = parse_iso8601_secs(ts_assistant).unwrap();
        let result = parse_session_file(&file, false, &[], old + 10);

        assert!(
            result.is_some(),
            "la sesión NO debe descartarse por metadata final sin timestamp"
        );
        let info = result.unwrap();
        assert_eq!(
            info.last_activity, ts_assistant,
            "debe fecharse por el último evento CON timestamp"
        );
        // age = 10s → reciente y assistant end_turn → waiting.
        assert_eq!(info.status, "waiting");

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 8: is_subagent=true para ficheros agent-*
    // -----------------------------------------------------------------------

    #[test]
    fn agent_fichero_marcado_como_subagent() {
        let ts = "2026-06-20T09:00:00Z";
        let jsonl = format!("{}\n", make_assistant_event(ts, "end_turn"));

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_8");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("agent-abc123.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let old_secs = parse_iso8601_secs(ts).unwrap();
        let simulated_now = old_secs + THRESHOLD_IDLE_SECS + 1;

        let info = parse_session_file(&file, true, &[], simulated_now).unwrap();
        assert!(
            info.is_subagent,
            "agent-*.jsonl debe tener is_subagent=true"
        );
        assert_eq!(info.session_id, "agent-abc123");

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 9: parse_iso8601_secs reconoce los formatos de Claude Code
    // -----------------------------------------------------------------------

    #[test]
    fn parse_iso8601_reconoce_formatos_claude_code() {
        // Formato con milisegundos y Z.
        assert!(parse_iso8601_secs("2026-06-20T10:30:00.123Z").is_some());
        // Formato sin milisegundos y Z.
        assert!(parse_iso8601_secs("2026-06-20T10:30:00Z").is_some());
        // Formato con offset explícito.
        assert!(parse_iso8601_secs("2026-06-20T10:30:00+00:00").is_some());
        // Formato inválido.
        assert!(parse_iso8601_secs("no-es-fecha").is_none());
    }

    // -----------------------------------------------------------------------
    // Test 10: list_active_sessions_inner no hace panic aunque no haya carpeta
    // -----------------------------------------------------------------------

    #[test]
    fn list_active_sessions_no_panic_sin_carpeta_proyectos() {
        // Este test verifica que la función no hace panic incluso si
        // ~/.claude/projects/ no existe o está vacía. Simplemente devuelve Ok([]).
        // Como es un test de integración parcial (lee disco real), sólo verifica
        // que la llamada no hace panic y devuelve Result::Ok.
        let result = list_active_sessions_inner();
        assert!(
            result.is_ok(),
            "list_active_sessions_inner debe devolver Ok (nunca panic)"
        );
    }
}
