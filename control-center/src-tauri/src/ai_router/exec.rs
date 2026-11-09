// Retry/backoff helpers and CLI process execution utilities.
//
// Contains:
//   - xorshift64 PRNG for jitter
//   - retry_delay_ms / with_retry
//   - resolve_windows_cli_program (Windows .cmd/.bat resolution, no cmd /C)
//   - cli_invocation_args (codex vs gemini flag divergence)
//   - cli_timeout
//   - run_with_timeout (stdin piping for the codex prompt; on timeout it
//     kills the child's Job Object, see kill_process_tree)
//   - call_cli

use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::sesiones::cli_info::Trabajo;

use super::retry_hint;
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
                let hint = retry_hint::hint_from_message(&msg);
                last_err = (msg, reason);
                if !reason.is_transient() || attempt == max_retries {
                    break;
                }
                // Plazo explícito del proveedor: si es corto se espera eso en
                // vez de la escala fija; si es largo, reintentar es inútil — se
                // corta aquí y el health gate enfría el modelo hasta ese plazo.
                let delay = match hint {
                    Some(secs) if secs > retry_hint::INLINE_RETRY_MAX_SECS => break,
                    Some(secs) => secs * 1000 + 250,
                    None => retry_delay_ms(attempt, reason),
                };
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
        if where_finds(&candidate) {
            return candidate;
        }
    }
    cmd.to_string()
}

