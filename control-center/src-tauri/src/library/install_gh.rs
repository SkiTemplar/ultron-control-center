//! Install agent/skill from GitHub via `gh api repos/<owner>/<repo>/contents/<path>`.

use std::path::PathBuf;

use serde::Deserialize;

use super::gh_helpers::{base64_decode, gh_command};
use super::helpers::{atomic_write_bytes, is_kebab, resolve_agent_target, resolve_skill_dir};
use super::types::{LibraryKind, TargetScope};

#[allow(clippy::too_many_arguments)] // fixed tauri command signature — refactor to builder tracked separately
pub async fn install_from_github_inner(
    owner: String,
    repo: String,
    path: String,
    kind: LibraryKind,
    target_scope: TargetScope,
    target_project_id: Option<String>,
    target_name: Option<String>,
    overwrite: bool,
) -> Result<PathBuf, String> {
    let endpoint = format!("repos/{}/{}/contents/{}", owner, repo, path);
    let args: Vec<String> = vec!["api".into(), endpoint];
    let output = tauri::async_runtime::spawn_blocking(move || gh_command(&args).output())
        .await
        .map_err(|e| format!("spawn join: {e}"))?
        .map_err(|e| format!("gh api failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh api exited {}: {}", output.status, stderr));
    }

    #[derive(Deserialize)]
    struct ContentResp {
        content: String,
        encoding: String,
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let resp: ContentResp =
        serde_json::from_str(&stdout).map_err(|e| format!("gh api json: {e}"))?;
    if resp.encoding != "base64" {
        return Err(format!("unexpected encoding: {}", resp.encoding));
    }
    // GitHub wraps base64 with newlines every 60 chars.
    let cleaned: String = resp
        .content
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let bytes = base64_decode(&cleaned)?;
    let body = String::from_utf8(bytes).map_err(|e| format!("not utf-8: {e}"))?;

    // Derive final name + target path.
    let name = target_name.unwrap_or_else(|| {
        path.rsplit('/')
            .next()
            .unwrap_or("")
            .trim_end_matches(".md")
            .trim_end_matches("/SKILL")
            .to_string()
    });
    if !is_kebab(&name) {
        return Err(format!("invalid name (must be kebab-case): {name}"));
    }

    // Skills go under <root>/skills/<name>/SKILL.md; agents under <root>/agents/<name>.md.
    let target = match kind {
        LibraryKind::Agent => {
            resolve_agent_target(&name, target_scope, target_project_id.as_deref())?
        }
        LibraryKind::Skill => {
            resolve_skill_dir(&name, target_scope, target_project_id.as_deref())?.join("SKILL.md")
        }
    };

    if target.exists() && !overwrite {
        return Err(format!("already exists: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    atomic_write_bytes(&target, body.as_bytes())?;
    Ok(target)
}
