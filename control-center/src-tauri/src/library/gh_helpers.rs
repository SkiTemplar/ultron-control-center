//! GitHub subprocess helpers.
//!
//! Plain `std::process::Command::new("gh")` on Windows flashes a console
//! window for the lifetime of the subprocess, which the user flagged as
//! annoying in v2.5.1 ("se lanza una terminal que no se quita"). Setting
//! `CREATE_NO_WINDOW` (0x0800_0000) keeps the spawn fully invisible.

use std::path::Path;

pub(super) fn gh_command(args: &[String]) -> std::process::Command {
    let mut cmd = std::process::Command::new("gh");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

pub(super) fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))
}

/// Clone a GitHub repo using `gh repo clone`.
pub(super) fn clone_repo(owner: &str, repo: &str, dest: &Path) -> Result<(), String> {
    let slug = format!("{}/{}", owner, repo);
    let dest_str = dest.to_string_lossy().to_string();
    let mut cmd = std::process::Command::new("gh");
    cmd.args(["repo", "clone", &slug, &dest_str]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("gh repo clone: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("gh repo clone failed: {stderr}"));
    }
    Ok(())
}
