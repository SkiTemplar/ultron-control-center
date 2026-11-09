// sesiones/opencode_parse.rs — Interpretación de la salida de OpenCode.
//
// `opencode run --format json` (1.19.4, comprobado el 2026-10-26) emite una
// línea JSON por evento, todas con `sessionID`:
//   - `step_start`
//   - `text`: `part.text` completo de un bloque de respuesta (con `time.end`)
//   - `tool_use`: `part.tool` (`write`, `edit`, `bash`, `read`…) y
//     `part.state` (`status`, `input`, `title`, `metadata.filepath`)
//   - `step_finish`: `part.reason` (`tool-calls` | `stop`), `part.tokens`
//     (`input`, `output`, `reasoning`, `cache.read`, `cache.write`), `part.cost`
//   - `error`: `error.name` y `error.data.message` (sale con código 1)
//
// Si el proveedor falla, OpenCode a veces no sale: el motivo solo llega por
// stderr (`--print-logs --log-level ERROR`). Cada fallo del stream deja
// `message="stream error" … small=… error.error="AI_…"`, pero tras él OpenCode
// reintenta (los errores reintentables, con espera) y el modelo pequeño
// (`small=true`, título o resumen) no corta el turno: esas líneas no cuentan.
// El fallo final, con los reintentos agotados o un error no reintentable, es
// `SessionProcessor.halt`: `level=ERROR … message=process … error="…"` (solo
// del procesador de turnos; el modelo pequeño no pasa por él). `fallo_stderr`
// solo da por final un `AI_RetryError` o un error no reintentable reconocible
// (lista positiva, como `delegate.mjs`) y entonces `motor` mata el árbol de
// procesos; cualquier otro error (503, 429 suelto, «prompt is too long», que
// OpenCode compacta) deja seguir al proceso.

use serde_json::Value;

use super::codex_parse::{evt, LineOutcome};
use super::types::EngineUsage;

/// Herramientas de OpenCode que escriben ficheros.
const EDICIONES: &[&str] = &["write", "edit", "patch", "multiedit"];

/// Intérprete con estado: acumula los tokens de todos los pasos del turno.
#[derive(Default)]
pub struct OpencodeParser {
    usage: Option<EngineUsage>,
}

fn s(v: &Value, p: &str) -> Option<String> {
    v.pointer(p)
        .and_then(Value::as_str)
        .filter(|x| !x.is_empty())
        .map(str::to_string)
}

impl OpencodeParser {
    pub fn line(&mut self, line: &str) -> LineOutcome {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            return LineOutcome::default();
        };
        let mut out = match v.get("type").and_then(Value::as_str).unwrap_or_default() {
            "text" => texto(&v["part"]),
            "tool_use" => herramienta(&v["part"]),
            "step_finish" => self.fin_de_paso(&v["part"]),
            "error" => error(&v["error"]),
            _ => LineOutcome::default(),
        };
        out.thread_id = s(&v, "/sessionID");
        out
    }

    fn fin_de_paso(&mut self, part: &Value) -> LineOutcome {
        let n = |p: &str| part.pointer(p).and_then(Value::as_u64).unwrap_or(0);
        let paso = EngineUsage {
            input_tokens: n("/tokens/input") + n("/tokens/cache/read"),
            cached_input_tokens: n("/tokens/cache/read"),
            output_tokens: n("/tokens/output") + n("/tokens/reasoning"),
        };
        let total = match self.usage.take() {
            Some(u) => EngineUsage {
                input_tokens: u.input_tokens + paso.input_tokens,
                cached_input_tokens: u.cached_input_tokens + paso.cached_input_tokens,
                output_tokens: u.output_tokens + paso.output_tokens,
            },
            None => paso,
        };
        self.usage = Some(total);
        LineOutcome {
            usage: Some(total),
            completed: s(part, "/reason").as_deref() == Some("stop"),
            ..LineOutcome::default()
        }
    }
}

fn texto(part: &Value) -> LineOutcome {
    let Some(text) = s(part, "/text").map(|t| t.trim().to_string()) else {
        return LineOutcome::default();
    };
    LineOutcome {
        event: evt("message", text.clone()),
        message: Some(text).filter(|t| !t.is_empty()),
        ..LineOutcome::default()
    }
}

fn herramienta(part: &Value) -> LineOutcome {
    let tool = s(part, "/tool").unwrap_or_else(|| "herramienta".into());
    let estado = s(part, "/state/status").unwrap_or_default();
    let event = if EDICIONES.contains(&tool.as_str()) && estado == "completed" {
        let ruta = s(part, "/state/metadata/filepath")
            .or_else(|| s(part, "/state/input/filePath"))
            .unwrap_or_default();
        evt("patch", format!("update {ruta}"))
    } else {
        let titulo = s(part, "/state/title")
            .or_else(|| s(part, "/state/input/command"))
            .unwrap_or_default();
        let sufijo = if estado == "error" { " (error)" } else { "" };
        evt("command", format!("{tool}: {titulo}{sufijo}"))
    };
    LineOutcome {
        event,
        ..LineOutcome::default()
    }
}

