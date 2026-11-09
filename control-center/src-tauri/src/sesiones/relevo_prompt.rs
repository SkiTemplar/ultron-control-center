// sesiones/relevo_prompt.rs — Textos que recibe el motor del relevo
// (submódulo de `relevo`): traspaso inicial, prompt de escalado y contexto de
// los turnos de seguimiento de un motor sin hilo propio (Gemini).
//
// Todo lo que sale de la conversación hacia OpenAI, Google o la API de
// Anthropic pasa por la redacción de secretos del write-path de memoria
// (`memory::redaction::redact`). Lo que el usuario escribe a propósito al
// motor en un turno de seguimiento no se toca.

use crate::memory::redaction::redact;
use crate::sesiones::types::{Block, ChatMessage, EngineTask};

pub(super) const MAX_MESSAGES: usize = 12;
const MAX_MESSAGE_CHARS: usize = 2_000;
/// Turnos del relevo que entran en el escalado o en el contexto de Gemini.
const MAX_HISTORY_TASKS: usize = 6;
/// Tope por petición y por respuesta de cada turno del historial.
const MAX_HISTORY_CHARS: usize = 3_000;

/// Primera línea del traspaso: marca los prompts que compone el relevo (el
/// frontend la usa para plegar el traspaso, `isHandoff`).
pub const HANDOFF_INTRO: &str = "Continua el trabajo de Claude en este mismo repositorio.";

#[derive(Debug, Clone)]
pub struct RelayMessage<'a> {
    pub role: &'a str,
    pub text: String,
}

pub fn tail_chars(text: &str, max: usize) -> String {
    let len = text.chars().count();
    if len <= max {
        text.to_string()
    } else {
        format!("…{}", text.chars().skip(len - max + 1).collect::<String>())
    }
}

fn head_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max - 1).collect::<String>())
    }
}

/// Prompt acotado y sin bloques de herramientas para iniciar el relevo, con
/// los secretos redactados.
pub fn compose_handoff(failed_prompt: &str, messages: &[RelayMessage<'_>], git: &str) -> String {
    let mut out = vec![
        format!("{HANDOFF_INTRO} Trabaja de forma autonoma, conserva los cambios existentes y responde al usuario dentro de esta conversacion."),
        format!("## Ultimo prompt que Claude no pudo atender\n{}", failed_prompt.trim()),
        "## Conversacion reciente (solo texto)".to_string(),
    ];
    let start = messages.len().saturating_sub(MAX_MESSAGES);
    out.extend(messages[start..].iter().map(|m| {
        format!(
            "### {}\n{}",
            m.role,
            tail_chars(m.text.trim(), MAX_MESSAGE_CHARS)
        )
    }));
    out.push(format!(
        "## git status --short\n```text\n{}\n```",
        git.trim()
    ));
    redact(&out.join("\n\n"))
}

fn text_of(m: &ChatMessage) -> String {
    m.blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn relay_messages(messages: &[ChatMessage]) -> Vec<RelayMessage<'_>> {
    messages
        .iter()
        .filter(|m| m.agent_id.is_none() && matches!(m.role.as_str(), "user" | "assistant"))
        .filter_map(|m| {
            let text = text_of(m);
            let role = if m.role == "user" {
                "Usuario"
            } else {
                "Claude"
            };
            (!text.trim().is_empty()).then_some(RelayMessage { role, text })
        })
        .collect()
}

pub fn failed_prompt(messages: &[ChatMessage]) -> String {
    relay_messages(messages)
        .into_iter()
        .rev()
        .find(|m| m.role == "Usuario")
        .map(|m| m.text)
        .unwrap_or_else(|| "Continua la tarea pendiente.".into())
}

/// Petición del usuario de un turno de seguimiento; `None` si el prompt lo
/// compuso el propio relevo (traspaso o escalado).
pub fn pending_request(task: &EngineTask) -> Option<String> {
    let p = task.prompt.trim();
    (!p.is_empty() && !p.starts_with(HANDOFF_INTRO)).then(|| p.to_string())
}

fn engine_name(engine: &str) -> &'static str {
    match engine {
        "opencode" => "Claude por API",
        "codex" => "Codex",
        "gemini" => "Gemini",
        _ => "el motor anterior",
    }
}

/// Historial acotado de los turnos del relevo (los `MAX_HISTORY_TASKS`
/// últimos), sin el traspaso repetido y sin la tarea `skip`.
pub fn relay_history(tasks: &[EngineTask], skip: Option<&str>) -> String {
    let kept: Vec<&EngineTask> = tasks
        .iter()
        .filter(|t| Some(t.id.as_str()) != skip)
        .collect();
    let start = kept.len().saturating_sub(MAX_HISTORY_TASKS);
    kept[start..]
        .iter()
        .map(|t| {
            let mut block = format!("### Turno de {} ({})", engine_name(&t.engine), t.status);
            if let Some(p) = pending_request(t) {
                block.push_str(&format!(
                    "\nPeticion del usuario:\n{}",
                    head_chars(&p, MAX_HISTORY_CHARS)
                ));
            }
            let answer = t.summary.as_deref().map_or("(sin respuesta)", str::trim);
            block.push_str(&format!(
                "\nRespuesta:\n{}",
                tail_chars(answer, MAX_HISTORY_CHARS)
            ));
            block
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Prompt del motor siguiente tras un fallo: traspaso, trabajo previo
/// acotado, la última petición del usuario que quedó sin atender y el motivo.
pub fn compose_escalation(
    handoff: &str,
    failed_engine: &str,
    history: &str,
    pending: Option<&str>,
    reason: &str,
) -> String {
    let mut out =
        format!(
        "{handoff}\n\n## Trabajo alcanzado por los motores del relevo antes del fallo de {}\n{}",
        engine_name(failed_engine),
        if history.trim().is_empty() { "(ninguno)" } else { history }
    );
    if let Some(p) = pending.filter(|p| !p.trim().is_empty()) {
        out.push_str(&format!(
            "\n\n## Ultima peticion pendiente del usuario (atiendela primero)\n{}",
            p.trim()
        ));
    }
    out.push_str(&format!(
        "\n\n## Motivo del relevo\n{}",
        tail_chars(reason.trim(), MAX_MESSAGE_CHARS)
    ));
    redact(&out)
}

/// Contexto de un turno de seguimiento para un motor que no conserva el hilo
/// (Gemini): el traspaso y los turnos previos del relevo.
pub fn compose_relay_context(handoff: &str, history: &str) -> String {
    let mut out = format!("{handoff}\n\n");
    if !history.trim().is_empty() {
        out.push_str(&format!("## Turnos previos del relevo\n{history}\n\n"));
    }
    redact(&out)
}
