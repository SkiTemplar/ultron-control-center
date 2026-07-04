// Retry/backoff helpers and CLI process execution utilities.
//
// Contains:
//   - xorshift64 PRNG for jitter
//   - retry_delay_ms / with_retry
//   - sanitize_for_cmd (Windows shell sanitizer)
//   - cli_invocation_args (codex vs gemini flag divergence)
//   - cli_timeout
//   - run_with_timeout
//   - call_cli

use std::process::Stdio;
use std::time::{Duration, Instant};

use super::types::{CallOutcome, FailReason, Provider, TokenUsage};

// ---------------------------------------------------------------------------
// Xorshift64 PRNG
// ---------------------------------------------------------------------------

/// Xorshift64 PRNG seeded with wall-clock nanos mixed with the process id.
///
/// NOT suitable for cryptographic use.  Only used for backoff jitter.
pub(crate) fn xorshift64_jitter_seed() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0xDEAD_BEEF_CAFE_1234);
    let pid = std::process::id() as u64;
    let mut x = nanos ^ (pid.wrapping_shl(17)) ^ (pid.wrapping_shr(3));
    if x == 0 {
        x = 0xDEAD_BEEF_CAFE_1234;
    }
    x ^= x.wrapping_shl(13);
    x ^= x.wrapping_shr(7);
    x ^= x.wrapping_shl(17);
    x
}

/// Jitter-enhanced backoff delays for retry attempts (0-indexed attempt number).
///
/// Dos escalas segun el fallo (cat3 2026-07-04, diagnostico metrics.json:
/// fail_reasons = {rate_limit: 103} — el 100% de los fallos reales son 429):
/// - `RateLimit`: 2s/5s/10s — los 429 de groq free-tier son ventanas RPM de
///   ~60s; la escala corta (0.5/1/2s) quemaba los 3 retries DENTRO de la misma
///   ventana y cada rafaga acababa en fallback real (18-20 por ventana rolling).
///   El caso RPD (cuota diaria agotada) NO paga esta espera: attempt_assignment
///   lo corta ANTES por el contador `daily`, sin llegar aqui.
/// - resto transitorio (Overloaded/Timeout): 0.5/1/2s, capped 4s, como siempre.
///
/// Jitter ±20 % de la base en ambas escalas.
pub(crate) fn retry_delay_ms(attempt: u32, reason: FailReason) -> u64 {
    let base: u64 = if matches!(reason, FailReason::RateLimit) {
        match attempt {
            0 => 2_000,
            1 => 5_000,
            _ => 10_000,
        }
    } else {
        match attempt {
            0 => 500,
            1 => 1000,
            2 => 2000,
            _ => 4000,
        }
    };
    let rng_val = xorshift64_jitter_seed() % 1000;
    let jitter_ratio = (rng_val as f64 / 1000.0) * 0.4 - 0.2;
    let jitter_ms = (base as f64 * jitter_ratio) as i64;
    ((base as i64) + jitter_ms).max(100) as u64
}

/// Try `f` up to `max_retries + 1` times with jitter-backoff between attempts.
/// Only retries when the closure signals a transient `FailReason`.
///
/// Returns `(CallOutcome, retries_used)` on success and
/// `(error_msg, FailReason)` on terminal failure.
pub(crate) fn with_retry<F>(
    max_retries: u32,
    mut f: F,
) -> Result<(CallOutcome, u32), (String, FailReason)>
where
    F: FnMut() -> Result<CallOutcome, (String, FailReason)>,
{
    let mut last_err = (String::new(), FailReason::Error);
    for attempt in 0..=max_retries {
        match f() {
            Ok(outcome) => return Ok((outcome, attempt)),
            Err((msg, reason)) => {
                last_err = (msg, reason);
                if !reason.is_transient() || attempt == max_retries {
                    break;
                }
                let delay = retry_delay_ms(attempt, reason);
                std::thread::sleep(Duration::from_millis(delay));
            }
        }
    }
    Err(last_err)
}

// ---------------------------------------------------------------------------
// CLI sanitizer (Windows cmd.exe shell-injection prevention)
// ---------------------------------------------------------------------------

/// Replace every cmd.exe meta-character with `_` and backslashes with `/`.
///
/// On Windows, npm `.cmd` shims must be run via `cmd /C`. This sanitizer
/// prevents shell injection by neutering `& | < > ^ % ( ) ! "` and `\`
/// before the prompt is embedded in the shell string.
/// (KIRKARDO R11.1 CVE + F1 2026-06-10 backslash root-cause fix).
pub fn sanitize_for_cmd(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' | '|' | '<' | '>' | '^' | '%' | '(' | ')' | '!' | '"' => out.push('_'),
            '\\' => out.push('/'),
            '\r' | '\n' | '\t' => out.push(' '),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// CLI invocation helpers
// ---------------------------------------------------------------------------

/// Argument vector for a CLI provider's non-interactive invocation.
///
/// Codex uses the `exec` subcommand with a POSITIONAL prompt and no `--model`
/// (the ChatGPT account picks the model; passing `--model` is rejected).
/// Gemini uses `-p <prompt> --model <model>`.
/// (KIRKARDO AI-Routing fix, 2026-06-07)
pub(crate) fn cli_invocation_args<'a>(
    is_codex: bool,
    prompt: &'a str,
    model: &'a str,
) -> Vec<&'a str> {
    if is_codex {
        vec![
            "exec",
            prompt,
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
        ]
    } else {
        vec!["-p", prompt, "--model", model]
    }
}

