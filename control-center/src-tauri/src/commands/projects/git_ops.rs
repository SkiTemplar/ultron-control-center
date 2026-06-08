// commands/projects/git_ops.rs — Git operations per project path.
//
// All commands take a `path` string (absolute dir) and run git
// in that directory. Returns stdout+stderr merged as String.
// Errors surface as Err(String) so the frontend shows them directly.

use std::process::Command;

fn run_git(args: &[&str], cwd: &str) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git not found: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let combined = format!("{stdout}{stderr}").trim().to_string();
    if out.status.success() || !stdout.is_empty() {
        Ok(if combined.is_empty() { "OK".to_string() } else { combined })
    } else {
        Err(if combined.is_empty() {
            format!("git exited with code {:?}", out.status.code())
        } else {
            combined
        })
    }
}

#[tauri::command]
pub fn git_is_repo(path: String) -> bool {
    std::path::Path::new(&path).join(".git").exists()
}

#[tauri::command]
pub fn git_status(path: String) -> Result<String, String> {
    run_git(&["status", "--short", "--branch"], &path)
}

#[tauri::command]
pub fn git_pull(path: String) -> Result<String, String> {
    run_git(&["pull", "--ff-only"], &path)
}

#[tauri::command]
pub fn git_push(path: String) -> Result<String, String> {
    run_git(&["push"], &path)
}

#[tauri::command]
pub fn git_init(path: String) -> Result<String, String> {
    run_git(&["init"], &path)
}

#[tauri::command]
pub fn git_log_short(path: String) -> Result<String, String> {
    run_git(&["log", "--oneline", "-8"], &path)
}
