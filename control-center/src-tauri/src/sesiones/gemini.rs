// sesiones/gemini.rs — Motor Gemini (contrato v0.2, E9).
//
// Vía principal: `agy` (CLI de Antigravity 1.2.x) en modo no interactivo con
// el prompt por stdin, nunca como argumento (ENAMETOOLONG en Windows por
// encima de 32 767 caracteres). Comprobado el 2026-10-07 con agy 1.2.17:
//
//   agy --input-format stream-json --output-format stream-json --print=
//
// `-p -` toma el guion como prompt literal y `-p` sin valor falla, así que el
// prompt entra como NDJSON: `{"event":"user","message":{"content":"…"}}`. La
// salida es JSON por líneas: `init` (`conversation_id`), `step_update`
// (`step_type`, `state`, `text_delta`) y `result` (`status` SUCCESS | ERROR,
// `response`, `error`). Las tareas (`task`) van con `--mode accept-edits`; las
// opiniones, con el modo por defecto (revisión de permisos).
//
// Reserva, solo si `agy` no existe: `gemini` de npm, que concatena stdin con
// el valor de `-p` (salida de texto).

use std::collections::HashMap;

use serde_json::{json, Value};

use super::codex_parse::{evt, LineOutcome};
use super::motor::{self, Launch, LineParser, TaskSpec};
use super::motores::{self, GeminiCli};
use super::types::EngineTask;

const NPM_INSTRUCTION: &str = "Responde a la petición recibida por la entrada estándar.";

/// Cabecera de las opiniones. En headless, `agy` deniega sin preguntar
/// cualquier herramienta con permiso `command` y termina con SUCCESS y la
/// respuesta vacía (agy 1.3.5, 2026-10-14): Gemini intentaba «ver la sesión»
/// con un comando. El contexto ya va en el prompt, así que no las necesita.
pub const SIN_HERRAMIENTAS: &str = "Responde solo con texto a partir de lo que va en este mensaje: no uses herramientas, no leas ficheros ni ejecutes comandos.\n\n";

pub fn opinion_prompt(prompt: &str) -> String {
    format!("{SIN_HERRAMIENTAS}{prompt}")
}

/// Argumentos de `agy` según el tipo de intervención.
pub fn agy_args(kind: &str, model: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if kind == "opinion" {
        a.push("--disable-slash-commands".into());
    } else {
        // agy no ofrece un modo headless mas amplio: `accept-edits` es su
        // maximo permiso disponible tambien durante un relevo.
        a.extend(["--mode".into(), "accept-edits".into()]);
    }
    if let Some(m) = model {
        a.extend(["--model".into(), m.to_string()]);
    }
    a.push("--print=".into());
    a
}

/// Línea NDJSON con el mensaje de usuario para `agy --input-format stream-json`.
pub fn agy_input(prompt: &str) -> Vec<u8> {
    let mut line = json!({ "event": "user", "message": { "content": prompt } }).to_string();
    line.push('\n');
    line.into_bytes()
}

/// Intérprete con estado de la salida `stream-json` de `agy`.
#[derive(Default)]
pub struct AgyParser {
    /// Texto acumulado por paso de respuesta (`step_index`).
    steps: HashMap<u64, String>,
    last_text: String,
}

