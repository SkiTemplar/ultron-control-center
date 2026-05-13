// ULTRON Control Center — Sessions & quick actions.
//
// Three interaction modes:
//   1. run_inline       — batch invocation that returns stdout in-app.
//                         Uses claude -p / codex exec / ultron gemini.
//   2. spawn_session    — opens Windows Terminal with provider CLI.
//                         Optional initial prompt + optional working dir.
//
// PowerShell quoting: we wrap user prompts in single-quoted PS strings and
// escape the apostrophes by doubling them ('foo'bar' → 'foo''bar'). The
// command string that we hand to wt.exe goes through the Tauri capabilities
// validator, so anything that doesn't match the regex is rejected.

use serde::Serialize;
use std::path::PathBuf;

use tauri_plugin_shell::ShellExt;

const PROMPT_CAP: usize = 4000;

#[derive(Debug, Serialize, Clone)]
pub struct SpawnResult {
    pub launched: bool,
    pub provider: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct InlineResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

fn validate_provider(p: &str) -> Result<&'static str, String> {
    match p {
        "claude" => Ok("claude"),
        "gemini" => Ok("gemini"),
        "codex" => Ok("codex"),
        other => Err(format!("unknown provider '{}'", other)),
    }
}

fn cap_prompt(p: &str) -> String {
    if p.chars().count() > PROMPT_CAP {
        p.chars().take(PROMPT_CAP).collect()
    } else {
        p.to_string()
    }
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

// ---------------------------------------------------------------------------
// run_inline
// ---------------------------------------------------------------------------

pub async fn run_inline_inner(
    app: &tauri::AppHandle,
    provider: String,
    model: Option<String>,
    prompt: String,
) -> Result<InlineResult, String> {
    let provider = validate_provider(&provider)?;
    if prompt.trim().is_empty() {
        return Err("prompt is empty".to_string());
    }
    let prompt = cap_prompt(&prompt);

    let output = match provider {
        "gemini" => {
            let script: PathBuf = dirs::home_dir()
                .ok_or_else(|| "no HOME".to_string())?
                .join(".ultron/scripts/cockpit/gemini_cli.py");
            let script_str = script.to_string_lossy().to_string();
            let model_arg = model
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "gemini-3.1-pro-preview".to_string());
            app.shell()
                .command("uv")
                .args(["run", "python", &script_str, "--model", &model_arg, &prompt])
                .output()
                .await
                .map_err(|e| format!("spawn uv: {}", e))?
        }
        "claude" => {
            // claude -p "<prompt>" — print mode, batch, exits when done.
            let mut args = vec!["-p".to_string(), prompt.clone()];
            if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
                // Claude accepts --model <id>
                args.push("--model".to_string());
                args.push(m);
            }
            let str_args: Vec<&str> = args.iter().map(String::as_str).collect();
            app.shell()
                .command("claude")
                .args(str_args)
                .output()
                .await
                .map_err(|e| format!("spawn claude: {}", e))?
        }
        "codex" => {
            // codex exec "<prompt>" — non-interactive batch.
            let mut args = vec!["exec".to_string()];
            if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
                args.push("-m".to_string());
                args.push(m);
            }
            args.push(prompt.clone());
            let str_args: Vec<&str> = args.iter().map(String::as_str).collect();
            app.shell()
                .command("codex")
                .args(str_args)
                .output()
                .await
                .map_err(|e| format!("spawn codex: {}", e))?
        }
        _ => unreachable!(),
    };

    Ok(InlineResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
}

// ---------------------------------------------------------------------------
// spawn_session
// ---------------------------------------------------------------------------

/// Build the PowerShell -Command string that wt.exe will run inside the
/// new tab. Layered as: `Set-Location ...; <provider> [args]`.
fn build_inner_command(provider: &str, prompt: Option<&str>, cwd: Option<&str>) -> String {
    let mut cmd = String::new();
    if let Some(dir) = cwd {
        cmd.push_str(&format!("Set-Location -LiteralPath {}; ", ps_quote(dir)));
    }
    cmd.push_str(provider);
    if let Some(p) = prompt {
        let capped = cap_prompt(p);
        match provider {
            "gemini" => cmd.push_str(&format!(" -p {}", ps_quote(&capped))),
            // Claude + Codex both accept the prompt as a single positional arg
            // for an interactive session that bootstraps with that message.
            _ => cmd.push_str(&format!(" {}", ps_quote(&capped))),
        }
    }
    cmd
}

pub async fn spawn_session_inner(
    app: &tauri::AppHandle,
    provider: String,
    prompt: Option<String>,
    cwd: Option<String>,
) -> Result<SpawnResult, String> {
    let provider = validate_provider(&provider)?;
    let prompt_ref = prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let cwd_ref = cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let inner = build_inner_command(provider, prompt_ref, cwd_ref);
    let title = format!("ULTRON · {}", provider);

    let output = app
        .shell()
        .command("wt.exe")
        .args([
            "new-tab",
            "--title",
            &title,
            "--",
            "powershell.exe",
            "-NoExit",
            "-NoProfile",
            "-Command",
            &inner,
        ])
        .output()
        .await
        .map_err(|e| format!("spawn wt: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("wt new-tab failed: {}", stderr));
    }
    Ok(SpawnResult {
        launched: true,
        provider: provider.to_string(),
    })
}
