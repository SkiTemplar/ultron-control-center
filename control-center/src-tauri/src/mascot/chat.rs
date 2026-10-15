// Mascota — los tres botones de conversación (Claude, Codex, Antigravity).
//
// Cada agente se intenta primero por su CLI de suscripción (coste 0 por
// uso, la misma política CLI-first del AI Router) y, si la CLI no está o
// falla, por la API del proveedor equivalente del AI Router (necesita su
// key). La respuesta dice SIEMPRE qué camino contestó (`via`), para que el
// bocadillo no venda «Claude» cuando habló otro.
//
//   Claude      -> `claude -p`            -> API `claude`  (ANTHROPIC_API_KEY)
//   Codex       -> `codex exec -`         -> API `codex`   (OPENAI_API_KEY)
//   Antigravity -> `agy -p <prompt>`      -> API `gemini`  (GEMINI_API_KEY)
//
// `agy -p` sigue la convención de gemini-cli, de la que deriva la CLI de
// Antigravity; si esa versión no la acepta, el fallo cae al Gemini en la
// nube y el bocadillo lo indica.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::MascotSettings;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
    Antigravity,
}

impl Agent {
    fn label(self) -> &'static str {
        match self {
            Agent::Claude => "Claude",
            Agent::Codex => "Codex",
            Agent::Antigravity => "Antigravity (Gemini)",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Turn {
    /// "user" | "assistant"
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AskResult {
    pub text: String,
    /// Camino que contestó, p. ej. "claude CLI" o "API gemini-2.5-flash".
    pub via: String,
}

const CLI_TIMEOUT: Duration = Duration::from_secs(180);
/// `agy -p` no está documentado: si esa versión de la CLI no lo entiende y se
/// queda esperando, que el usuario no espere 3 minutos al fallback.
const AGY_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_HISTORY: usize = 8;
const MAX_TURN_CHARS: usize = 2_000;

/// Prompt completo: instrucciones de tono + historial corto + mensaje.
pub fn build_prompt(agent: Agent, history: &[Turn], message: &str) -> String {
    let mut p = format!(
        "Eres {} y hablas con el usuario a través de su mascota de escritorio (un \
         bocadillo de cómic pequeño). Responde en español, breve y directo \
         (idealmente menos de 120 palabras), sin tablas ni bloques de código \
         largos salvo que te los pidan.\n\n",
        agent.label()
    );
    let start = history.len().saturating_sub(MAX_HISTORY);
    let recent = &history[start..];
    if !recent.is_empty() {
        p.push_str("Conversación previa:\n");
        for t in recent {
            let who = if t.role == "assistant" { "Tú" } else { "Usuario" };
            let text: String = t.text.chars().take(MAX_TURN_CHARS).collect();
            p.push_str(&format!("{who}: {}\n", text.trim()));
        }
        p.push('\n');
    }
    p.push_str("Mensaje del usuario:\n");
    p.push_str(message.trim());
    p
}

/// Quita secuencias ANSI (colores de las CLIs) y espacios sobrantes.
pub fn clean_output(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // CSI: parámetros hasta una letra final.
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() || n == '~' {
                        break;
                    }
                }
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out.trim().to_string()
}

fn program(name: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        crate::ai_router::exec::resolve_windows_cli_program(name)
    }
    #[cfg(not(target_os = "windows"))]
    {
        name.to_string()
    }
}

fn run_cli(
    program: &str,
    args: &[&str],
    stdin: Option<&str>,
    label: &str,
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    // Sin el repo como cwd: ni CLAUDE.md ni AGENTS.md de ningún proyecto se
    // cuelan en una charla de escritorio.
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: sin consola parpadeando
    }
    let out = crate::ai_router::exec::run_with_timeout(cmd, timeout, stdin)
        .map_err(|e| format!("{label}: {e}"))?;
    let stdout = clean_output(&String::from_utf8_lossy(&out.stdout));
    if !out.status.success() {
        let stderr = clean_output(&String::from_utf8_lossy(&out.stderr));
        let tail: String = stderr
            .chars()
            .rev()
            .take(300)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(format!("{label} terminó con {}: {tail}", out.status));
    }
    if stdout.is_empty() {
        return Err(format!("{label} no devolvió texto"));
    }
    Ok(stdout)
}

