//! Traza por petición servida (`~/.ultron/logs/memory-daemon.jsonl`).
//!
//! Hasta 2026-09-07 el daemon no dejaba rastro de lo que servía, así que un
//! prompt degradado no se podía atribuir a nada: ni a modelos fríos, ni al
//! semáforo lleno, ni a trabajo real. Best-effort en todo: escribir el log
//! nunca puede hacer fallar la petición.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::protocol::Req;

/// Tope del log por petición antes de rotarlo a `.1` (un solo nivel).
const REQUEST_LOG_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// `~/.ultron/logs/memory-daemon.jsonl` — una línea por petición servida.
fn request_log_path() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".ultron")
            .join("logs")
            .join("memory-daemon.jsonl"),
    )
}

/// Línea JSONL de una petición ya servida: comando, milisegundos, resultado
/// (`ok`, `busy` o el `error` devuelto), estado de los modelos antes y después,
/// y para `orchestrate`/`recall` el proyecto, el tamaño del prompt y cuántas
/// memorias salieron. Best-effort: nunca falla la petición por el log.
pub(super) fn log_request(req: &Req, resp: &Value, elapsed: Duration, models_before: &[&str]) {
    let Some(path) = request_log_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    let error = resp.get("error").and_then(Value::as_str);
    let memories = resp
        .get("memories")
        .or_else(|| resp.get("entries"))
        .and_then(Value::as_array)
        .map(Vec::len);
    let line = json!({
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "pid": std::process::id(),
        "cmd": req.cmd,
        "ms": elapsed.as_millis() as u64,
        "ok": error.is_none(),
        "busy": error == Some("busy"),
        "error": error,
        "project": req.project,
        // `embed` no manda `prompt` sino `text`: se registra su tamano por el
        // mismo campo para que el log tenga una sola columna de "cuanto texto".
        "prompt_chars": req
            .prompt
            .as_deref()
            .or(req.text.as_deref())
            .map(|p| p.chars().count()),
        "memories": memories,
        "models_before": models_before,
        "models_after": crate::qdrant::loaded_models(),
        "rerank_model": crate::qdrant::reranker_model_id(),
        "rerank_hot": resp.get("rerank_hot").and_then(Value::as_bool),
    });
    rotate_if_large(&path);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{line}");
    }
}

/// Rotación de un nivel: pasado el tope, el fichero actual pasa a `.1` y se
/// empieza uno nuevo. Suficiente para un log de una línea por prompt.
fn rotate_if_large(path: &Path) {
    let too_big = std::fs::metadata(path)
        .map(|m| m.len() > REQUEST_LOG_MAX_BYTES)
        .unwrap_or(false);
    if too_big {
        let rotated = path.with_extension("jsonl.1");
        let _ = std::fs::rename(path, rotated);
    }
}
