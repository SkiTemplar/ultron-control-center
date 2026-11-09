// ULTRON Control Center — Sessions & quick actions.
//
// spawn_session opens Windows Terminal (wt.exe) with the chosen provider CLI.
// wt.exe lives in the WindowsApps reparse-point directory, so we go through
// cmd.exe /C wt.exe ... to dodge the launcher quirks Rust's Command::new
// exhibits on those pseudo-executables.
//
// `run_inline` (salida de la CLI dentro de la app vía run-inline.ps1) se
// retiró el 2026-10-17 junto con su único llamante, «Generate MCP from
// prompt», que no tenía entrada en la UI.
//
// PowerShell quoting: prompts are single-quoted and apostrophes doubled
// ('foo'bar' → 'foo''bar'). The argument that reaches wt.exe goes through
// the capability validator regex, so anything off-grammar is rejected.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize, Clone)]
pub struct SpawnResult {
    pub launched: bool,
    pub provider: String,
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
    /// Saltarse las confirmaciones de permisos (`--dangerously-skip-permissions`
    /// en Claude, `--dangerously-bypass-approvals-and-sandbox` en Codex).
    ///
    /// Tres estados, y por eso es `Option`: `Some(true)` y `Some(false)` son la
    /// decisión explícita del llamante y se respetan tal cual; `None` (campo
    /// ausente o `null`) aplica el valor por defecto de los flujos internos de
    /// ULTRON (ver [`resolve_dangerous`]). Con un `bool` simple un `false`
    /// explícito era indistinguible de «no puesto» y acababa en bypass.
    #[serde(default)]
    pub dangerously_skip_permissions: Option<bool>,
    /// `--continue` — resume the latest conversation in the chosen cwd. When
    /// true the prompt argument is ignored.
    #[serde(default)]
    pub continue_last: bool,
    /// `--fork-session` — combined with continue/resume, starts a new branch
    /// off the resumed conversation instead of overwriting it.
    #[serde(default)]
    pub fork_session: bool,
    /// When true, the wrapper script will NOT overwrite the clipboard with
    /// the prompt — it assumes the caller has already seeded it with the
    /// real prompt. The `prompt` value is shown as a banner only.
    #[serde(default)]
    pub respect_clipboard: bool,
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
    /// When true, the wrapper script MUST copy the prompt to the clipboard
    /// and open the provider CLI WITHOUT auto-submitting it (no argv `-p`,
    /// no positional prompt). The user pastes with Ctrl+V and decides
    /// whether to send.
    ///
    /// As of v15.1.4+ the wrapper script already takes the clipboard route
    /// by default for ANY non-empty prompt (inline -p / positional broke
    /// too often with newlines and special chars). This flag makes that
    /// contract explicit so callers like the Dashboard "Diagnose with
    /// Claude" button can guarantee the prompt won't be auto-submitted
    /// even if the default ever changes back.
    #[serde(default)]
    pub paste_only: bool,
    /// Cuando true, la sesion se enruta por el proxy free-tier local en
    /// lugar de usar la API de Anthropic directamente. El wrapper PS1
    /// setea `ANTHROPIC_BASE_URL=http://127.0.0.1:8082` y el token dummy
    /// `ANTHROPIC_AUTH_TOKEN=fcc-local` antes de invocar `claude`.
    #[serde(default)]
    pub free_tier: bool,
    /// Optional subagent slug (filename stem under `~/.claude/agents/`).
    /// When set, `spawn_session_inner` prepends a `[USE AGENT: <slug>]`
    /// directive to the prompt so the Claude session opens with the right
    /// subagent context. Callers normally don't set this manually — the
    /// AI Router (Settings → AI Router) propagates it from the zone the
    /// user picked.
    ///
    /// Backwards compat: `None` (or absent in JSON) is the historical
    /// behaviour — no prefix is added to the prompt. Only Claude sessions
    /// honour the directive today; codex ignores it silently.
    #[serde(default)]
    pub agent: Option<String>,
}

// Flag validation now lives in spawn-claude-session.ps1 — the wrapper
// script handles building the inner command line natively in PowerShell.