/// `where <name>` sin ventana. La app no tiene consola (subsistema
/// `windows`) y `where.exe` sí: sin CREATE_NO_WINDOW, cada sondeo abre una
/// consola que aparece y desaparece en un instante (medido 2026-10-16: dos
/// ventanas de Windows Terminal por cada mensaje a Pupus).
#[cfg(target_os = "windows")]
pub(crate) fn where_finds(name: &str) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("where")
        .arg(name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
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
/// Override de config para el sandbox de Codex en Windows, en toda llamada
/// a `codex exec`. El modo `elevated` falla al preparar el proceso
/// (`helper_unknown_error: setup refresh had errors`, codex-cli 0.162.1,
/// 2026-10-16) y Codex no podía ejecutar ni un comando de solo lectura; el
/// modo `unelevated` aplica la misma política sin el ayudante elevado. Fuera
/// de Windows la clave no se usa.
pub(crate) const CODEX_WINDOWS_SANDBOX: [&str; 2] = ["-c", "windows.sandbox=\"unelevated\""];

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
        args.extend(CODEX_WINDOWS_SANDBOX);
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

/// Grace period to collect the output pipes after a timeout kill.
const KILL_DRAIN_GRACE: Duration = Duration::from_secs(2);

/// Kill `child` AND its descendants.
///
/// A CLI resolved to a `.cmd` shim (`codex.cmd`) runs as `cmd.exe` with the
/// real `node` process as a grandchild that inherits stdout/stderr.
/// `Child::kill` only ends `cmd.exe`: the grandchild stayed alive, kept the
/// pipes open and the reader joins blocked until it finished on its own
/// (router-9, 2026-10-23). The child is put in a Job Object right after the
/// spawn (`Trabajo::solo_al_cortar`); its descendants inherit the job and
/// `TerminateJobObject` ends exactly that tree. No `taskkill /T`: it rebuilds
/// the tree from parent PIDs, so an orphan whose dead parent had a PID now
/// reused by `child` would be killed too, and it costs one more process
/// spawn in the middle of a timeout. `Child::kill` stays as the fallback when
/// there is no job (non-Windows or assignment failure).
fn kill_process_tree(child: &mut std::process::Child, job: Option<&Trabajo>) {
    if let Some(job) = job {
        if let Err(e) = job.terminar() {
            tracing::warn!(pid = child.id(), error = %e, "no se ha podido terminar el job");
        }
    }
    if let Err(e) = child.kill() {
        // InvalidInput = the child already exited, which is the goal.
        if e.kind() != std::io::ErrorKind::InvalidInput {
            tracing::warn!(pid = child.id(), error = %e, "no se ha podido matar el proceso");
        }
    }
}

/// Drain a child pipe on a background thread; the result arrives through
/// the returned channel so the caller can bound how long it waits.
fn spawn_pipe_reader<R: std::io::Read + Send + 'static>(
    pipe: Option<R>,
) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = pipe {
            // A read error just ends the capture: what was read is kept.
            let _ = p.read_to_end(&mut buf);
        }
        // The receiver may have given up after a timeout: nothing to do.
        let _ = tx.send(buf);
    });
    rx
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
/// never deadlock on a full pipe). On timeout the whole process tree is
/// killed (`kill_process_tree`), the pipes get `KILL_DRAIN_GRACE` to close
/// and an `ErrorKind::TimedOut` error is returned: the wait is bounded even
/// if a grandchild survives.
pub(crate) fn run_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
    stdin_input: Option<&str>,
) -> std::io::Result<std::process::Output> {
    use std::io::Write;

    // Sin consola para el hijo en todos los llamantes: la app no tiene consola
    // propia (subsistema `windows`) y un hijo de consola abriría una ventana
    // visible. Ningún llamante usa otros `creation_flags`; este los sustituye.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
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
    crate::sesiones::cli_info::marcar_spawn();
    // Job without kill-on-close: a normal exit leaves alone whatever the CLI
    // left running on purpose; only the timeout terminates the tree.
    let job = Trabajo::solo_al_cortar(&child)
        .inspect_err(
            |e| tracing::warn!(error = %e, "CLI sin Job Object: el plazo solo mata al hijo"),
        )
        .ok();

    if let Some(input) = stdin_input {
        if let Some(mut stdin) = child.stdin.take() {
            let payload = input.as_bytes().to_vec();
            std::thread::spawn(move || {
                let _ = stdin.write_all(&payload);
                // `stdin` drops here, closing the pipe so the child sees EOF.
            });
        }
    }

    let out_reader = spawn_pipe_reader(child.stdout.take());
    let err_reader = spawn_pipe_reader(child.stderr.take());

    let started = Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if started.elapsed() >= timeout => {
                kill_process_tree(&mut child, job.as_ref());
                child.wait()?;
                // Bounded: a surviving grandchild must not block the caller.
                let _ = out_reader.recv_timeout(KILL_DRAIN_GRACE);
                let _ = err_reader.recv_timeout(KILL_DRAIN_GRACE);
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("CLI call exceeded {}s timeout", timeout.as_secs()),
                ));
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };

    let stdout = out_reader.recv().unwrap_or_default();
    let stderr = err_reader.recv().unwrap_or_default();
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Auditoría 2026-10-17 (CC-Router): `run_with_timeout` no ponía
    /// `CREATE_NO_WINDOW` y cada llamante tenía que acordarse; los que no
    /// (`call_cli`, sondeos de cuentas y de versiones) abrían una consola
    /// visible desde la app, que no tiene consola propia. Con el flag, el hijo
    /// recibe una consola propia sin ventana en vez de heredar la del padre:
    /// `GetConsoleProcessList` solo lo cuenta a él. Sin el flag, desde el
    /// runner de tests (que sí tiene consola) cuenta también a sus ancestros.
    #[test]
    fn run_with_timeout_lanza_sin_ventana_de_consola() {
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$t = Add-Type -Name W -Namespace N -PassThru -MemberDefinition \
             '[DllImport(\"kernel32.dll\")] public static extern uint GetConsoleProcessList(uint[] l, uint n);'; \
             [Console]::Out.Write($t::GetConsoleProcessList((New-Object 'UInt32[]' 64), 64))",
        ]);
        let out = run_with_timeout(cmd, Duration::from_secs(60), None).expect("powershell");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let attached = String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert_eq!(
            attached, "1",
            "el hijo comparte la consola del padre ({attached} procesos)"
        );
    }

    /// router-9: con un `cmd.exe` que lanza un nieto (como el shim
    /// `codex.cmd` con su `node`), el plazo tiene que cortar de verdad. Antes
    /// `Child::kill` solo mataba `cmd.exe`, el `ping` nieto conservaba la
    /// tubería de stdout y la llamada esperaba sus ~30 s.
    #[test]
    fn timeout_kills_the_grandchild_and_returns_quickly() {
        let mut cmd = std::process::Command::new("cmd.exe");
        cmd.args(["/C", "ping -n 30 127.0.0.1"]);
        let err =
            run_with_timeout(cmd, Duration::from_secs(1), None).expect_err("debe agotar el plazo");
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        // Desde que el hijo existe: la cola de `spawn` de la suite en
        // paralelo no es lo que se mide (ver `cli_info::marcar_spawn`).
        let elapsed = crate::sesiones::cli_info::desde_el_ultimo_spawn();
        assert!(
            elapsed < Duration::from_secs(10),
            "el plazo de 1 s ha tardado {elapsed:?}: el nieto sigue reteniendo la tubería"
        );
    }
}