impl AgyParser {
    pub fn line(&mut self, line: &str) -> LineOutcome {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            return LineOutcome::default();
        };
        match v.get("event").and_then(Value::as_str).unwrap_or_default() {
            "init" => LineOutcome {
                thread_id: str_at(&v, "/conversation_id"),
                ..LineOutcome::default()
            },
            "step_update" => self.step(&v["step_update"]),
            "result" => result(&v["result"], &self.last_text),
            _ => LineOutcome::default(),
        }
    }

    fn step(&mut self, s: &Value) -> LineOutcome {
        let typ = s
            .get("step_type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let done = s.get("state").and_then(Value::as_str) == Some("DONE");
        if typ == "agent_response" {
            let idx = s.get("step_index").and_then(Value::as_u64).unwrap_or(0);
            let acc = self.steps.entry(idx).or_default();
            if let Some(d) = s.get("text_delta").and_then(Value::as_str) {
                acc.push_str(d);
            }
            let text = acc.trim().to_string();
            self.last_text = text.clone();
            return LineOutcome {
                event: if done && !text.is_empty() {
                    evt("message", text.clone())
                } else {
                    None
                },
                message: Some(text).filter(|t| !t.is_empty()),
                ..LineOutcome::default()
            };
        }
        if !done || typ.is_empty() || typ == "user_input" {
            return LineOutcome::default();
        }
        let tool = str_at(s, "/tool_name").or_else(|| str_at(s, "/name"));
        let text = tool.map_or_else(|| typ.to_string(), |t| format!("{typ}: {t}"));
        LineOutcome {
            event: evt("command", text),
            ..LineOutcome::default()
        }
    }
}

