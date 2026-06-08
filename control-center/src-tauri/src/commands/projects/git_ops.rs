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

#[tauri::command]
pub fn git_fetch(path: String) -> Result<String, String> {
    run_git(&["fetch", "--quiet"], &path)
}

/// Returns a structured summary for the UI: branch, remote, ahead, behind, dirty.
/// Parses `git status --short --branch` output.
#[tauri::command]
pub fn git_repo_state(path: String) -> Result<GitRepoState, String> {
    if !std::path::Path::new(&path).join(".git").exists() {
        return Ok(GitRepoState {
            is_repo: false,
            branch: None,
            remote: None,
            ahead: 0,
            behind: 0,
            dirty: false,
            dirty_count: 0,
        });
    }
    let raw = run_git(&["status", "--short", "--branch", "--porcelain=v1"], &path)?;
    let mut branch = None::<String>;
    let mut remote = None::<String>;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut dirty_count = 0u32;
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // e.g. "main...origin/main [ahead 2, behind 1]" or "main" or "HEAD (no branch)"
            let (tracking, counts) = if let Some(idx) = rest.find(" [") {
                (&rest[..idx], Some(&rest[idx + 2..rest.len() - 1]))
            } else {
                (rest, None)
            };
            if let Some((b, r)) = tracking.split_once("...") {
                branch = Some(b.to_string());
                remote = Some(r.to_string());
            } else {
                branch = Some(tracking.replace("No commits yet on ", ""));
            }
            if let Some(counts_str) = counts {
                for part in counts_str.split(", ") {
                    if let Some(n) = part.strip_prefix("ahead ") {
                        ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix("behind ") {
                        behind = n.parse().unwrap_or(0);
                    }
                }
            }
        } else if !line.trim().is_empty() {
            dirty_count += 1;
        }
    }
    Ok(GitRepoState {
        is_repo: true,
        branch,
        remote,
        ahead,
        behind,
        dirty: dirty_count > 0,
        dirty_count,
    })
}

#[derive(serde::Serialize)]
pub struct GitRepoState {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub dirty_count: u32,
}
