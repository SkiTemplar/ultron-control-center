// ULTRON Control Center — Sessions & quick actions.
//
// Two distinct interaction modes:
//   1. spawn_session — opens a real interactive terminal (Windows Terminal)
//      running claude / gemini / codex. The user drives that session
//      directly; the Control Center just kicks it off.
//   2. run_gemini    — invokes the ultron gemini CLI wrapper with a
//      model + prompt and returns the captured stdout in-app. No terminal.
//      Useful for fire-and-forget questions or quick experiments.

use serde::Serialize;
use std::path::PathBuf;

use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize, Clone)]
pub struct SpawnResult {
    pub launched: bool,
    pub provider: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct GeminiResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// Validate the provider string against the small whitelist of supported
/// session targets. Rejects anything else to keep the surface area tight.
fn validate_provider(p: &str) -> Result<&'static str, String> {
    match p {
        "claude" => Ok("claude"),
        "gemini" => Ok("gemini"),
        "codex" => Ok("codex"),
        other => Err(format!("unknown provider '{}'", other)),
    }
}

/// Spawn an interactive terminal session for the given provider.
/// Strategy: launch Windows Terminal with a PowerShell host that runs
/// the provider CLI. If the CLI exits, the shell stays open so the user
/// can inspect output.
pub async fn spawn_session_inner(
    app: &tauri::AppHandle,
    provider: String,
) -> Result<SpawnResult, String> {
    let provider = validate_provider(&provider)?;
    // wt args:
    //   new-tab           open a new tab in the active wt window if any,
    //                     otherwise a new window
    //   --title <name>    cosmetic
    //   -- <cmd>          everything after -- is the child process
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
            provider,
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

/// Invoke ultron gemini wrapper with a specific model + prompt.
/// Returns captured stdout/stderr/exit_code.
pub async fn run_gemini_inner(
    app: &tauri::AppHandle,
    model: String,
    prompt: String,
) -> Result<GeminiResult, String> {
    if prompt.trim().is_empty() {
        return Err("prompt is empty".to_string());
    }
    // Defensive cap so a paste-bomb doesn't lock the wrapper.
    let prompt = if prompt.len() > 20_000 {
        prompt.chars().take(20_000).collect::<String>()
    } else {
        prompt
    };

    let script: PathBuf = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/gemini_cli.py");
    let script_str = script.to_string_lossy().to_string();

    // Args list keeps the model and prompt as separate argv entries so the
    // wrapper sees them correctly (no shell-quoting risk).
    let model_arg = if model.trim().is_empty() {
        "gemini-3.1-pro-preview".to_string()
    } else {
        model
    };

    let output = app
        .shell()
        .command("uv")
        .args(["run", "python", &script_str, "--model", &model_arg, &prompt])
        .output()
        .await
        .map_err(|e| format!("spawn uv: {}", e))?;

    Ok(GeminiResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
}