/// Hard wall-clock limit for a CLI provider call.
/// Override with `ULTRON_CLI_TIMEOUT_S`.
pub(crate) fn cli_timeout() -> Duration {
    let secs = std::env::var("ULTRON_CLI_TIMEOUT_S")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(90);
    Duration::from_secs(secs)
}

/// Run a prepared `Command` with piped stdio and a wall-clock timeout.
///
/// stdout/stderr are drained on background threads (so a chatty child can
/// never deadlock on a full pipe), and on timeout the child is killed and an
/// `ErrorKind::TimedOut` error returned.
pub(crate) fn run_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
) -> std::io::Result<std::process::Output> {
    use std::io::Read;

    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut p) = stdout_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut p) = stderr_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_reader.join();
                let _ = err_reader.join();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("CLI call exceeded {}s timeout", timeout.as_secs()),
                ));
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };

    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// Invoke a CLI provider synchronously and return its stdout on success.
/// CLI providers do not expose token counters, so usage stays at zero.
///
/// Codex-cli protocol requirement: `--sandbox read-only` is always appended
/// for the `codex-cli` provider (id == "codex-cli" or cli_command == "codex").
/// Gemini CLI does not support that flag and is left unchanged.
pub(crate) fn call_cli(
    provider: &Provider,
    prompt: &str,
) -> Result<CallOutcome, (String, FailReason)> {
    let cmd = provider.cli_command.as_deref().ok_or_else(|| {
        (
            format!("provider '{}' has no cli_command configured", provider.id),
            FailReason::Error,
        )
    })?;

    let model = provider.default_model.as_str();
    let is_codex = provider.id == "codex-cli" || provider.cli_command.as_deref() == Some("codex");

    // SAFETY: all strings are owned by the caller; no raw pointers.
    #[cfg(target_os = "windows")]
    let output = {
        // On Windows, npm `.cmd` shims must be invoked via `cmd /C`. Cmd.exe
        // interprets `& | < > ^ %` as meta-characters, so a prompt containing
        // `& calc` would execute `calc.exe` (KIRKARDO R11.1 CVE). We sanitise
        // the prompt by replacing every cmd-meta char with `_` BEFORE building
        // the shell string. Inner double-quotes are also stripped — npm CLIs
        // tolerate single-quoted prompts but cmd.exe quoting of nested quotes
        // is hostile, so the safest path is to neuter them entirely.
        // Newlines collapse to spaces because /C accepts a single line.
        //
        // F1 2026-06-10 (root cause de gemini-cli 164/0): '\\' tampoco era
        // neutralizado — un backslash antes de la comilla de cierre escapaba
        // el quoting y el resto del prompt se parseaba como ARGUMENTOS del CLI
        // (runtime: "Unknown arguments: repo, limit, log-failed..."). Los
        // backslashes se convierten a '/' (los paths Windows siguen legibles).
        let safe_prompt = sanitize_for_cmd(prompt);
        let safe_cmd = sanitize_for_cmd(cmd);
        let safe_model = sanitize_for_cmd(model);
        let parts = cli_invocation_args(is_codex, &safe_prompt, &safe_model);
        let joined = parts
            .iter()
            .enumerate()
            .map(|(i, tok)| {
                if i == 1 {
                    format!("\"{tok}\"")
                } else {
                    (*tok).to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        let shell_arg = format!("{safe_cmd} {joined}");
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", &shell_arg]);
        run_with_timeout(command, cli_timeout()).map_err(|e| {
            let reason = if e.kind() == std::io::ErrorKind::TimedOut {
                FailReason::Timeout
            } else {
                FailReason::Error
            };
            (format!("cmd /C {cmd}: {e}"), reason)
        })?
    };

    #[cfg(not(target_os = "windows"))]
    let output = {
        let args = cli_invocation_args(is_codex, prompt, model);
        let mut command = std::process::Command::new(cmd);
        command.args(&args);
        run_with_timeout(command, cli_timeout()).map_err(|e| {
            let reason = if e.kind() == std::io::ErrorKind::TimedOut {
                FailReason::Timeout
            } else {
                FailReason::Error
            };
            (format!("{cmd}: {e}"), reason)
        })?
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((
            format!(
                "{cmd} exited {}: {}",
                output.status,
                super::providers::truncate(stderr.trim(), 300)
            ),
            FailReason::Error,
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        return Err((format!("{cmd} produced no output"), FailReason::Error));
    }
    Ok(CallOutcome {
        text: stdout,
        usage: TokenUsage::default(),
    })
}
