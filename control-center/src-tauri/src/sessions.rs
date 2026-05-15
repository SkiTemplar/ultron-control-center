// ULTRON Control Center — Sessions & quick actions.
//
// Two interaction modes:
//   1. run_inline       — batch invocation that returns stdout in-app.
//                         Uses cmd.exe /C as a uniform launcher so .cmd
//                         shims (codex, gemini via npm) and reparse-point
//                         binaries (claude in ~/.local/bin) resolve via
//                         the user's PATH and PATHEXT.
//   2. spawn_session    — opens Windows Terminal (wt.exe) with the chosen
//                         provider CLI. wt.exe lives in the WindowsApps
//                         reparse-point directory, so we go through
//                         cmd.exe /C wt.exe ... to dodge the launcher
//                         quirks Rust's Command::new exhibits on those
//                         pseudo-executables.
//
// PowerShell quoting: prompts are single-quoted and apostrophes doubled
// ('foo'bar' → 'foo''bar'). The argument that reaches wt.exe goes through
// the capability validator regex, so anything off-grammar is rejected.

use serde::{Deserialize, Serialize};
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

/// User-facing flags applied to `claude` sessions launched via wt.exe.
///
/// Mirrors the subset of Claude CLI options that make sense from a desktop
/// launcher. The whole struct is optional so older callers and non-Claude
/// providers stay valid. Validation is performed in the inner builder so the
/// capability regex can stay readable.
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpawnFlags {
    /// Add `--dangerously-skip-permissions`. Claude will not pause on tool
    /// confirmations — only enable for sandboxes you trust.
    #[serde(default)]
    pub dangerously_skip_permissions: bool,
    /// `--continue` — resume the latest conversation in the chosen cwd. When
    /// true the prompt argument is ignored.
    #[serde(default)]
    pub continue_last: bool,
    /// `--fork-session` — combined with continue/resume, starts a new branch
    /// off the resumed conversation instead of overwriting it.
    #[serde(default)]
    pub fork_session: bool,
    /// `--model <id>`. When `None` Claude uses the account default.
    #[serde(default)]
    pub model: Option<String>,
    /// `--effort <level>` — low / medium / high / xhigh / max.
    #[serde(default)]
    pub effort: Option<String>,
    /// `-n <name>` — display name shown in the prompt box / picker.
    #[serde(default)]
    pub name: Option<String>,
    /// `-r <sessionId>` — resume specific session by id. Takes precedence
    /// over `continue_last`.
    #[serde(default)]
    pub resume_id: Option<String>,
}

fn ps_quote_optional(s: &str) -> String {
    ps_quote(s)
}

/// Validate and serialise a SpawnFlags into the trailing-args portion of a
/// PowerShell -Command string. Returns `String::new()` if there's nothing
/// to add. Each value is checked against a narrow character set so the
/// capability regex doesn't have to.
fn flags_to_pwsh_args(f: &SpawnFlags) -> Result<String, String> {
    let mut out = String::new();
    if f.dangerously_skip_permissions {
        out.push_str(" --dangerously-skip-permissions");
    }
    if f.continue_last {
        out.push_str(" -c");
    }
    if f.fork_session {
        out.push_str(" --fork-session");
    }
    if let Some(m) = f.model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !m.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_') {
            return Err("invalid model id".into());
        }
        out.push_str(&format!(" --model {}", m));
    }
    if let Some(e) = f.effort.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !matches!(e, "low" | "medium" | "high" | "xhigh" | "max") {
            return Err(format!("invalid effort '{}'", e));
        }
        out.push_str(&format!(" --effort {}", e));
    }
    if let Some(n) = f.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if n.chars().any(|c| matches!(c, '\r' | '\n' | '\'')) {
            return Err("session name contains illegal chars".into());
        }
        if n.chars().count() > 60 {
            return Err("session name too long (max 60 chars)".into());
        }
        out.push_str(&format!(" -n {}", ps_quote_optional(n)));
    }
    if let Some(r) = f
        .resume_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !r.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return Err("invalid resume id".into());
        }
        if r.len() > 80 {
            return Err("resume id too long".into());
        }
        out.push_str(&format!(" -r {}", r));
    }
    Ok(out)
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
            // Gemini goes through our Python helper so the model selection
            // and stdout layout match the rest of the system. uv resolves
            // via PATH, no shim trickery needed.
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
            // Wrap via cmd.exe /C so .exe / .cmd resolution stays uniform.
            // Frontend passes the prompt + optional model; we build a single
            // shell line and let cmd parse it.
            let mut cmdline = String::from("claude -p ");
            cmdline.push_str(&ps_quote_cmd(&prompt));
            if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
                cmdline.push_str(" --model ");
                cmdline.push_str(&m);
            }
            app.shell()
                .command("cmd.exe")
                .args(["/C", &cmdline])
                .output()
                .await
                .map_err(|e| format!("spawn cmd: {}", e))?
        }
        "codex" => {
            let mut cmdline = String::from("codex exec ");
            if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
                cmdline.push_str("-m ");
                cmdline.push_str(&m);
                cmdline.push(' ');
            }
            cmdline.push_str(&ps_quote_cmd(&prompt));
            app.shell()
                .command("cmd.exe")
                .args(["/C", &cmdline])
                .output()
                .await
                .map_err(|e| format!("spawn cmd: {}", e))?
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

