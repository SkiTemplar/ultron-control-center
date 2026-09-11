// Retry/backoff helpers and CLI process execution utilities.
//
// Contains:
//   - xorshift64 PRNG for jitter
//   - retry_delay_ms / with_retry
//   - resolve_windows_cli_program (Windows .cmd/.bat resolution, no cmd /C)
//   - cli_invocation_args (codex vs gemini flag divergence)
//   - cli_timeout
//   - run_with_timeout (stdin piping for the codex prompt)
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
// Windows .cmd/.bat resolution — avoids the cmd.exe /C shell entirely
// ---------------------------------------------------------------------------
//
// HISTORY (KIRKARDO HIGH fix, 2026-09-11): this module used to build ONE
// shell string and run it via `cmd /C <string>`, because `Command::new("codex")`
// fails with NotFound on Windows — npm installs its CLIs as `<name>.cmd`
// shims, and Rust's `Command` does NOT do the PATHEXT-style extension search
// a real shell performs (verified empirically). To make that string safe it
// tried to neuter cmd.exe metacharacters (`sanitize_for_cmd`, replacing
// `&|<>^%()!"` with `_`), which was BOTH incomplete (cmd.exe re-parses the
// whole reconstructed line with its own quoting rules, which don't nest
// safely with the outer Rust-level escaping no matter how careful the
// caller is — this is a well-known, structural cmd.exe hazard, not a bug in
// any one sanitizer) AND destructive for legitimate content (a real prompt
// with a colon, an ampersand, or an accented word got silently mangled
// before the CLI ever saw it).
//
// The fix removes the shell layer instead of trying to escape around it:
// resolve the CLI's real `.cmd`/`.exe`/`.bat` path and `Command::new` it
// DIRECTLY (verified empirically to preserve `&|<>^%"'` and UTF-8 accents
// byte-for-byte — Rust's own .bat/.cmd spawn path applies correct Windows
// argv escaping, and only hard-rejects a literal embedded `"` as a security
// guard). Codex additionally reads the prompt from stdin (`codex exec -`)
// instead of argv, which sidesteps that remaining edge case for the one
// argument that carries genuinely arbitrary content.

/// Resolve the Windows executable to spawn for a CLI provider's bare command
/// name (e.g. `"codex"` -> `"codex.cmd"`). Probes `where <candidate>` for
/// each extension in priority order and returns the first PATH hit; falls
/// back to the bare name unchanged if none of the extended variants exist
/// (so a literal extensionless PATH entry, e.g. a `.com`, keeps working).
#[cfg(target_os = "windows")]
pub(crate) fn resolve_windows_cli_program(cmd: &str) -> String {
    for ext in ["cmd", "exe", "bat"] {
        let candidate = format!("{cmd}.{ext}");
        let found = std::process::Command::new("where")
            .arg(&candidate)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if found {
            return candidate;
        }
    }
    cmd.to_string()
}

// ---------------------------------------------------------------------------
// CLI invocation helpers
// ---------------------------------------------------------------------------

