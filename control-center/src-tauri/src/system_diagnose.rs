// ULTRON Control Center — System diagnostics.
//
// Two layers:
//   1. `run_diagnose` — invokes the PowerShell collector and returns a raw
//      JSON report (parsed into serde_json::Value so the UI can render
//      whatever fields the script emits without us baking schema).
//   2. `diagnose_with_ai` — builds an analysis prompt over the report and
//      shells out to Claude via the same `run_inline` path used elsewhere,
//      so the UI can show an LLM-authored summary + recommended fixes.

use std::path::PathBuf;

use serde::Serialize;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize, Clone)]
pub struct DiagnoseResult {
    pub success: bool,
    /// Stringified JSON returned by the PowerShell collector. The UI parses
    /// this on its side so we don't lock the report shape into Rust types.
    pub report_json: String,
    pub stderr: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct AiDiagnoseResult {
    pub success: bool,
    /// Free-text analysis from the LLM.
    pub analysis: String,
    pub stderr: String,
}

fn collector_path() -> Result<PathBuf, String> {
    let p = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/system_diagnose.ps1");
    if !p.exists() {
        return Err(format!("collector script missing: {}", p.display()));
    }
    Ok(p)
}

pub async fn run_diagnose_inner(
    app: &tauri::AppHandle,
    hours: Option<u32>,
) -> Result<DiagnoseResult, String> {
    let script = collector_path()?;
    let script_str = script.to_string_lossy().to_string();
    let hours_str = hours.unwrap_or(24).clamp(1, 168).to_string();
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
            "-Hours",
            &hours_str,
        ])
        .output()
        .await
        .map_err(|e| format!("spawn powershell: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() && stdout.trim().is_empty() {
        return Ok(DiagnoseResult {
            success: false,
            report_json: String::new(),
            stderr,
        });
    }
    Ok(DiagnoseResult {
        success: true,
        report_json: stdout.trim().to_string(),
        stderr,
    })
}

/// Spawns a Claude wt.exe session with the diagnostic report preseeded as
/// the first message. We use a session (not run_inline) for two reasons:
/// (1) Claude inline kept producing empty stdout for prompts of this size
/// even after the PROMPT_CAP bump — likely the shim swallowing output;
/// (2) the user wants interactive follow-up ("dime cómo arreglo esto"),
/// which the inline path doesn't support.
pub async fn diagnose_with_ai_inner(
    app: &tauri::AppHandle,
    report_json: String,
    provider: Option<String>,
) -> Result<AiDiagnoseResult, String> {
    if report_json.trim().is_empty() {
        return Err("report is empty — run diagnose first".to_string());
    }
    // Cap to ~28 KB so we don't bloat the wt.exe command line. The base64
    // payload + capability validator gives us ~100 KB headroom but Claude
    // doesn't need the whole thing to start reasoning.
    let mut report_capped = report_json;
    if report_capped.chars().count() > 28_000 {
        report_capped = report_capped.chars().take(28_000).collect();
        report_capped.push_str("\n\n[truncated]");
    }
    let system = "Eres un ingeniero de soporte de Windows. Te paso un JSON con eventos del Event Viewer, procesos top y metricas de salud. Analiza que pudo causar lentitud, congelaciones o crashes recientes. Responde en ESPANOL con tres secciones cortas:\n1. RESUMEN (2-3 lineas con la hipotesis principal).\n2. EVIDENCIAS (bullets con los eventos/patrones que la apoyan, citando event IDs cuando sean clave).\n3. ACCIONES (3-6 pasos concretos en orden, primero los mas seguros).\nSe directo, no especules sin evidencia, y si no hay senal clara dilo.";
    let prompt = format!(
        "{}\n\nReporte JSON:\n```json\n{}\n```",
        system, report_capped
    );

    let provider = provider.as_deref().unwrap_or("claude").to_string();
    // paste_only = true → wrapper copies prompt to clipboard and opens the
    // CLI WITHOUT auto-submitting. User pastes with Ctrl+V and decides
    // whether to edit before sending. This avoids the (perceived) auto-send
    // surprise — the diagnose prompt is large and the user often wants to
    // tweak it before firing it at Claude.
    let flags = crate::sessions::SpawnFlags {
        paste_only: true,
        ..Default::default()
    };
    let spawn = crate::sessions::spawn_session_inner(
        app,
        provider.clone(),
        Some(prompt),
        None,
        Some(flags),
    )
    .await;

    match spawn {
        Ok(_) => Ok(AiDiagnoseResult {
            success: true,
            analysis: format!(
                "Sesion {} abierta en wt.exe. El prompt del diagnostico esta en tu portapapeles — pega con Ctrl+V, revisalo si quieres, y pulsa Enter para enviarlo.",
                provider
            ),
            stderr: String::new(),
        }),
        Err(e) => Ok(AiDiagnoseResult {
            success: false,
            analysis: String::new(),
            stderr: e,
        }),
    }
}