/// Minimal stdlib-only base64 encoder. We use it to carry the JSON payload
/// across the powershell.exe argument boundary without dealing with quote
/// escaping. Encoding is RFC 4648 standard alphabet with `=` padding.
pub fn base64_encode(input: &str) -> String {
    const ALPH: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
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
        "codex" => Ok("codex"),
        other => Err(format!("unknown provider '{}'", other)),
    }
}

/// Build the agent directive that gets prepended to a prompt when the
/// caller (typically the AI Router) wants a specific subagent to handle
/// the session. We keep the format conservative: a single bracketed line
/// + blank separator, so the body of the prompt stays readable and the
///   directive parses cleanly in Claude's subagent invocation grammar.
///
/// Sanity rules:
///   * empty / None  → no prefix.
///   * non-empty     → `"[USE AGENT: <slug>]\n\n" + prompt`.
///
/// The slug itself is validated upstream — this helper trusts its input.
fn prepend_agent_directive(prompt: &str, agent: Option<&str>) -> String {
    match agent {
        Some(a) if !a.trim().is_empty() => {
            format!("[USE AGENT: {}]\n\n{}", a.trim(), prompt)
        }
        _ => prompt.to_string(),
    }
}

// ---------------------------------------------------------------------------
// spawn_session
// ---------------------------------------------------------------------------

/// Compare two Windows paths for "same directory" purposes: case-insensitive
/// and blind to trailing separators. Not a canonicalisation (no symlink
/// resolution) — the registry stores literal paths and so does the caller.
fn same_dir(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.trim()
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_ascii_lowercase()
    };
    !a.trim().is_empty() && norm(a) == norm(b)
}

/// Accent colour of the project a session opens in, as `#rrggbb`. `None` when
/// the directory isn't a registered project or the project has no colour.
fn project_colour_for_cwd(cwd: &str) -> Option<String> {
    let projects = crate::projects::list_projects_inner().ok()?;
    let project = projects.iter().find(|p| {
        p.path.as_deref().is_some_and(|path| same_dir(path, cwd))
            || p.parent_folder_override
                .as_deref()
                .is_some_and(|path| same_dir(path, cwd))
    })?;
    project.color.clone()
}

/// Resolve the per-project Claude Code settings file for a session opened at
/// `cwd` (it selects the generated theme). Returns `None` when the directory
/// isn't a registered project, the project has no colour, or the files can't
/// be written.
pub(crate) fn project_theme_for_cwd(cwd: &str) -> Option<String> {
    let projects = crate::projects::list_projects_inner().ok()?;
    let project = projects.iter().find(|p| {
        p.path.as_deref().is_some_and(|path| same_dir(path, cwd))
            || p.parent_folder_override
                .as_deref()
                .is_some_and(|path| same_dir(path, cwd))
    })?;
    let colour = project.color.as_deref()?;
    let name = project.name.as_deref().unwrap_or(&project.id);
    match crate::claude_theme::ensure_project_theme(&project.id, name, colour) {
        Ok(settings_path) => Some(settings_path),
        Err(e) => {
            tracing::warn!("[sessions] per-project theme skipped: {e}");
            None
        }
    }
}

