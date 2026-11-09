// pty/spawn.rs — PTY spawn helpers: cwd resolution, path probing, command building.

use portable_pty::CommandBuilder;

/// Resolve a caller-supplied `cwd` string to an absolute, existing directory.
///
/// P0 bug fix (2026-05-27): the frontend now passes the project's absolute path
/// (from `ProjectInfo.path`) instead of `"."`. The old `"."` was sensitive to
/// the Tauri process working directory which on Windows defaults to
/// `C:\Windows\System32`, causing every spawned session to open there instead
/// of the project folder.
///
/// `portable-pty` forwards the `cwd` string verbatim into `CreateProcessW`, so
/// any relative path is interpreted relative to the Tauri process — not the
/// user's project. This function normalises the path and provides safe fallbacks
/// in case the supplied path no longer exists (e.g. unmounted network drive).
///
/// Resolution order:
///   1. If `cwd` is a valid existing directory, canonicalise + return it.
///   2. Otherwise fall back to the user's home directory.
///   3. Otherwise fall back to the SystemDrive root (Windows) or `/`.
pub(super) fn resolve_cwd(cwd: &str) -> String {
    use std::path::Path;
    let trimmed = cwd.trim();
    if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
        if let Ok(canon) = std::fs::canonicalize(trimmed) {
            // dunce-style: strip the Windows \\?\ prefix if present so the
            // path is friendlier inside the shell prompt.
            let s = canon.to_string_lossy().to_string();
            return s.trim_start_matches(r"\\?\").to_string();
        }
        return trimmed.to_string();
    }
    if let Some(home) = dirs::home_dir() {
        if home.is_dir() {
            return home.to_string_lossy().to_string();
        }
    }
    #[cfg(windows)]
    {
        std::env::var("SystemDrive")
            .map(|d| format!("{d}\\"))
            .unwrap_or_else(|_| "C:\\".to_string())
    }
    #[cfg(not(windows))]
    {
        "/".to_string()
    }
}

/// Append a single line to `~/.ultron/logs/pty-spawn.log` describing a PTY
/// spawn failure. Best-effort — if the log directory cannot be created we
/// silently drop the entry; the user already sees the propagated error in
/// the UI via the returned `Result<_, String>`.
pub(super) fn log_pty_failure(provider: &str, cwd: &str, msg: &str) {
    tracing::warn!(provider, cwd, error = msg, "fallo al lanzar un PTY");
    let now_iso = || chrono::Local::now().to_rfc3339();
    let dir = match dirs::home_dir() {
        Some(h) => h.join(".ultron").join("logs"),
        None => return,
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("pty-spawn.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = writeln!(
            f,
            "[{}] provider={} cwd={} :: {}",
            now_iso(),
            provider,
            cwd,
            msg
        );
    }
}

