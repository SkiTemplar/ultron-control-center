// commands/sessions_sub/session_jsonl.rs — Primitivas de lectura/parseo de transcripts JSONL.
//
// Extraído de session_manager.rs (cat7.3 split). Agrupa la lectura de cola
// O(TAIL_LINES) de un `.jsonl`, los tipos de deserialización tolerantes de los
// eventos, el parseo de timestamps ISO 8601 y la extracción de texto legible.
// Sin I/O de Tauri ni lógica de negocio: solo bytes -> structs.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

/// Bytes medios por línea JSONL en un transcript de Claude Code. Usado para
/// acotar el seek desde el final (igual que en live_session.rs).
pub(crate) const AVG_LINE_BYTES: u64 = 400;

/// Líneas de cola a leer de cada fichero. 12 es suficiente para capturar
/// el último turno assistant (con usage) + el último mensaje de usuario.
pub(crate) const TAIL_LINES: usize = 12;

/// Caracteres máximos del último prompt / resumen de actividad que se devuelven
/// al frontend para evitar payloads gigantes.
pub(crate) const MAX_SUMMARY_CHARS: usize = 200;

// ---------------------------------------------------------------------------
// Tipos de deserialización de los eventos JSONL (campos opcionales para tolerar
// variaciones de esquema entre versiones de Claude Code)
// ---------------------------------------------------------------------------

/// Uso de tokens en un turno assistant.
#[derive(Debug, Deserialize, Default)]
pub(crate) struct Usage {
    #[serde(default)]
    pub(crate) input_tokens: u64,
    #[serde(default)]
    pub(crate) output_tokens: u64,
    #[serde(default)]
    pub(crate) cache_read_input_tokens: u64,
    #[serde(default)]
    pub(crate) cache_creation_input_tokens: u64,
}

/// Mensaje anidado dentro de un evento assistant.
#[derive(Debug, Deserialize)]
pub(crate) struct AssistantMessage {
    #[serde(default)]
    pub(crate) model: Option<String>,
    #[serde(default)]
    pub(crate) usage: Option<Usage>,
    // Contenido libre — sólo nos interesa el primer bloque de texto.
    #[serde(default)]
    pub(crate) content: Vec<serde_json::Value>,
    #[serde(default)]
    pub(crate) stop_reason: Option<String>,
}

/// Mensaje de usuario anidado (puede ser texto o tool_result).
#[derive(Debug, Deserialize)]
pub(crate) struct UserMessage {
    #[serde(default)]
    pub(crate) content: serde_json::Value,
}

/// Evento de un transcript JSONL de Claude Code (sólo los campos que nos interesan).
#[derive(Debug, Deserialize)]
pub(crate) struct TranscriptEvent {
    #[serde(rename = "type")]
    pub(crate) event_type: Option<String>,
    /// ISO 8601 con zona horaria (ej. "2026-06-20T10:30:00.123Z").
    pub(crate) timestamp: Option<String>,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(rename = "gitBranch", default)]
    pub(crate) git_branch: Option<String>,
    /// Presente en eventos "assistant".
    #[serde(default)]
    pub(crate) message: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Lectura de cola O(TAIL_LINES) — reutiliza la misma técnica que live_session
// ---------------------------------------------------------------------------

/// Lee las últimas `limit` líneas válidas de un `.jsonl`, de más nuevo a más viejo.
/// El seek desde el final mantiene el coste acotado independientemente del tamaño del
/// fichero. Las líneas en blanco, malformadas o de esquema antiguo se ignoran
/// silenciosamente. Devuelve `Vec::new()` si el fichero no existe o no es legible.
pub(crate) fn read_jsonl_tail<T: serde::de::DeserializeOwned>(path: &Path, limit: usize) -> Vec<T> {
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
pub(crate) fn parse_iso8601_secs(ts: &str) -> Option<u64> {
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
pub(crate) fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Extracción de texto legible del contenido de un mensaje
// ---------------------------------------------------------------------------

/// Extrae hasta `max_chars` caracteres de texto del campo `content` de un
/// mensaje assistant o user. Tolera content como string, array de bloques
/// [{type:"text", text:"…"}], o cualquier otro valor JSON (se usa su repr).
pub(crate) fn extract_text(content: &serde_json::Value, max_chars: usize) -> Option<String> {
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
// Tests unitarios del parseo JSONL
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn extract_text_array_de_bloques() {
        let content = serde_json::json!([
            {"type": "text", "text": "hola"},
            {"type": "text", "text": "mundo"}
        ]);
        assert_eq!(extract_text(&content, 200).as_deref(), Some("hola mundo"));
    }

    #[test]
    fn extract_text_string_vacio_es_none() {
        let content = serde_json::Value::String("   ".to_string());
        assert!(extract_text(&content, 200).is_none());
    }
}