fn str_at(v: &Value, p: &str) -> Option<String> {
    v.pointer(p)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Fin del turno. Un SUCCESS sin texto cuenta como fallo: el motivo (p. ej.
/// una herramienta denegada en headless) llega por stderr y `motor::finish`
/// lo añade como evento.
fn result(r: &Value, last_text: &str) -> LineOutcome {
    let response = str_at(r, "/response")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| Some(last_text.to_string()).filter(|s| !s.is_empty()));
    let success = r.get("status").and_then(Value::as_str) == Some("SUCCESS");
    let event = match (success, &response) {
        (true, Some(_)) => None,
        (true, None) => evt("error", "Gemini terminó sin respuesta".into()),
        (false, _) => evt(
            "error",
            str_at(r, "/error").unwrap_or_else(|| "Gemini terminó con error".into()),
        ),
    };
    LineOutcome {
        failed: event.is_some(),
        event,
        message: response,
        thread_id: str_at(r, "/conversation_id"),
        ..LineOutcome::default()
    }
}

/// Intérprete de la salida de texto de `gemini` (npm).
fn text_parser() -> LineParser {
    let mut acc = String::new();
    Box::new(move |line: &str| {
        acc.push_str(line);
        acc.push('\n');
        LineOutcome {
            message: Some(acc.trim().to_string()),
            ..LineOutcome::default()
        }
    })
}

/// Lanza una intervención de Gemini. `full_prompt` ya incluye el contexto.
pub fn start(spec: TaskSpec, full_prompt: String) -> Result<EngineTask, String> {
    if full_prompt.trim().is_empty() {
        return Err("el prompt para Gemini está vacío".to_string());
    }
    if spec.mode != "local" {
        return Err(format!(
            "modo de Gemini no válido: '{}' (solo 'local')",
            spec.mode
        ));
    }
    if !std::path::Path::new(&spec.cwd).is_dir() {
        return Err(format!("el directorio no existe: {}", spec.cwd));
    }
    let full_prompt = if spec.kind == "opinion" {
        opinion_prompt(&full_prompt)
    } else {
        full_prompt
    };
    let (cli, program) = motores::gemini_program()?;
    let mut cmd = motores::command_for_task(&program, &spec.cwd);
    let launch = match cli {
        GeminiCli::Agy => {
            cmd.args(agy_args(&spec.kind, spec.model.as_deref()));
            let mut p = AgyParser::default();
            Launch {
                cmd,
                stdin: Some(agy_input(&full_prompt)),
                parser: Box::new(move |l: &str| p.line(l)),
                on_done: Some(Box::new(super::relevo::task_finished)),
                vigia_stderr: None,
            }
        }
        GeminiCli::Npm => {
            cmd.args(["-p", NPM_INSTRUCTION]);
            if let Some(m) = spec.model.as_deref() {
                cmd.args(["-m", m]);
            }
            Launch {
                cmd,
                stdin: Some(full_prompt.into_bytes()),
                parser: text_parser(),
                on_done: Some(Box::new(super::relevo::task_finished)),
                vigia_stderr: None,
            }
        }
    };
    motor::spawn(spec, launch)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Líneas con la forma observada en agy 1.2.17 (contenido inventado).
    const INIT: &str = r#"{"event":"init","conversation_id":"c-1","init":{"cwd":"x"}}"#;
    const D1: &str = r#"{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hola"}}"#;
    const D2: &str = r#"{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":" mundo\n"}}"#;
    const OK: &str = r#"{"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"Hola mundo\n"}}"#;
    const KO: &str = r#"{"event":"result","result":{"conversation_id":"c-2","status":"ERROR","response":"","error":"cuota agotada"}}"#;

    #[test]
    fn acumula_la_respuesta_y_toma_el_hilo() {
        let mut p = AgyParser::default();
        assert_eq!(p.line(INIT).thread_id.as_deref(), Some("c-1"));
        assert_eq!(p.line(D1).message.as_deref(), Some("Hola"));
        let done = p.line(D2);
        assert_eq!(done.event.map(|e| e.text), Some("Hola mundo".into()));
        let end = p.line(OK);
        assert!(!end.failed);
        assert_eq!(end.message.as_deref(), Some("Hola mundo"));
    }

    #[test]
    fn un_resultado_con_error_marca_la_tarea_fallida() {
        let mut p = AgyParser::default();
        let o = p.line(KO);
        assert!(o.failed);
        assert_eq!(o.event.map(|e| e.text), Some("cuota agotada".into()));
    }

    // agy 1.3.5 con una herramienta denegada en headless: paso de respuesta
    // vacío, una herramienta y SUCCESS sin texto (el motivo va por stderr).
    const VACIO: &str = r#"{"event":"step_update","step_update":{"conversation_id":"c-3","step_index":1,"state":"DONE","step_type":"agent_response"}}"#;
    const OK_VACIO: &str =
        r#"{"event":"result","result":{"conversation_id":"c-3","status":"SUCCESS","response":""}}"#;

    #[test]
    fn un_exito_sin_respuesta_falla_en_vez_de_quedar_hecho_y_vacio() {
        let mut p = AgyParser::default();
        let paso = p.line(VACIO);
        assert!(paso.event.is_none(), "sin evento de mensaje vacío");
        let fin = p.line(OK_VACIO);
        assert!(fin.failed);
        assert!(fin.message.is_none());
        let texto = fin.event.map(|e| e.text).unwrap_or_default();
        assert!(texto.contains("sin respuesta"), "{texto}");
    }

    #[test]
    fn la_opinion_pide_responder_sin_herramientas() {
        let args = agy_args("opinion", None);
        assert!(args.contains(&"--disable-slash-commands".to_string()));
        assert!(opinion_prompt("x").starts_with(SIN_HERRAMIENTAS));
        assert!(!agy_args("task", None).contains(&"--disable-slash-commands".to_string()));
    }

    #[test]
    fn el_prompt_va_por_stdin_y_no_como_argumento() {
        let args = agy_args("task", None);
        assert_eq!(args.last().map(String::as_str), Some("--print="));
        let big = "x".repeat(40_000);
        let input = String::from_utf8(agy_input(&big)).expect("utf8");
        let v: Value = serde_json::from_str(input.trim()).expect("ndjson");
        assert_eq!(v["event"], "user");
        assert_eq!(v["message"]["content"].as_str().map(str::len), Some(40_000));
        assert!(args.iter().all(|a| a.len() < 64));
    }

    #[test]
    fn la_opinion_no_acepta_ediciones() {
        assert!(!agy_args("opinion", None).contains(&"accept-edits".to_string()));
        assert!(agy_args("task", None).contains(&"accept-edits".to_string()));
    }
}
