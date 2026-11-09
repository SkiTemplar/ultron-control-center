// sesiones/codex_parse.rs — Interpretación de la salida de Codex.
//
// `codex exec --json` (codex-cli 0.154) emite una línea JSON por evento:
// `thread.started`, `turn.started`, `item.started` / `item.completed` con
// `item.type` = `agent_message` | `command_execution` | `file_change` |
// `reasoning` | `error`, `turn.completed`, `turn.failed` y `error`.

use serde_json::Value;

use super::types::{CodexEvent, EngineUsage};

const MAX_EVENT_CHARS: usize = 4000;

/// Resultado de interpretar una línea de `codex exec --json`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LineOutcome {
    pub event: Option<CodexEvent>,
    /// Último mensaje del agente (resumen de la tarea).
    pub message: Option<String>,
    pub failed: bool,
    /// Hilo de la conversación (`thread.started`), para reanudarla.
    pub thread_id: Option<String>,
    /// Tokens del turno (`turn.completed`).
    pub usage: Option<EngineUsage>,
    /// El turno terminó bien (`turn.completed`).
    pub completed: bool,
    /// Error provisional (`error` de primer nivel): solo cuenta como fallo si
    /// después no llega `turn.completed` (Codex lo emite en cada reintento de
    /// stream, «Reconnecting... 1/5»).
    pub provisional_error: Option<String>,
}

/// Veredicto de una tarea a partir de todas sus líneas: se decide al final.
#[derive(Debug, Default)]
pub struct Veredicto {
    fallo: bool,
    /// Último error provisional sin un `turn.completed` posterior.
    pendiente: Option<String>,
}

impl Veredicto {
    pub fn anotar(&mut self, o: &LineOutcome) {
        self.fallo |= o.failed;
        if let Some(e) = &o.provisional_error {
            self.pendiente = Some(e.clone());
        }
        if o.completed {
            self.pendiente = None;
        }
    }

    pub fn fallido(&self) -> bool {
        self.fallo || self.pendiente.is_some()
    }

    /// Error provisional que no se resolvió (motivo del fallo, si lo hay).
    pub fn error_pendiente(&self) -> Option<&str> {
        self.pendiente.as_deref()
    }
}

pub(super) fn evt(kind: &str, text: String) -> Option<CodexEvent> {
    Some(CodexEvent {
        kind: kind.to_string(),
        text: super::transcript::truncate_chars(&text, MAX_EVENT_CHARS),
    })
}

/// Interpreta una línea JSON de `codex exec --json`.
pub fn parse_exec_line(line: &str) -> LineOutcome {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
        return LineOutcome::default();
    };
    let mut out = LineOutcome::default();
    let s = |v: &Value, p: &str| v.pointer(p).and_then(Value::as_str).map(str::to_string);
    match v.get("type").and_then(Value::as_str).unwrap_or_default() {
        "item.started" | "item.completed" => {
            let done = v["type"] == "item.completed";
            let item = &v["item"];
            match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                "agent_message" if done => {
                    let text = s(item, "/text").unwrap_or_default().trim().to_string();
                    out.message = Some(text.clone());
                    out.event = evt("message", text);
                }
                "command_execution" => {
                    let cmd = s(item, "/command").unwrap_or_default();
                    out.event = match item.get("exit_code").and_then(Value::as_i64) {
                        Some(code) if done => evt("command", format!("{cmd} (salida {code})")),
                        _ => evt("command", format!("en curso: {cmd}")),
                    };
                }
                "file_change" if done => {
                    let files: Vec<String> = item
                        .get("changes")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .map(|c| {
                                    format!(
                                        "{} {}",
                                        s(c, "/kind").unwrap_or_else(|| "update".into()),
                                        s(c, "/path").unwrap_or_default()
                                    )
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    out.event = evt("patch", files.join("\n"));
                }
                // Un `error` de item no corta el turno (p. ej. «Skill
                // descriptions were shortened…»): es un aviso. Los fallos
                // reales llegan como `turn.failed` o como `error` de primer
                // nivel sin `turn.completed` detrás (`Veredicto`).
                "error" if done => {
                    out.event = evt("warning", s(item, "/message").unwrap_or_default())
                }
                _ => {}
            }
        }
        "thread.started" => out.thread_id = s(&v, "/thread_id"),
        "turn.completed" => {
            out.completed = true;
            out.usage = usage(&v);
        }
        "turn.failed" => {
            out.failed = true;
            out.event = evt(
                "error",
                s(&v, "/error/message").unwrap_or_else(|| "turno fallido".into()),
            );
        }
        // Provisional: si el turno termina después, era un reintento.
        "error" => {
            let msg = s(&v, "/message").unwrap_or_else(|| "error de Codex".into());
            out.event = evt("warning", msg.clone());
            out.provisional_error = Some(msg);
        }
        _ => {}
    }
    out
}

/// `usage` de `turn.completed`: `{input_tokens, cached_input_tokens,
/// output_tokens}`. `None` si falta o no trae ningún contador.
fn usage(v: &Value) -> Option<EngineUsage> {
    let u = v.get("usage")?;
    let n = |k: &str| u.get(k).and_then(Value::as_u64);
    let (input, output) = (n("input_tokens"), n("output_tokens"));
    if input.is_none() && output.is_none() {
        return None;
    }
    Some(EngineUsage {
        input_tokens: input.unwrap_or(0),
        cached_input_tokens: n("cached_input_tokens").unwrap_or(0),
        output_tokens: output.unwrap_or(0),
    })
}

/// Id de tarea de Codex Cloud en la salida (`task_…` o el último segmento
/// de una URL `/tasks/<id>`).
pub fn extract_cloud_task_id(out: &str) -> Option<String> {
    let re = regex::Regex::new(r"(task_[A-Za-z0-9_\-]+)|/tasks/([A-Za-z0-9_\-]+)").ok()?;
    let c = re.captures_iter(out).last()?;
    c.get(1)
        .or_else(|| c.get(2))
        .map(|m| m.as_str().to_string())
}

#[cfg(test)]
#[path = "tests_codex.rs"]
mod tests;
