// Full-system diagnostics, auto-fix, doctor, self-improve commands.
use crate::{full_diagnostic, self_improve, system_diagnose};
use tauri_plugin_shell::ShellExt;

// F6: Dashboard rework — parallel system diagnostic + auto-fix scripts.
#[tauri::command]
pub async fn run_full_diagnostic() -> Result<full_diagnostic::FullDiagnostic, String> {
    full_diagnostic::run_full_diagnostic_inner()
}

#[tauri::command]
pub async fn apply_auto_fix(
    app: tauri::AppHandle,
    name: String,
) -> Result<full_diagnostic::AutoFixResult, String> {
    full_diagnostic::apply_auto_fix_inner(&app, name).await
}

#[tauri::command]
pub async fn run_diagnose(
    app: tauri::AppHandle,
    hours: Option<u32>,
) -> Result<system_diagnose::DiagnoseResult, String> {
    system_diagnose::run_diagnose_inner(&app, hours).await
}

#[tauri::command]
pub async fn diagnose_with_ai(
    app: tauri::AppHandle,
    report_json: String,
    provider: Option<String>,
) -> Result<system_diagnose::AiDiagnoseResult, String> {
    system_diagnose::diagnose_with_ai_inner(&app, report_json, provider).await
}

#[tauri::command]
pub async fn self_improve_report() -> Result<self_improve::SelfImproveReport, String> {
    self_improve::self_improve_report_inner()
}

#[tauri::command]
pub async fn run_codex_adversarial_review(
    app: tauri::AppHandle,
) -> Result<self_improve::ReviewResult, String> {
    self_improve::run_codex_adversarial_review_inner(&app).await
}

#[tauri::command]
pub async fn run_doctor(app: tauri::AppHandle) -> Result<super::CmdResult, String> {
    // Invokes the enhanced doctor script (Python) and returns its full
    // stdout for the UI to render. Doctor never mutates state — it only
    // reports findings.
    let script = crate::ultron_root()?.join("scripts/cockpit/doctor_check.py");
    let script_str = script.to_string_lossy().to_string();
    let output = app
        .shell()
        .command("uv")
        .args(["run", "python", &script_str])
        .output()
        .await
        .map_err(|e| format!("spawn uv: {}", e))?;
    Ok(super::CmdResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
}
