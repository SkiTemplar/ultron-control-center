// commands/sessions_sub/session_summary.rs — Resumen REAL de sesión vía AI Router.
//
// Ofrece `summarize_session_activity`: comando Tauri async-lazy que devuelve una
// frase en español describiendo qué está haciendo la sesión. Usa cache en memoria
// keyed por (session_id, hash_del_texto) para evitar llamadas redundantes al LLM.
//
// Contrato fijo con el frontend:
//   invoke("summarize_session_activity", { sessionId: "<uuid>" }) -> Promise<string>

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Mutex, OnceLock};

use super::session_jsonl::{extract_text, read_jsonl_tail, AssistantMessage, TAIL_LINES};

/// Chars máximos de texto que se envían al LLM para resumir (alto para contexto real).
const SUMMARIZE_MAX_CHARS: usize = 4_000;

// ---------------------------------------------------------------------------
// Cache en memoria: session_id -> (text_hash, resumen)
// ---------------------------------------------------------------------------

fn summary_cache() -> &'static Mutex<HashMap<String, (u64, String)>> {
    static SUMMARY_CACHE: OnceLock<Mutex<HashMap<String, (u64, String)>>> = OnceLock::new();
    SUMMARY_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Devuelve el resumen cacheado si el hash coincide (cache hit).
pub(crate) fn cache_get(session_id: &str, hash: u64) -> Option<String> {
    let cache = summary_cache().lock().ok()?;
    cache
        .get(session_id)
        .and_then(|(h, s)| if *h == hash { Some(s.clone()) } else { None })
}

/// Guarda (o actualiza) el resumen en cache.
pub(crate) fn cache_put(session_id: &str, hash: u64, summary: &str) {
    if let Ok(mut cache) = summary_cache().lock() {
        cache.insert(session_id.to_string(), (hash, summary.to_string()));
    }
}

// ---------------------------------------------------------------------------
// Resolución del transcript: busca <session_id>.jsonl bajo ~/.claude/projects/*/
// ---------------------------------------------------------------------------

fn find_transcript(session_id: &str) -> Option<std::path::PathBuf> {
    // Defensa (input boundary): el session_id es un nombre de fichero (UUID). Rechazar
    // vacío o cualquier separador de ruta / `..` para que no se pueda escapar de
    // ~/.claude/projects/ y leer un .jsonl arbitrario que luego iría al LLM (path traversal).
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return None;
    }
    let base = dirs::home_dir()?.join(".claude").join("projects");
    let filename = format!("{session_id}.jsonl");
    let entries = std::fs::read_dir(&base).ok()?;
    for entry in entries.flatten() {
        let path = entry.path().join(&filename);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Hash del texto con DefaultHasher (sin deps externas)
// ---------------------------------------------------------------------------

fn hash_text(text: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    std::hash::Hasher::finish(&hasher)
}

// ---------------------------------------------------------------------------
// Comando Tauri
// ---------------------------------------------------------------------------

/// Devuelve un resumen en UNA frase (español) de qué está haciendo la sesión.
///
/// * Resuelve el transcript `<session_id>.jsonl` bajo `~/.claude/projects/*/`.
/// * Lee el último turno assistant con `read_jsonl_tail` (O(TAIL_LINES)).
/// * Cache por (session_id, hash_del_texto): si el texto no cambió reutiliza
///   el resumen anterior sin llamar al LLM.
/// * Si el AI Router falla el frontend puede caer al truncado crudo existente.
#[tauri::command]
pub fn summarize_session_activity(session_id: String) -> Result<String, String> {
    // 1. Localizar el transcript.
    let path =
        find_transcript(&session_id).ok_or_else(|| "transcript no encontrado".to_string())?;

    // 2. Leer el último turno assistant y extraer su texto.
    let events = read_jsonl_tail::<serde_json::Value>(&path, TAIL_LINES);
    let text = events
        .iter()
        .find_map(|raw| {
            let etype = raw.get("type")?.as_str()?;
            if etype != "assistant" {
                return None;
            }
            let msg_val = raw.get("message")?;
            let msg: AssistantMessage = serde_json::from_value(msg_val.clone()).ok()?;
            let first = msg.content.first()?;
            extract_text(first, SUMMARIZE_MAX_CHARS)
        })
        .ok_or_else(|| "sin texto assistant en el transcript".to_string())?;

    // 3. Hash del texto para invalidación de cache.
    let h = hash_text(&text);

    // 4. Cache hit.
    if let Some(cached) = cache_get(&session_id, h) {
        return Ok(cached);
    }

    // 5. Miss / stale: llamar al AI Router.
    let prompt =
        format!("Resume en UNA sola frase, en español, qué está haciendo esta sesión:\n\n{text}");
    let summary = crate::ai_router::route("summarize", &prompt).map_err(|e| e.to_string())?;

    let summary = summary.trim().to_string();
    cache_put(&session_id, h, &summary);
    Ok(summary)
}

// ---------------------------------------------------------------------------
// Tests unitarios (sin I/O ni LLM)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_id() -> String {
        // Genera un ID de prueba único basado en el thread actual para aislar tests.
        format!("test-session-{:?}", std::thread::current().id())
    }

    #[test]
    fn cache_put_then_get_hit_same_hash() {
        let sid = unique_id();
        cache_put(&sid, 42, "resumen de prueba");
        let result = cache_get(&sid, 42);
        assert_eq!(result, Some("resumen de prueba".to_string()));
    }

    #[test]
    fn cache_get_miss_different_hash() {
        let sid = format!("{}-b", unique_id());
        cache_put(&sid, 100, "resumen antiguo");
        // Hash distinto → stale, debe devolver None.
        let result = cache_get(&sid, 999);
        assert!(result.is_none());
    }

    #[test]
    fn cache_get_miss_unknown_session() {
        let result = cache_get("session-que-no-existe", 0);
        assert!(result.is_none());
    }

    #[test]
    fn hash_text_deterministic() {
        let h1 = hash_text("mismo texto");
        let h2 = hash_text("mismo texto");
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_text_differs_for_different_input() {
        let h1 = hash_text("texto A");
        let h2 = hash_text("texto B");
        assert_ne!(h1, h2);
    }

    #[test]
    fn find_transcript_rejects_path_traversal() {
        // La validación de boundary corta ANTES de tocar el FS, así que estos no
        // dependen de ~/.claude/projects ni leen ningún fichero.
        assert!(find_transcript("../secreto").is_none());
        assert!(find_transcript("a/b").is_none());
        assert!(find_transcript("a\\b").is_none());
        assert!(find_transcript("").is_none());
    }
}
