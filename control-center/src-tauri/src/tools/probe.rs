// Binary resolution + version-string parsing for `tools::status`. Kept
// separate from `mod.rs` so the pure `parse_version_output` (no I/O) is
// trivially unit-testable, including the negative case (empty output).

use std::path::PathBuf;

/// Resolve the executable to spawn for a bare CLI name. Windows: `where
/// <bin>.<ext>` in priority order (same probe as
/// `ai_router::exec::resolve_windows_cli_program`), then — only for CLIs
/// flagged `winget_links_fallback` — the WinGet "link" shim folder, which is
/// NOT always on PATH (confirmed on this machine for `glow`/`agy`: absent
/// from PATH, present at `%LOCALAPPDATA%\Microsoft\WinGet\Links\<bin>.exe`).
/// Returns `None` when neither resolves — that is the "not installed" answer.
pub(super) fn resolve_binary(bin: &str, winget_links_fallback: bool) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let resolved = crate::ai_router::exec::resolve_windows_cli_program(bin);
        if resolved != bin {
            return Some(PathBuf::from(resolved));
        }
        if winget_links_fallback {
            if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                let candidate = PathBuf::from(local_app_data)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links")
                    .join(format!("{bin}.exe"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = winget_links_fallback;
        // Non-Windows: no PATHEXT/WinGet concept — let `Command::new` do its
        // own PATH resolution, same fallback `accounts::probe` uses.
        Some(PathBuf::from(bin))
    }
}

/// First non-empty line of stdout, or of stderr if stdout was empty (some
/// CLIs — none observed here, but defensive) print the version to stderr.
/// Pure, no I/O: takes raw process output bytes.
pub(super) fn parse_version_output(stdout: &[u8], stderr: &[u8]) -> String {
    first_nonempty_line(stdout).unwrap_or_else(|| first_nonempty_line(stderr).unwrap_or_default())
}

fn first_nonempty_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_first_nonempty_stdout_line() {
        assert_eq!(parse_version_output(b"rumdl 0.2.75\n", b""), "rumdl 0.2.75");
    }

    #[test]
    fn skips_leading_blank_lines_in_stdout() {
        assert_eq!(
            parse_version_output(b"\n\nmmdc 11.17.0\nextra\n", b""),
            "mmdc 11.17.0"
        );
    }

    #[test]
    fn falls_back_to_stderr_when_stdout_is_empty() {
        assert_eq!(
            parse_version_output(b"", b"codex-cli 0.154.0\n"),
            "codex-cli 0.154.0"
        );
    }

    /// NEGATIVO: ni stdout ni stderr tienen contenido (p.ej. un binario que
    /// respondio pero no imprimio nada a `--version`) -> cadena vacia, NUNCA
    /// un panic ni un valor inventado.
    #[test]
    fn returns_empty_string_when_both_streams_are_empty() {
        assert_eq!(parse_version_output(b"", b""), "");
    }

    /// NEGATIVO: salida solo con espacios/saltos de linea -> vacia igualmente.
    #[test]
    fn returns_empty_string_when_output_is_only_whitespace() {
        assert_eq!(parse_version_output(b"   \n\t\n  \n", b"\n \n"), "");
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(
            parse_version_output(b"  glow version 3.0.0 (add5e7a)  \n", b""),
            "glow version 3.0.0 (add5e7a)"
        );
    }

    /// NEGATIVO: binario ausente en absoluto (fuera de PATH y del fallback
    /// WinGet Links) -> `resolve_binary` devuelve `None`, nunca un `Some`
    /// inventado que `mod.rs` intentaria spawnear.
    #[test]
    fn resolve_binary_returns_none_for_a_name_that_does_not_exist_anywhere() {
        assert!(resolve_binary("ultron-tool-that-does-not-exist-xyz", true).is_none());
    }
}