fn error(e: &Value) -> LineOutcome {
    let msg = s(e, "/data/message")
        .or_else(|| s(e, "/name"))
        .unwrap_or_else(|| "error de OpenCode".into());
    LineOutcome {
        event: evt("error", msg),
        failed: true,
        ..LineOutcome::default()
    }
}

/// Reintentos agotados (`AI_RetryError: Failed after N attempts. Last error: …`).
/// El nombre `AI_RetryError` solo sale si el mensaje lo incluye; el texto
/// «Failed after N attempts» es el mensaje del propio `AI_RetryError`.
fn reintentos_agotados(texto: &str) -> bool {
    texto.contains("ai_retryerror")
        || texto
            .find("failed after ")
            .is_some_and(|i| texto[i..].contains(" attempts"))
}

/// Errores que no se arreglan reintentando (en minúsculas): credenciales,
/// saldo o cuota de pago, petición demasiado grande y contexto excedido.
const NO_REINTENTABLES: &[&str] = &[
    "unauthorized",
    "forbidden",
    "authentication",
    "invalid api key",
    "invalid_api_key",
    "incorrect api key",
    "insufficient balance",
    "insufficient_quota",
    "usage limit",
    "payment required",
    "request too large",
    "request_too_large",
    "tokens per minute",
    "context length",
    "context_length_exceeded",
    "exceeds the maximum",
    "exceeds maximum",
    "input token count",
];

/// Códigos HTTP no reintentables, como número suelto. Todo se busca solo en el
/// mensaje (`error=`): la traza repite la causa y lleva números de línea.
const CODIGOS_NO_REINTENTABLES: &[&str] = &["401", "402", "403", "413"];

/// `codigo` aparece como número suelto (no dentro de otro número o id).
fn tiene_codigo(texto: &str, codigo: &str) -> bool {
    texto.match_indices(codigo).any(|(i, _)| {
        let antes = texto[..i].chars().next_back();
        let despues = texto[i + codigo.len()..].chars().next();
        [antes, despues]
            .iter()
            .all(|c| !c.is_some_and(|c| c.is_ascii_alphanumeric()))
    })
}

/// Clave logfmt del error si la línea es un error del turno principal: el
/// `halt` del procesador (`message=process … error="…"`) o un `stream error`
/// del modelo principal (`small=false … error.error="…"`).
fn clave_del_error(line: &str) -> Option<&'static str> {
    let campos: Vec<&str> = line.split_whitespace().collect();
    if !campos.contains(&"level=ERROR") {
        return None;
    }
    if campos.contains(&"message=process") {
        return Some(" error=");
    }
    let es_stream = line.contains("message=\"stream error\"");
    (es_stream && campos.contains(&"small=false")).then_some(" error.error=")
}

/// Causa del fallo final de un turno de OpenCode en una línea de stderr, o
/// `None` si la línea no lo es. Lógica invertida (como `delegate.mjs`): solo
/// cuentan los reintentos agotados y los errores no reintentables
/// reconocibles; un 503, un «high demand» o un 429 suelto no abortan, porque
/// OpenCode reintenta, y tampoco una interrupción (`Aborted`) ni un error del
/// modelo pequeño (`small=true`).
pub fn fallo_stderr(line: &str) -> Option<String> {
    let detalle = valor_entre_comillas(line, clave_del_error(line)?).unwrap_or_default();
    let mensaje = detalle.to_lowercase();
    if mensaje == "aborted" || mensaje.starts_with("aborterror") {
        return None;
    }
    let es_final = reintentos_agotados(&mensaje)
        || NO_REINTENTABLES.iter().any(|p| mensaje.contains(p))
        || CODIGOS_NO_REINTENTABLES
            .iter()
            .any(|c| tiene_codigo(&mensaje, c));
    if !es_final {
        return None;
    }
    Some(format!(
        "OpenCode: falló el proveedor (reintentos agotados o error definitivo) y el proceso no terminó solo; se canceló. {detalle}"
    ))
}

/// Valor de `clave"…"` en una línea logfmt (con `\"` escapadas).
fn valor_entre_comillas(line: &str, clave: &str) -> Option<String> {
    let inicio = line.find(clave)? + clave.len();
    let resto = line[inicio..].strip_prefix('"')?;
    let mut out = String::new();
    let mut escapado = false;
    for c in resto.chars() {
        match (escapado, c) {
            (true, _) => {
                out.push(c);
                escapado = false;
            }
            (false, '\\') => escapado = true,
            (false, '"') => return Some(out),
            (false, _) => out.push(c),
        }
    }
    Some(out)
}

#[cfg(test)]
#[path = "tests_opencode.rs"]
mod tests;

#[cfg(test)]
#[path = "opencode_parse_tests.rs"]
mod tests_fallo_final;