/// Llamada por la API de un proveedor del AI Router con su modelo por
/// defecto (el que tenga en providers.json, no uno fijado aquí).
fn via_api(provider: &str, prompt: &str) -> Result<AskResult, String> {
    let model = crate::ai_router::store::load_providers()
        .ok()
        .and_then(|ps| ps.into_iter().find(|p| p.id == provider))
        .map(|p| p.default_model)
        .ok_or_else(|| format!("API {provider}: proveedor no configurado en el AI Router"))?;
    let assignment = crate::ai_router::types::ZoneAssignment {
        provider_id: provider.to_string(),
        model: model.clone(),
        max_tokens: 1024,
    };
    crate::ai_router::providers::call_wrappers::try_assignment_call(&assignment, prompt, None)
        .map(|(outcome, _)| AskResult {
            text: clean_output(&outcome.text),
            via: format!("API {provider} {model}"),
        })
        .map_err(|(e, _)| format!("API {provider}: {e}"))
}

fn claude_cli(prompt: &str, model: &str) -> Result<AskResult, String> {
    let prog = program("claude");
    let mut args = vec!["-p", "--output-format", "text"];
    if !model.trim().is_empty() {
        args.push("--model");
        args.push(model.trim());
    }
    run_cli(&prog, &args, Some(prompt), "claude", CLI_TIMEOUT).map(|text| AskResult {
        text,
        via: "claude CLI".into(),
    })
}

fn codex_cli(prompt: &str, model: &str) -> Result<AskResult, String> {
    let prog = program("codex");
    let mut args = vec![
        "exec",
        "-",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
    ];
    if !model.trim().is_empty() {
        args.push("--model");
        args.push(model.trim());
    }
    run_cli(&prog, &args, Some(prompt), "codex", CLI_TIMEOUT).map(|text| AskResult {
        text,
        via: "codex CLI".into(),
    })
}

fn agy_cli(prompt: &str) -> Result<AskResult, String> {
    let bin = crate::accounts::probe::resolve_agy_binary()
        .ok_or_else(|| "agy no está instalada (winget install Google.AntigravityCLI)".to_string())?;
    let prog = bin.to_string_lossy().to_string();
    run_cli(&prog, &["-p", prompt], None, "agy", AGY_TIMEOUT).map(|text| AskResult {
        text,
        via: "agy CLI".into(),
    })
}

/// Pregunta a `agent`. Bloqueante (CLIs de hasta 3 min): llamar desde
/// `spawn_blocking`.
pub fn ask(
    agent: Agent,
    history: &[Turn],
    message: &str,
    settings: &MascotSettings,
) -> Result<AskResult, String> {
    if message.trim().is_empty() {
        return Err("Mensaje vacío".into());
    }
    let prompt = build_prompt(agent, history, message);
    let (first, fallback) = match agent {
        Agent::Claude => (claude_cli(&prompt, &settings.claude_model), "claude"),
        Agent::Codex => (codex_cli(&prompt, &settings.codex_model), "codex"),
        Agent::Antigravity => (agy_cli(&prompt), "gemini"),
    };
    match first {
        Ok(r) => Ok(r),
        Err(cli_err) => match via_api(fallback, &prompt) {
            Ok(mut r) => {
                r.via = format!("{} (la CLI falló: {})", r.via, short(&cli_err));
                Ok(r)
            }
            Err(api_err) => Err(format!(
                "{} no contestó.\n• CLI: {}\n• {}",
                agent.label(),
                short(&cli_err),
                short(&api_err)
            )),
        },
    }
}

fn short(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() <= 220 {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(220).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_prompt_lleva_historial_reciente_y_mensaje() {
        let hist: Vec<Turn> = (0..12)
            .map(|i| Turn {
                role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
                text: format!("turno {i}"),
            })
            .collect();
        let p = build_prompt(Agent::Codex, &hist, "  hola  ");
        assert!(p.contains("Eres Codex"));
        assert!(!p.contains("turno 3\n"), "solo los últimos {MAX_HISTORY}");
        assert!(p.contains("Tú: turno 11"));
        assert!(p.ends_with("hola"));
    }

    #[test]
    fn limpia_ansi_y_retornos() {
        assert_eq!(clean_output("\u{1b}[32mhola\u{1b}[0m\r\n"), "hola");
    }

    #[test]
    fn mensaje_vacio_es_error_y_no_lanza_nada() {
        let r = ask(Agent::Claude, &[], "   ", &MascotSettings::default());
        assert!(r.is_err());
    }
}