/// Resolve which PowerShell executable to spawn into the PTY.
///
/// Preference order on Windows:
///   1. `pwsh.exe` (PowerShell 7+) if it resolves on PATH.
///   2. `powershell.exe` if it resolves on PATH.
///   3. Absolute fallback to `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`.
///
/// We never return an error here — if all probes fail, the absolute
/// System32 path is returned. portable-pty will surface a clear spawn
/// failure if that path is also missing (extremely unlikely on Windows).
#[cfg(windows)]
pub(super) fn resolve_powershell_exe() -> String {
    fn on_path(exe: &str) -> bool {
        use std::os::windows::process::CommandExt;
        let mut probe = std::process::Command::new("where");
        probe.arg(exe);
        probe.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        match probe.output() {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    }
    if on_path("pwsh.exe") {
        return "pwsh.exe".to_string();
    }
    if on_path("powershell.exe") {
        return "powershell.exe".to_string();
    }
    // Absolute fallback. SystemRoot is virtually always set on Windows.
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    format!(
        "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        system_root.trim_end_matches('\\')
    )
}

#[cfg(not(windows))]
pub(super) fn resolve_powershell_exe() -> String {
    // PowerShell on non-Windows is `pwsh`; build_command never reaches here
    // on those platforms because the provider list is Windows-only, but we
    // keep the helper compiling for cargo check / cross-target builds.
    "pwsh".to_string()
}

/// (2026-08-17, medido) Una `ANTHROPIC_API_KEY` en el entorno SECUESTRA al CLI
/// de Claude hijo: ignora el login OAuth de la suscripción Max y cobra por
/// token contra esa key — con saldo 0 la delegación muere en "Credit balance
/// is too low" y además desactiva los conectores de claude.ai. La delegación
/// del sistema es CLI-first por suscripción (coste 0 extra), así que al
/// spawnear `claude` se limpia la variable del entorno del hijo. La key sigue
/// disponible en el proceso de la app (proxy), pero NO en los hooks de `claude`,
/// que heredan su entorno: el sidecar que lanzan resuelve las keys del router
/// desde `HKCU\Environment` (`ai_router::key_source`).
/// Solo afecta a `claude`: otros providers no leen esa variable.
pub(super) fn strip_api_key_for_claude(cmd: &mut CommandBuilder, provider: &str) {
    if provider == "claude" {
        cmd.env_remove("ANTHROPIC_API_KEY");
        for k in inherited_session_vars(std::env::vars().map(|(k, _)| k)) {
            cmd.env_remove(k);
        }
    }
}

/// Variables privadas que ningún hijo del PTY recibe, sea cual sea el
/// proveedor: un `env` dentro de la sesión las escribiría en el transcript.
/// Defensa en profundidad: el arranque ya las borra del proceso.
pub(crate) const PRIVATE_CHILD_VARS: &[&str] = &[crate::mascot::calendar_fetch::ENV_KEY];

pub(super) fn strip_private_vars(cmd: &mut CommandBuilder) {
    for k in PRIVATE_CHILD_VARS {
        cmd.env_remove(k);
    }
}

/// Variables de una sesión de Claude Code que la app hereda si se lanzó
/// desde una (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
/// el socket de mensajería…). Con ellas el `claude` del PTY se comporta como
/// sesión hija y NO escribe transcript: ULTRON Sessions pierde la respuesta
/// definitiva (medido 2026-10-07). Se conservan las de configuración del
/// usuario (`CLAUDE_CODE_PLUGIN_DIRS`, `CLAUDE_CODE_SUBAGENT_MODEL`,
/// `CLAUDE_CODE_EFFORT_LEVEL`), que también llegan por settings.json.
pub(super) fn inherited_session_vars(keys: impl Iterator<Item = String>) -> Vec<String> {
    const KEEP: &[&str] = &[
        "CLAUDE_CODE_PLUGIN_DIRS",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "CLAUDE_CODE_EFFORT_LEVEL",
    ];
    const EXACT: &[&str] = &[
        "CLAUDECODE",
        "CLAUDE_PID",
        "CLAUDE_EFFORT",
        "CLAUDE_PLUGIN_DATA",
    ];
    keys.filter(|k| {
        EXACT.contains(&k.as_str())
            || (k.starts_with("CLAUDE_CODE_") && !KEEP.contains(&k.as_str()))
    })
    .collect()
}

/// Resolve a provider slug to the CommandBuilder that actually spawns it.
///
/// Windows-specific bug fix (2026-05-23): the Claude/Codex CLIs are
/// installed as `.cmd` shim scripts (e.g. `claude.cmd` under the npm prefix
/// or `~/.local/bin`). portable-pty's `CommandBuilder::new("claude")` ends up
/// in CreateProcessW with a bare argv0 of `claude`, which does NOT walk
/// PATHEXT — so the shim is never found and the spawn fails silently (PTY
/// shows nothing, child exits immediately). The fix mirrors the trick used in
/// `sessions::spawn_session_inner`: shell out via `cmd.exe /C <provider>` so
/// the cmd interpreter resolves `<provider>.cmd` through PATHEXT.
///
/// Other providers we add (`powershell`, `powershell-admin`) get their own
/// branches here — `powershell` runs Windows PowerShell 5.1 inside the PTY,
/// and `powershell-admin` re-launches PowerShell elevated through UAC
/// (Start-Process -Verb RunAs) without keeping the elevated session attached
/// to our PTY (UAC always opens a fresh console window).
///
/// Note: `gemini` was removed 2026-06-19 — Google cut the free-tier OAuth.
/// `where <name>` without a console window: `Ok(true)` if it resolves.
#[cfg(windows)]
fn on_path_windows(name: &str) -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    let mut probe = std::process::Command::new("where");
    probe.arg(name);
    probe.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = probe
        .output()
        .map_err(|e| format!("PATH probe failed: {e}"))?;
    Ok(output.status.success())
}

/// Error for a CLI missing from PATH, with the real install command
/// (`@claude/cli` does not exist; Claude Code is `@anthropic-ai/claude-code`).
fn not_found_message(provider: &str) -> String {
    let install = match provider {
        "claude" => "Install Claude Code (native installer from claude.ai/code or `npm i -g @anthropic-ai/claude-code`)",
        "codex" => "Install the Codex CLI (`npm i -g @openai/codex`)",
        _ => "Install the CLI",
    };
    format!("'{provider}' not found on PATH. {install} and restart ULTRON.")
}

