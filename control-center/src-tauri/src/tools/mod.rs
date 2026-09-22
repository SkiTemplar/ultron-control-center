// "Herramientas" — Settings section listing the standalone CLIs ULTRON
// integrates with (markitdown, rumdl, mmdc, glow, agy, codex): instalada o
// no, version real, para que sirve en una linea, y el comando de instalacion
// si falta. READ-ONLY: nunca instala ni modifica nada, solo prueba `--version`
// (mandamiento 11 — estado explicito si falla, nunca un no-op silencioso).
//
// Patron calcado de `crate::accounts` (mismo Settings, secciones hermanas):
// catalogo constante + resolucion de binario en Windows con fallback a
// WinGet Links para las CLIs que no llegan a PATH via `where` (glow, agy —
// ver `accounts::probe::resolve_agy_binary`, verificado el mismo problema
// aqui el 2026-09-22).

mod probe;

use serde::{Deserialize, Serialize};

/// Una entrada del catalogo de herramientas (dato estatico, sin I/O).
struct ToolSpec {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    install_hint: &'static str,
    /// Nombre del binario tal y como se invoca (sin extension).
    bin: &'static str,
    version_args: &'static [&'static str],
    /// Si `where <bin>.<ext>` falla en PATH, intenta tambien
    /// `%LOCALAPPDATA%\Microsoft\WinGet\Links\<bin>.exe` (glow, agy: WinGet
    /// "link" shims que no siempre llegan a PATH en esta maquina).
    winget_links_fallback: bool,
}

/// Unico sitio donde anadir una herramienta nueva.
const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        id: "markitdown",
        label: "markitdown",
        description: "Convierte documentos (PDF/DOCX/PPTX/XLSX/HTML/EPUB) a Markdown por stdout.",
        install_hint: "uv tool install markitdown",
        bin: "markitdown",
        version_args: &["--version"],
        winget_links_fallback: false,
    },
    ToolSpec {
        id: "rumdl",
        label: "rumdl",
        description: "Linter y formateador de Markdown (`rumdl check`, `rumdl fmt`).",
        install_hint: "uv tool install rumdl",
        bin: "rumdl",
        version_args: &["--version"],
        winget_links_fallback: false,
    },
    ToolSpec {
        id: "mmdc",
        label: "mmdc (Mermaid CLI)",
        description: "Genera PNG/SVG a partir de diagramas Mermaid (`mmdc -i a.mmd -o a.png`).",
        install_hint: "npm install -g @mermaid-js/mermaid-cli",
        bin: "mmdc",
        version_args: &["--version"],
        winget_links_fallback: false,
    },
    ToolSpec {
        id: "glow",
        label: "glow",
        description: "Renderiza Markdown con estilo en la terminal.",
        install_hint: "winget install charmbracelet.glow",
        bin: "glow",
        version_args: &["--version"],
        winget_links_fallback: true,
    },
    ToolSpec {
        id: "agy",
        label: "agy (Antigravity CLI)",
        description:
            "CLI de Antigravity (Google). Cuenta/modelos: ver seccion \"Cuentas y modelos\".",
        install_hint: "winget install Google.AntigravityCLI",
        bin: "agy",
        version_args: &["--version"],
        winget_links_fallback: true,
    },
    ToolSpec {
        id: "codex",
        label: "codex",
        description:
            "CLI de Codex (ChatGPT/OpenAI). Cuenta/modelos: ver seccion \"Cuentas y modelos\".",
        install_hint: "npm install -g @openai/codex",
        bin: "codex",
        version_args: &["--version"],
        winget_links_fallback: false,
    },
];

/// Estado de una herramienta, tal y como lo consume la UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolInfo {
    pub id: String,
    pub label: String,
    pub description: String,
    pub installed: bool,
    /// Version real (primera linea no vacia de `--version`). Vacia solo
    /// cuando `installed` tambien lo es (nunca un booleano sin explicacion).
    pub version: String,
    /// Explicito cuando el binario esta pero `--version` no respondio a
    /// tiempo o no devolvio nada — nunca se confunde con "no instalado".
    pub version_error: String,
    pub install_hint: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolsReport {
    pub tools: Vec<ToolInfo>,
}

/// Wall-clock cap para `<tool> --version`. Corto a proposito: la seccion se
/// prueba entera (6 binarios) cada vez que se abre Settings > Herramientas.
const VERSION_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

fn probe_tool(spec: &ToolSpec) -> ToolInfo {
    let base = ToolInfo {
        id: spec.id.to_string(),
        label: spec.label.to_string(),
        description: spec.description.to_string(),
        install_hint: spec.install_hint.to_string(),
        ..Default::default()
    };
    let Some(bin) = probe::resolve_binary(spec.bin, spec.winget_links_fallback) else {
        return base; // installed=false, version="" — respuesta explicita, no un error oculto
    };
    let mut cmd = std::process::Command::new(&bin);
    cmd.args(spec.version_args);
    match crate::ai_router::exec::run_with_timeout(cmd, VERSION_PROBE_TIMEOUT, None) {
        Ok(output) => {
            let version = probe::parse_version_output(&output.stdout, &output.stderr);
            ToolInfo {
                installed: true,
                version_error: if version.is_empty() {
                    "el binario no devolvio texto en --version".to_string()
                } else {
                    String::new()
                },
                version,
                ..base
            }
        }
        Err(e) => ToolInfo {
            installed: true,
            version_error: format!("--version no respondio: {e}"),
            ..base
        },
    }
}

/// Sondea las 6 CLIs del catalogo. BLOQUEANTE (spawns cortos con timeout) —
/// el `#[tauri::command]` en `commands/misc_sub/tools.rs` lo mueve a
/// `spawn_blocking`.
#[must_use]
pub fn status() -> ToolsReport {
    ToolsReport {
        tools: TOOLS.iter().map(probe_tool).collect(),
    }
}

#[cfg(test)]
mod manual_verification {
    use super::*;

    /// Not part of CI (`#[ignore]`): sondea las CLIs REALES de esta maquina.
    ///   cargo test -p control-center --lib tools::manual_verification::print_real_status -- --ignored --nocapture
    #[test]
    #[ignore = "hits this machine's real installed CLIs — run manually"]
    fn print_real_status() {
        for t in status().tools {
            println!(
                "[{}] installed={} version={:?} version_error={:?}",
                t.id, t.installed, t.version, t.version_error
            );
        }
    }
}
