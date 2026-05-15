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

// Flag validation now lives in spawn-claude-session.ps1 — the wrapper
// script handles building the inner command line natively in PowerShell.

/// Minimal stdlib-only base64 encoder. We use it to carry the JSON payload
/// across the powershell.exe argument boundary without dealing with quote
/// escaping. Encoding is RFC 4648 standard alphabet with `=` padding.
fn base64_encode(input: &str) -> String {
    const ALPH: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(ALPH[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPH[((n >> 12) & 0x3F) as usize] as char);
        out.push(ALPH[((n >> 6) & 0x3F) as usize] as char);
        out.push(ALPH[(n & 0x3F) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(ALPH[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPH[((n >> 12) & 0x3F) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(ALPH[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPH[((n >> 12) & 0x3F) as usize] as char);
        out.push(ALPH[((n >> 6) & 0x3F) as usize] as char);
        out.push('=');
    }
    out
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

    // Route through the PowerShell wrapper so we avoid the cmd.exe quoting
    // pitfalls — `?` got interpreted as a wildcard, `---` got tokenised as
    // a separate argv entry (Claude rejected it as `unknown option '---'`),
    // and embedded quotes broke the cmd line. The wrapper takes a base64
    // JSON payload, decodes it inside PowerShell and calls the CLI with
    // the prompt bound as a single argv entry.
    let script: PathBuf = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/run-inline.ps1");
    let script_str = script.to_string_lossy().to_string();
    let payload_json = serde_json::json!({
        "provider": provider,
        "prompt": prompt,
        "model": model.unwrap_or_default(),
    })
    .to_string();
    let payload = base64_encode(&payload_json);

    let output = app
        .shell()
        .command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_str,
            "-Payload",
            &payload,
        ])
        .output()
        .await
        .map_err(|e| format!("spawn powershell: {}", e))?;

    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // The wrapper emits a single JSON object on stdout with the CLI's own
    // stdout/stderr nested inside. If the wrapper itself crashed (no JSON
    // object), fall back to surfacing the raw text so the user sees the
    // diagnostic instead of an empty result.
    #[derive(serde::Deserialize)]
    struct Inner {
        success: bool,
        stdout: String,
        stderr: String,
        exit_code: Option<i32>,
    }

    match serde_json::from_str::<Inner>(raw.trim()) {
        Ok(inner) => Ok(InlineResult {
            success: inner.success,
            stdout: inner.stdout,
            stderr: inner.stderr,
            exit_code: inner.exit_code,
        }),
        Err(_) => Ok(InlineResult {
            success: output.status.success(),
            stdout: raw,
            stderr,
            exit_code: output.status.code(),
        }),
    }
}

// ---------------------------------------------------------------------------
// spawn_session
// ---------------------------------------------------------------------------

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
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let cwd_ref = cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let flags = flags.unwrap_or_default();

    // We used to chain cmd.exe /C wt.exe ... -- powershell.exe -Command "...".
    // That broke under PowerShell's argument parsing when extra flags were
    // present — it concatenated leftover args after -Command into a single
    // string with a leading space, so PowerShell tried to invoke a program
    // literally named `" claude -r <id>"` and CreateProcess returned
    // ERROR_FILE_NOT_FOUND. The new approach: a PowerShell wrapper script
    // (`scripts/cockpit/spawn-claude-session.ps1`) does the wt.exe call via
    // Start-Process. PowerShell parameter binding makes quoting trivial.

    let script: PathBuf = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/spawn-claude-session.ps1");
    let script_str = script.to_string_lossy().to_string();

    // Build a JSON payload then base64-encode it so the double-quotes in
    // the JSON survive PowerShell's command-line arg parsing intact. The
    // capability validator only needs to allow a single base64-ish arg.
    let payload_json = serde_json::json!({
        "provider": provider,
        "cwd": cwd_ref.unwrap_or_default(),
        "prompt": prompt_ref.unwrap_or_default(),
        "model": flags.model.clone().unwrap_or_default(),
        "effort": flags.effort.clone().unwrap_or_default(),
        "name": flags.name.clone().unwrap_or_default(),
        "resumeId": flags.resume_id.clone().unwrap_or_default(),
        "dangerous": flags.dangerously_skip_permissions,
        "continueLast": flags.continue_last,
        "forkSession": flags.fork_session,
    })
    .to_string();
    let payload = base64_encode(&payload_json);

    let output = app
        .shell()
        .command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_str,
            "-Payload",
            &payload,
        ])
        .output()
        .await
        .map_err(|e| format!("spawn powershell: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        return Err(format!(
            "spawn-claude-session.ps1 failed: {}\nstdout: {}",
            stderr.trim(),
            stdout.trim()
        ));
    }
    Ok(SpawnResult {
        launched: true,
        provider: provider.to_string(),
    })
}