pub(super) fn build_command(provider: &str, agent: Option<&str>) -> Result<CommandBuilder, String> {
    let trimmed = provider.trim();
    if trimmed.is_empty() {
        return Err("provider is empty".to_string());
    }
    match trimmed {
        "claude" | "codex" => {
            // v2.6 bug fix: pre-validate the binary exists on PATH. Without
            // this, codex just opens a PTY that immediately dies because
            // cmd.exe ran but the shim wasn't found — the user sees a blank
            // terminal instead of a clear error. Run `where` on Windows
            // (POSIX `which` on others) and surface the result.
            #[cfg(windows)]
            {
                // A CLI installed after ULTRON started is not in the inherited
                // PATH: complete it from the registry and probe once more.
                if !on_path_windows(trimmed)? {
                    crate::env_path::refresh_from_registry();
                    if !on_path_windows(trimmed)? {
                        return Err(not_found_message(trimmed));
                    }
                }
                let mut cmd = CommandBuilder::new("cmd.exe");
                cmd.arg("/C");
                cmd.arg(trimmed);
                if let Some(a) = agent {
                    cmd.arg("--agent");
                    cmd.arg(a);
                }
                strip_api_key_for_claude(&mut cmd, trimmed);
                Ok(cmd)
            }
            #[cfg(not(windows))]
            {
                let output = std::process::Command::new("which")
                    .arg(trimmed)
                    .output()
                    .map_err(|e| format!("PATH probe failed: {e}"))?;
                if !output.status.success() {
                    return Err(not_found_message(trimmed));
                }
                let mut cmd = CommandBuilder::new(trimmed);
                if let Some(a) = agent {
                    cmd.arg("--agent");
                    cmd.arg(a);
                }
                strip_api_key_for_claude(&mut cmd, trimmed);
                Ok(cmd)
            }
        }
        "powershell" => {
            // Plain Windows PowerShell PTY.
            //
            // v2.6.1 P0 bug fix: the previous build called
            //     CommandBuilder::new("powershell.exe").arg("-NoLogo")
            // which left the user's PowerShell profile enabled. A profile that
            // loads oh-my-posh, posh-git, PSReadLine custom prompts, or any
            // module with network/auth side-effects (Azure / AWS / GitHub) can
            // block startup for 5-30s — to the user the PTY just "stays
            // hanging without opening anything", exactly the reported P0 bug.
            //
            // Fix:
            //   1. Add -NoProfile so user-level profiles do not run inside the
            //      embedded PTY. Power users can still run `& $PROFILE` once
            //      the shell is up if they want their profile loaded.
            //   2. Prefer pwsh.exe (PowerShell 7) when on PATH — it's faster
            //      to start and renders modern TUIs better. Fall back to
            //      powershell.exe (Windows PowerShell 5.1).
            //   3. If neither shim is on PATH, fall back to the absolute
            //      System32 path so a corrupted PATH does not break the
            //      terminal entirely.
            //
            // F7-B encoding fix: Windows PowerShell starts with the OEM code
            // page (CP850 on Spanish systems, CP437 on English). Bytes from
            // the PTY reach the frontend correctly via base64, but the shell
            // itself emits accented characters as OEM bytes instead of UTF-8,
            // so tildes/enyes appear as mojibake in the viewer. We force both
            // Console.OutputEncoding and Console.InputEncoding to UTF-8 via
            // -NoExit -Command before the interactive prompt appears. Using
            // -NoExit keeps the shell alive (same as a plain -NoProfile call);
            // the user lands at an interactive prompt with UTF-8 already set.
            // PYTHONUTF8=1 covers any Python subprocess spawned from the shell.
            let exe = resolve_powershell_exe();
            let mut cmd = CommandBuilder::new(&exe);
            cmd.arg("-NoLogo");
            cmd.arg("-NoProfile");
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg(
                "[Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.Encoding]::UTF8",
            );
            cmd.env("PYTHONUTF8", "1");
            Ok(cmd)
        }
        "powershell-admin" => {
            // UAC elevation. We launch a *non-elevated* PowerShell whose sole
            // job is to call Start-Process -Verb RunAs on another PowerShell.
            // The elevated session necessarily opens in its own console window
            // (Windows does not let an unelevated PTY adopt an elevated child),
            // but the user gets the UAC prompt + admin shell as requested.
            //
            // v2.6.1: also -NoProfile + resolved exe for the same reasons as
            // the plain `powershell` branch.
            let exe = resolve_powershell_exe();
            let mut cmd = CommandBuilder::new(&exe);
            cmd.arg("-NoLogo");
            cmd.arg("-NoProfile");
            cmd.arg("-Command");
            cmd.arg("try { Start-Process -Verb RunAs powershell.exe -ArgumentList '-NoLogo' -ErrorAction Stop; Write-Host 'Admin PowerShell launched in a new window. (UAC opens elevated consoles outside the embedded PTY.)' } catch { Write-Host ('Admin launch failed: ' + $_.Exception.Message) -ForegroundColor Red }");
            Ok(cmd)
        }
        other => Err(format!("unknown provider '{}'", other)),
    }
}

// `cli_on_path` (cheap PATH pre-check for the delegation fallback decision)
// was retired 2026-09-14 alongside `agent_orchestration::delegate` (kanban
// "comandos huérfanos"). `build_command` above still does its own PATH probe
// at spawn time. Recoverable from git history if the feature gets wired to a
// UI later.

#[cfg(test)]
mod not_found_tests {
    use super::not_found_message;

    #[test]
    fn el_aviso_de_claude_manda_al_paquete_real() {
        let m = not_found_message("claude");
        assert!(m.contains("not found on PATH"), "{m}");
        assert!(m.contains("@anthropic-ai/claude-code"), "{m}");
        assert!(!m.contains("@claude/cli"), "paquete inexistente: {m}");
    }

    #[test]
    fn el_aviso_de_codex_no_inventa_un_paquete() {
        let m = not_found_message("codex");
        assert!(m.contains("@openai/codex"), "{m}");
        assert!(!m.contains("@codex/cli"), "{m}");
    }
}
