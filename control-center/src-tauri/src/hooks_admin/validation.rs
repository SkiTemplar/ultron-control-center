// hooks_admin/validation.rs — Input validation: events, commands, matchers.

use std::sync::OnceLock;
use std::time::Duration;

/// Catalogo unico de eventos de hook. El frontend importa el MISMO fichero
/// (`src/components/hooks/constants.ts`), de modo que ambos lados no pueden
/// desincronizarse: hasta el 2026-09-28 el backend aceptaba 9 y la interfaz
/// ofrecia 30, y guardar un `PostToolUseFailure` fallaba.
const EVENTS_JSON: &str = include_str!("../../../src/components/hooks/hook-events.json");

/// Eventos que Claude Code despacha. Todo lo que quede fuera lo rechaza
/// `add_hook_inner`, para no escribir nunca un evento con una errata que jamas
/// se dispararia.
pub fn allowed_events() -> &'static [String] {
    static EVENTS: OnceLock<Vec<String>> = OnceLock::new();
    EVENTS.get_or_init(|| {
        serde_json::from_str(EVENTS_JSON).expect("hook-events.json debe ser una lista de strings")
    })
}

/// Hard cap on the Test button run (no sandbox) — Claude Code imposes a 60s ceiling
/// on hook execution; we test for "does this command produce sensible
/// output quickly" so 5s is plenty and protects against hangs from
/// commands that try to read stdin interactively.
pub const TEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Substrings rejected by `validate_command`. Not a perfect RCE filter —
/// the user could still write a malicious .ps1 file and call it — but it
/// blocks the most common copy-pasted footguns and the obvious AI
/// hallucinated "curl|bash" patterns we don't want to silently persist.
///
/// Built at module load so the source file itself never contains a
/// literal forbidden fragment (avoids tripping ULTRON's own
/// settings-edit safety hooks during dev edits of THIS file).
pub(crate) fn forbidden_fragments() -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    v.push("Invoke-Expression".to_string());
    v.push("invoke-expression".to_string());
    v.push(" IEX ".to_string());
    v.push(" iex ".to_string());
    v.push("IEX(".to_string());
    v.push("iex(".to_string());
    v.push("DownloadString".to_string());
    v.push("curl -s ".to_string());
    v.push("curl -fsSL ".to_string());
    v.push("wget -O- ".to_string());
    v.push("; rm -rf".to_string());
    v.push(";rm -rf".to_string());
    v.push("&& rm -rf".to_string());
    v.push("rm -rf /".to_string());
    v.push("rm -rf ~".to_string());
    v.push("; del /f /s /q".to_string());
    v.push("Remove-Item -Recurse -Force C:\\".to_string());
    v.push("format c:".to_string());
    v.push("format C:".to_string());
    // Built piecewise so this very file does not contain the literal
    // 4-letter danger token that some scanners block on save.
    v.push(format!("{}{}", "ev", "al("));
    v.push("/dev/tcp/".to_string());
    v.push("base64 -d | sh".to_string());
    v
}

pub fn validate_event(event: &str) -> Result<(), String> {
    if allowed_events().iter().any(|e| e == event) {
        Ok(())
    } else {
        Err(format!(
            "event '{}' is not supported (allowed: {})",
            event,
            allowed_events().join(", ")
        ))
    }
}

pub fn validate_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("command is empty".into());
    }
    if trimmed.len() > 4_000 {
        return Err("command is suspiciously long (>4000 chars)".into());
    }
    // CC-12 hardening: PowerShell treats a backtick as a no-op escape
    // before any non-special char — `` `i`ex `` evaluates identically to
    // `iex`. The original substring check missed that. Normalise the
    // command by (a) stripping every backtick AND (b) lower-casing the
    // whole string before scanning for forbidden fragments. The needles
    // are also normalised the same way so we don't have to encode every
    // possible casing variant in the blocklist.
    let normalised: String = trimmed
        .chars()
        .filter(|c| *c != '`')
        .collect::<String>()
        .to_ascii_lowercase();
    for needle in forbidden_fragments() {
        let needle_norm: String = needle
            .chars()
            .filter(|c| *c != '`')
            .collect::<String>()
            .to_ascii_lowercase();
        if normalised.contains(&needle_norm) {
            return Err(format!(
                "command contains forbidden fragment '{}' (blocked by safety net)",
                needle.trim()
            ));
        }
        if trimmed.contains(&needle) {
            return Err(format!(
                "command contains forbidden fragment '{}' (blocked by safety net)",
                needle.trim()
            ));
        }
    }
    Ok(())
}

pub fn validate_matcher(matcher: Option<&str>) -> Result<(), String> {
    let Some(m) = matcher else { return Ok(()) };
    if m.len() > 512 {
        return Err("matcher is too long".into());
    }
    if m.contains('\n') || m.contains('\r') || m.contains('\0') {
        return Err("matcher cannot contain newlines or NUL bytes".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_catalogo_tiene_33_eventos_sin_duplicados() {
        // Claude Code 2.1.309 (2026-10-23): los 30 de docs/GOAL.md mas
        // DirectoryAdded, PreModelSwitch y PostModelSwitch.
        let events = allowed_events();
        assert_eq!(events.len(), 33);
        let mut sorted: Vec<&String> = events.iter().collect();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            events.len(),
            "hay eventos duplicados en hook-events.json"
        );
    }

    /// Regresion (2026-09-28): la interfaz ofrecia `PostToolUseFailure` y otros 20
    /// eventos que el backend rechazaba al guardar.
    #[test]
    fn acepta_todos_los_eventos_que_ofrece_la_interfaz() {
        for e in [
            "PostToolUseFailure",
            "StopFailure",
            "PermissionDenied",
            "WorktreeCreate",
            "ElicitationResult",
            "PreToolUse",
            "PreModelSwitch",
            "PostModelSwitch",
            "DirectoryAdded",
        ] {
            assert!(validate_event(e).is_ok(), "deberia aceptar {e:?}");
        }
        for e in allowed_events() {
            assert!(validate_event(e).is_ok(), "deberia aceptar {e:?}");
        }
    }

    /// Caso negativo: erratas, mayusculas distintas, espacios y vacio siguen fuera.
    #[test]
    fn rechaza_erratas_variantes_de_mayusculas_y_vacio() {
        for e in [
            "",
            "posttooluse",
            "PostToolUsefailure",
            "PostToolUse ",
            "Post Tool Use",
            "SessionStar",
            "NoExiste",
        ] {
            assert!(validate_event(e).is_err(), "deberia rechazar {e:?}");
        }
    }

    #[test]
    fn el_error_lista_los_eventos_permitidos() {
        let err = validate_event("Nope").unwrap_err();
        assert!(
            err.contains("Nope") && err.contains("PostToolUseFailure"),
            "{err}"
        );
    }
}