/// Quote a value for inclusion inside a cmd.exe /C line. Strategy: wrap in
/// double quotes and escape internal double-quotes/backslashes for CMD's
/// quirky parser. We keep the prompt single-line by replacing CR/LF with
/// spaces — anything multi-line should use spawn_session instead.
fn ps_quote_cmd(s: &str) -> String {
    let collapsed = s.replace('\r', " ").replace('\n', " ");
    let escaped = collapsed.replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

// ---------------------------------------------------------------------------
// spawn_session
// ---------------------------------------------------------------------------

/// Build the PowerShell -Command string that wt.exe runs inside the new tab.
/// Layered as `Set-Location ...; <provider> [flags] [args]`. Inputs are
/// pre-quoted with single quotes (PowerShell literal strings) so user content
/// never gets re-parsed. Flags only apply to `claude`; `gemini` and `codex`
/// ignore them.
fn build_inner_command(
    provider: &str,
    prompt: Option<&str>,
    cwd: Option<&str>,
    flags: &SpawnFlags,
) -> Result<String, String> {
    let mut cmd = String::new();
    if let Some(dir) = cwd {
        cmd.push_str(&format!("Set-Location -LiteralPath {}; ", ps_quote(dir)));
    }
    cmd.push_str(provider);

    if provider == "claude" {
        cmd.push_str(&flags_to_pwsh_args(flags)?);
    }

    // When the user asked for --continue or -r, Claude resumes its own
    // conversation; in that case we don't append a free-text prompt because
    // it would be appended as a fresh user message after the resume.
    let resume_active =
        provider == "claude" && (flags.continue_last || flags.resume_id.is_some());

    if let Some(p) = prompt.filter(|_| !resume_active) {
        let capped = cap_prompt(p);
        match provider {
            "gemini" => cmd.push_str(&format!(" -p {}", ps_quote(&capped))),
            _ => cmd.push_str(&format!(" {}", ps_quote(&capped))),
        }
    }
    Ok(cmd)
}

pub async fn spawn_session_inner(
    app: &tauri::AppHandle,
    provider: String,
    prompt: Option<String>,
    cwd: Option<String>,
    flags: Option<SpawnFlags>,
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
    let flags = flags.unwrap_or_default();

    let inner = build_inner_command(provider, prompt_ref, cwd_ref, &flags)?;
    let title = format!("ULTRON · {}", provider);

    // Route through cmd.exe /C wt.exe — wt.exe lives in WindowsApps reparse
    // points and Rust's Command::new can fail to launch it directly, while
    // cmd.exe resolves it the same way the user's terminal does.
    let output = app
        .shell()
        .command("cmd.exe")
        .args([
            "/C",
            "wt.exe",
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
        .map_err(|e| format!("spawn cmd/wt: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("wt new-tab failed: {}", stderr));
    }
    Ok(SpawnResult {
        launched: true,
        provider: provider.to_string(),
    })
}