/// Argument vector for a CLI provider's non-interactive invocation.
///
/// Codex uses the `exec` subcommand. The prompt is READ FROM STDIN — the
/// literal `-` positional tells `codex exec` to do that (confirmed via
/// `codex exec --help`: "If not provided as an argument (or if `-` is used),
/// instructions are read from stdin"). The caller (`call_cli`) is
/// responsible for actually piping the prompt bytes; this function only
/// builds argv and therefore ignores its `prompt` parameter for the codex
/// branch — arbitrary prompt content never has to survive ANY argv/shell
/// escaping this way, on any platform (KIRKARDO HIGH fix, 2026-09-11).
///
/// `--model`/`-m` IS a valid `codex exec` flag (confirmed 2026-09-11 via
/// `codex exec --help`: `-m, --model <MODEL>  Model the agent should use`) —
/// an older comment here claiming it was rejected was stale and caused a
/// separate wiring bug: the ZoneAssignment's model never reached the CLI, so
/// every codex-cli call silently used whatever `~/.codex/config.toml` had,
/// regardless of the zone (code-edit/code-review/etc). We now append
/// `--model <model>` when the caller supplies a non-empty one, so per-zone
/// model routing (terra/sol/astra) actually takes effect (KIRKARDO fix,
/// 2026-09-11).
///
/// Gemini has no documented pure-stdin equivalent for its primary prompt
/// (`-p/--prompt`'s own `--help` text: "Appended to input on stdin (if
/// any)" — stdin only ADDS to `-p`, it doesn't replace it), so it stays on
/// argv: `-p <prompt> --model <model>`.
/// (KIRKARDO AI-Routing fix, 2026-06-07)
pub(crate) fn cli_invocation_args<'a>(
    is_codex: bool,
    prompt: &'a str,
    model: &'a str,
) -> Vec<&'a str> {
    if is_codex {
        let _ = prompt; // prompt travels via stdin, not argv — see call_cli
        let mut args = vec![
            "exec",
            "-",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
        ];
        if !model.trim().is_empty() {
            args.push("--model");
            args.push(model);
        }
        args
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
/// `stdin_input`, when `Some`, is written to the child's stdin on a
/// background thread and the handle is then dropped to close the pipe (EOF)
/// — `codex exec -` blocks reading stdin until EOF, so writing synchronously
/// before draining stdout/stderr would deadlock once the prompt exceeds the
/// OS pipe buffer. `None` keeps stdin closed (`Stdio::null()`), as before.
///
/// stdout/stderr are drained on background threads (so a chatty child can
/// never deadlock on a full pipe), and on timeout the child is killed and an
/// `ErrorKind::TimedOut` error returned.
pub(crate) fn run_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
    stdin_input: Option<&str>,
) -> std::io::Result<std::process::Output> {
    use std::io::{Read, Write};

    let stdin_mode = if stdin_input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    };
    let mut child = cmd
        .stdin(stdin_mode)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(input) = stdin_input {
        if let Some(mut stdin) = child.stdin.take() {
            let payload = input.as_bytes().to_vec();
            std::thread::spawn(move || {
                let _ = stdin.write_all(&payload);
                // `stdin` drops here, closing the pipe so the child sees EOF.
            });
        }
    }

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
/// `model` is the caller's ZoneAssignment model (falls back to the provider's
/// `default_model` upstream in `try_assignment_call` only if the caller wants
/// that) — NOT re-derived from `provider.default_model` here. Before
/// 2026-09-11 this function ignored its caller entirely and always used
/// `provider.default_model`, so a zone-specific model (e.g. code-review's
/// gpt-5.6-sol vs code-edit's gpt-5.6-terra) never reached the CLI call
/// (KIRKARDO wiring fix, 2026-09-11).
///
/// Spawns the resolved CLI program DIRECTLY (no `cmd /C` shell layer on any
/// platform — see the module-level HISTORY comment above
/// `resolve_windows_cli_program`). Codex-cli protocol requirement:
/// `--sandbox read-only` is always appended for the `codex-cli` provider
/// (id == "codex-cli" or cli_command == "codex"). Gemini CLI does not
/// support that flag and is left unchanged.
pub(crate) fn call_cli(
    provider: &Provider,
    prompt: &str,
    model: &str,
) -> Result<CallOutcome, (String, FailReason)> {
    let cmd = provider.cli_command.as_deref().ok_or_else(|| {
        (
            format!("provider '{}' has no cli_command configured", provider.id),
            FailReason::Error,
        )
    })?;

    let is_codex = provider.id == "codex-cli" || provider.cli_command.as_deref() == Some("codex");
    let args = cli_invocation_args(is_codex, prompt, model);

    #[cfg(target_os = "windows")]
    let program = resolve_windows_cli_program(cmd);
    #[cfg(not(target_os = "windows"))]
    let program = cmd.to_string();

    let mut command = std::process::Command::new(&program);
    command.args(&args);

    // Codex reads the prompt from stdin (see cli_invocation_args's doc);
    // every other CLI provider still carries it on argv.
    let stdin_input = if is_codex { Some(prompt) } else { None };

    let output = run_with_timeout(command, cli_timeout(), stdin_input).map_err(|e| {
        let reason = if e.kind() == std::io::ErrorKind::TimedOut {
            FailReason::Timeout
        } else {
            FailReason::Error
        };
        (format!("{program}: {e}"), reason)
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((
            format!(
                "{program} exited {}: {}",
                output.status,
                super::providers::truncate(stderr.trim(), 300)
            ),
            FailReason::Error,
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        return Err((format!("{program} produced no output"), FailReason::Error));
    }
    Ok(CallOutcome {
        text: stdout,
        usage: TokenUsage::default(),
    })
}
