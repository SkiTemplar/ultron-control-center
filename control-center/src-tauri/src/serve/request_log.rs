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
        let _ = f.write_all(&jsonl_line(&line));
    }
}

/// La línea completa (con `\n`) en un solo búfer. `writeln!(f, "{value}")`
/// sobre un `File` sin búfer emite un `write` por token de `serde_json`, y con
/// peticiones concurrentes las líneas salían entrelazadas carácter a carácter
/// (`{{{{""""busy…`: 22 de 3.964 líneas ilegibles el 2026-09-23). Un único
/// `write_all` en modo append deja cada línea entera.
fn jsonl_line(value: &Value) -> Vec<u8> {
    let mut buf = value.to_string().into_bytes();
    buf.push(b'\n');
    buf
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonl_line_es_una_linea_json_completa() {
        let v = json!({"cmd": "orchestrate", "ms": 12, "error": null});
        let bytes = jsonl_line(&v);
        assert_eq!(*bytes.last().unwrap(), b'\n');
        let texto = std::str::from_utf8(&bytes[..bytes.len() - 1]).unwrap();
        assert!(!texto.contains('\n'));
        assert_eq!(serde_json::from_str::<Value>(texto).unwrap(), v);
    }

    #[test]
    fn escrituras_concurrentes_no_entrelazan_lineas() {
        let dir = std::env::temp_dir().join(format!("ultron-reqlog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("log.jsonl");
        let _ = std::fs::remove_file(&path);
        let hilos: Vec<_> = (0..8)
            .map(|t| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for i in 0..200 {
                        let v = json!({"hilo": t, "i": i, "relleno": "x".repeat(64)});
                        let mut f = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&path)
                            .unwrap();
                        f.write_all(&jsonl_line(&v)).unwrap();
                    }
                })
            })
            .collect();
        for h in hilos {
            h.join().unwrap();
        }
        let contenido = std::fs::read_to_string(&path).unwrap();
        let lineas: Vec<&str> = contenido.lines().collect();
        assert_eq!(lineas.len(), 8 * 200);
        assert!(lineas
            .iter()
            .all(|l| serde_json::from_str::<Value>(l).is_ok()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