/// Decide si la sesión externa (wt.exe) arranca saltándose los permisos.
///
/// - `Some(v)`: manda el llamante. Un `false` explícito nunca se convierte en
///   bypass, sea cual sea `claude_safe_mode`. Lo usan los flujos que tocan
///   contenido no confiable (p. ej. «Integrar con IA» del catálogo de GitHub,
///   que abre Claude sobre un repo ajeno cuyo README puede traer inyección de
///   prompt).
/// - `None`: flujos internos de ULTRON (noticias, edición de skills, alta de
///   MCP, diagnóstico, relevo de Codex, abrir el CLI en un proyecto propio).
///   Decisión de la v15.1.4: el clic del usuario ya autoriza la acción, así
///   que van con bypass salvo que `features.json:claude_safe_mode` sea `true`.
///
/// `safe_mode` es perezoso para no leer `features.json` cuando el llamante ya
/// decidió.
pub(crate) fn resolve_dangerous(requested: Option<bool>, safe_mode: impl FnOnce() -> bool) -> bool {
    match requested {
        Some(explicit) => explicit,
        None => !safe_mode(),
    }
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
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let cwd_ref = cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let flags = flags.unwrap_or_default();
    let dangerous = resolve_dangerous(flags.dangerously_skip_permissions, || {
        crate::features::read_features_inner().claude_safe_mode
    });

    // v15.2.39 AI Router agent integration: if the caller (typically the
    // AI Router via Settings → AI Router) picked a specific subagent for
    // the zone, prepend a `[USE AGENT: <slug>]` directive to the prompt
    // before it reaches the wrapper script. We do this BEFORE the prompt
    // gets bundled into the base64 JSON payload so the wrapper / CLI sees
    // the directive as part of the prompt text. No agent set → prompt
    // passes through unchanged (backwards compat).
    let prompt_ref = match prompt_ref {
        Some(p) => Some(prepend_agent_directive(&p, flags.agent.as_deref())),
        None => prompt_ref,
    };

    // We used to chain cmd.exe /C wt.exe ... -- powershell.exe -Command "...".
    // That broke under PowerShell's argument parsing when extra flags were
    // present — it concatenated leftover args after -Command into a single
    // string with a leading space, so PowerShell tried to invoke a program
    // literally named `" claude -r <id>"` and CreateProcess returned
    // ERROR_FILE_NOT_FOUND. The new approach: a PowerShell wrapper script
    // (`scripts/cockpit/spawn-claude-session.ps1`) does the wt.exe call via
    // Start-Process. PowerShell parameter binding makes quoting trivial.

    // v2.7.2 — per-project colour. If the session's cwd belongs to a project
    // that has an accent colour, generate/refresh its Claude Code custom
    // theme and forward `custom:<slug>`; the wrapper turns it into
    // `--settings '{"theme":"..."}'`. Best-effort by design: any failure
    // (no registry, bad hex, unwritable ~/.claude/themes) drops the theme and
    // the session spawns exactly as before instead of failing the launch.
    let theme_ref = cwd_ref
        .as_deref()
        .filter(|_| provider == "claude")
        .and_then(project_theme_for_cwd);

    // La pestaña de Windows Terminal se tiñe con el mismo acento del proyecto
    // (`--tabColor`). El tema de Claude solo pinta lo que dibuja el CLI dentro
    // del marco; la ventana seguía siendo idéntica para todos los proyectos, que
    // es lo que se ve al alternar entre varias terminales abiertas. A diferencia
    // del `--colorScheme` retirado en 2026-08-15, tabColor NO toca el fondo:
    // solo la pestaña y la barra de título. Aplica a claude y a codex.
    let tab_colour = cwd_ref.as_deref().and_then(project_colour_for_cwd);

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
        // Siempre presente y ya resuelto: el wrapper lo obedece tal cual.
        "dangerous": dangerous,
        "continueLast": flags.continue_last,
        "forkSession": flags.fork_session,
        "pasteOnly": flags.paste_only,
        // F10 fix (v15.2.1): forward respect_clipboard so the PS1 script can
        // skip Set-Clipboard. Callers that prime the clipboard themselves
        // MUST set this — otherwise the spawn script overwrites the real
        // prompt with the short `seed` banner and the user pastes garbage
        // into the AI CLI.
        "respectClipboard": flags.respect_clipboard,
        // free_tier: activo cuando el caller lo pide explicitamente O cuando el
        // proxy-state persistido esta habilitado (auto-ON al 98% de cuota).
        // Esto cierra el hueco donde el auto-ON activaba el toggle en la UI pero
        // los spawns sin free_tier=true seguian saliendo por Anthropic directo.
        "freeTier": flags.free_tier || crate::proxy::read_proxy_state_enabled(),
        // Ruta a un settings JSON con el tema del proyecto; cadena vacía = sin
        // tema propio y la sesión conserva el que el usuario tenga puesto.
        // Va como RUTA y no como JSON inline porque PowerShell 5.1 destruye las
        // comillas dobles al pasar el argumento al ejecutable nativo.
        "settingsFile": theme_ref.unwrap_or_default(),
        // Acento del proyecto en `#rrggbb` para `wt.exe --tabColor`. Cadena
        // vacía = proyecto sin color y la pestaña queda con el aspecto normal.
        "tabColor": tab_colour.unwrap_or_default(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_directive_prepended_when_set() {
        let out = prepend_agent_directive("hello world", Some("debugger"));
        assert_eq!(out, "[USE AGENT: debugger]\n\nhello world");
    }

    #[test]
    fn agent_directive_skipped_when_none() {
        let out = prepend_agent_directive("hello world", None);
        assert_eq!(out, "hello world");
    }

    #[test]
    fn agent_directive_skipped_when_empty() {
        let out = prepend_agent_directive("hello", Some("   "));
        assert_eq!(out, "hello");
    }

    // C1 (auditoría 2026-10-17): un `false` explícito del llamante se
    // convertía en bypass cuando `claude_safe_mode` era `false`.
    #[test]
    fn false_explicito_no_se_convierte_en_bypass() {
        let flags: SpawnFlags =
            serde_json::from_str(r#"{"dangerouslySkipPermissions": false}"#).unwrap();
        assert_eq!(flags.dangerously_skip_permissions, Some(false));
        // safe_mode=false es el valor real de features.json en esta máquina.
        assert!(!resolve_dangerous(
            flags.dangerously_skip_permissions,
            || false
        ));
        assert!(!resolve_dangerous(
            flags.dangerously_skip_permissions,
            || true
        ));
    }

    #[test]
    fn true_explicito_se_respeta_aunque_haya_modo_seguro() {
        assert!(resolve_dangerous(Some(true), || true));
    }

    /// Flujos internos (campo ausente o `null`): bypass salvo `claude_safe_mode`.
    #[test]
    fn sin_decision_del_llamante_aplica_el_defecto_interno() {
        for raw in ["{}", r#"{"dangerouslySkipPermissions": null}"#] {
            let flags: SpawnFlags = serde_json::from_str(raw).unwrap();
            assert_eq!(flags.dangerously_skip_permissions, None, "{raw}");
            assert!(
                resolve_dangerous(None, || false),
                "sin modo seguro -> bypass"
            );
            assert!(!resolve_dangerous(None, || true), "modo seguro -> permisos");
        }
    }

    #[test]
    fn la_decision_explicita_no_lee_features() {
        let mut leido = false;
        let _ = resolve_dangerous(Some(false), || {
            leido = true;
            false
        });
        assert!(
            !leido,
            "con decisión explícita no se consulta claude_safe_mode"
        );
    }

    /// El wrapper obedece `dangerous` del payload. Antes fijaba `$true` sin
    /// condición: este test falla con ese script.
    #[cfg(windows)]
    #[test]
    fn el_wrapper_respeta_dangerous_del_payload() {
        let script = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../scripts/cockpit/spawn-claude-session.ps1"
        );
        let inner = |payload: &str| -> String {
            let encoded = base64_encode(payload);
            let out = std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    script,
                    "-Payload",
                    encoded.as_str(),
                    "-DryRun",
                ])
                .output()
                .expect("powershell.exe disponible");
            assert!(
                out.status.success(),
                "dry-run falló: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let skip = "--dangerously-skip-permissions";
        let bypass = "--dangerously-bypass-approvals-and-sandbox";
        assert!(!inner(r#"{"provider":"claude","dangerous":false}"#).contains(skip));
        assert!(inner(r#"{"provider":"claude","dangerous":true}"#).contains(skip));
        assert!(!inner(r#"{"provider":"codex","dangerous":false}"#).contains(bypass));
        assert!(inner(r#"{"provider":"codex","dangerous":true}"#).contains(bypass));
        // Llamante antiguo sin el campo: defecto de los flujos internos.
        assert!(inner(r#"{"provider":"claude"}"#).contains(skip));
    }

    #[test]
    fn agent_directive_trims_slug_whitespace() {
        let out = prepend_agent_directive("body", Some("  refactoring-specialist  "));
        assert_eq!(out, "[USE AGENT: refactoring-specialist]\n\nbody");
    }
}
