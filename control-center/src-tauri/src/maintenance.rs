// ULTRON Control Center — one-shot maintenance commands surfaced as
// buttons in the Dashboard. Each kind in the whitelist below maps to a
// specific cockpit script with hardcoded args. Frontend never injects
// raw arguments — it only passes the `kind` string.
//
// We invoke via std::process::Command (not the Tauri shell plugin) so
// the capability ACL is irrelevant. CREATE_NO_WINDOW keeps console
// flashes off the user's screen.

use std::path::PathBuf;
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct MaintenanceResult {
    pub kind: String,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u128,
}

#[derive(Debug, serde::Deserialize, Serialize)]
pub struct DetectedGap {
    pub severity: String,
    pub category: String,
    pub title: String,
    pub detail: String,
    pub suggestion: Option<String>,
}

#[derive(Debug, serde::Deserialize, Serialize)]
pub struct GapsReport {
    pub generated_at: String,
    pub count: u32,
    pub gaps: Vec<DetectedGap>,
}

/// Spawn wt.exe in a new window running either the uninstaller or
/// `npm run tauri build`. The Control Center keeps running; the spawned
/// terminal shows progress / asks for confirmation. Fire-and-forget —
/// we do not wait for completion.
pub fn run_app_lifecycle_inner(kind: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let ultron = home.join(".ultron");
    let (cwd, ps_script): (PathBuf, String) = match kind.as_str() {
        "uninstall" => {
            let script = ultron.join("uninstall.ps1");
            if !script.is_file() {
                return Err(format!("uninstall.ps1 missing: {}", script.display()));
            }
            // Run the script with Bypass policy, keep the window open at end
            // so the user can read the final summary before closing.
            let cmd = format!(
                "& '{}'; Write-Host ''; Write-Host 'Press any key to close'; [void][System.Console]::ReadKey($true)",
                script.display()
            );
            (ultron.clone(), cmd)
        }
        "update" => {
            let cc = ultron.join("control-center");
            if !cc.is_dir() {
                return Err(format!("control-center/ missing: {}", cc.display()));
            }
            let cmd = "npm run tauri build; Write-Host ''; Write-Host 'Build finished. Press any key to close'; [void][System.Console]::ReadKey($true)".to_string();
            (cc, cmd)
        }
        other => return Err(format!("unknown lifecycle kind: {}", other)),
    };

    // Resolve wt.exe — Windows Terminal. Fall back to plain powershell.exe
    // if wt is not on PATH (shouldn't happen on Win11 but Win10 LTSC etc.).
    let use_wt = std::process::Command::new("where")
        .arg("wt.exe")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let mut command = if use_wt {
        let mut c = std::process::Command::new("wt.exe");
        c.arg("new-tab")
            .arg("--startingDirectory")
            .arg(&cwd)
            .arg("powershell.exe")
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-NoExit")
            .arg("-Command")
            .arg(&ps_script);
        c
    } else {
        let mut c = std::process::Command::new("powershell.exe");
        c.current_dir(&cwd)
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-NoExit")
            .arg("-Command")
            .arg(&ps_script);
        c
    };

    // Detach so the Control Center thread doesn't wait on the new window.
    command
        .spawn()
        .map_err(|e| format!("spawn lifecycle window: {}", e))?;
    Ok(())
}

pub fn run_detect_gaps_inner() -> Result<GapsReport, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let script = home
        .join(".ultron")
        .join("scripts")
        .join("hooks")
        .join("detect_gaps.py");
    if !script.is_file() {
        return Err(format!("detect_gaps.py missing: {}", script.display()));
    }
    let mut command = Command::new("uv");
    command
        .arg("run")
        .arg("python")
        .arg(&script)
        .arg("--json")
        .current_dir(home.join(".ultron"));
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|e| format!("spawn uv: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("detect_gaps exit {:?}: {}", output.status.code(), stderr));
    }
    serde_json::from_str::<GapsReport>(&stdout)
        .map_err(|e| format!("parse detect_gaps json: {} — raw: {}", e, stdout.chars().take(200).collect::<String>()))
}

#[derive(Debug, Serialize, Clone)]
pub struct MaintenanceCommand {
    pub kind: String,
    pub label: String,
    pub description: String,
    pub group: String,
}

/// The set the UI lists in the Dashboard. Order matters — preserved.
pub fn list_maintenance_commands_inner() -> Vec<MaintenanceCommand> {
    vec![
        MaintenanceCommand {
            kind: "skill-registry-rebuild".into(),
            label: "Skill registry rebuild".into(),
            description: "Re-scan ~/.claude/skills, refresh ~/.ultron/skills/registry.json with security verdicts.".into(),
            group: "skills".into(),
        },
        MaintenanceCommand {
            kind: "skill-security-audit".into(),
            label: "Skill security audit".into(),
            description: "Run the prompt-injection scanner against every installed skill (JSON report).".into(),
            group: "skills".into(),
        },
        MaintenanceCommand {
            kind: "registry-sync".into(),
            label: "Registry sync".into(),
            description: "Rebuild the cross-CLI skill manifest (Claude / Codex / Agents mirrors).".into(),
            group: "skills".into(),
        },
        MaintenanceCommand {
            kind: "memory-vault-sync".into(),
            label: "Vault sync".into(),
            description: "Refresh ~/.ultron-vault highlights + brain_index incremental update.".into(),
            group: "memory".into(),
        },
        MaintenanceCommand {
            kind: "brain-index-update".into(),
            label: "Brain index update".into(),
            description: "Incrementally re-index changed notes into ~/.ultron/brain_index.".into(),
            group: "memory".into(),
        },
        MaintenanceCommand {
            kind: "mcp-health".into(),
            label: "MCP health check".into(),
            description: "Probe configured MCP servers and write the latest status snapshot.".into(),
            group: "system".into(),
        },
        MaintenanceCommand {
            kind: "weekly-backup".into(),
            label: "Weekly backup".into(),
            description: "Run the weekly mirror backup script. Updates the Doctor backup status.".into(),
            group: "system".into(),
        },
    ]
}

fn cockpit(home: &PathBuf) -> PathBuf {
    home.join(".ultron").join("scripts").join("cockpit")
}

fn backup_script(home: &PathBuf) -> PathBuf {
    home.join(".ultron").join("scripts").join("backup").join("weekly-backup.ps1")
}

fn build_cmd(kind: &str, home: &PathBuf) -> Result<(String, Vec<String>), String> {
    let cock = cockpit(home);
    Ok(match kind {
        "skill-registry-rebuild" => (
            "uv".into(),
            vec![
                "run".into(),
                "python".into(),
                cock.join("skill_vault.py").to_string_lossy().into_owned(),
                "registry".into(),
            ],
        ),
        "skill-security-audit" => (
            "uv".into(),
            vec![
                "run".into(),
                "python".into(),
                cock.join("skill_sync_security.py").to_string_lossy().into_owned(),
                "audit-all".into(),
                "--json".into(),
            ],
        ),
        "registry-sync" => (
            "uv".into(),
            vec![
                "run".into(),
                "python".into(),
                cock.join("registry_sync.py").to_string_lossy().into_owned(),
                "update-manifest".into(),
            ],
        ),
        "memory-vault-sync" => (
            "uv".into(),
            vec![
                "run".into(),
                "python".into(),
                cock.join("memory_sync.py").to_string_lossy().into_owned(),
                "sync".into(),
            ],
        ),
        "brain-index-update" => (
            "uv".into(),
            vec![
                "run".into(),
                "python".into(),
                cock.join("brain_index.py").to_string_lossy().into_owned(),
                "update".into(),
            ],
        ),
        "mcp-health" => (
            "uv".into(),
            vec![
                "run".into(),
                "python".into(),
                cock.join("mcp_health_check.py").to_string_lossy().into_owned(),
                "--quiet".into(),
            ],
        ),
        "weekly-backup" => {
            let script = backup_script(home);
            if !script.is_file() {
                return Err(format!("backup script missing: {}", script.display()));
            }
            (
                "powershell.exe".into(),
                vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-File".into(),
                    script.to_string_lossy().into_owned(),
                ],
            )
        }
        other => return Err(format!("unknown maintenance kind: {}", other)),
    })
}

pub fn run_maintenance_inner(kind: String) -> Result<MaintenanceResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let (cmd, args) = build_cmd(&kind, &home)?;
    let start = std::time::Instant::now();
    let mut command = Command::new(&cmd);
    command.args(&args).current_dir(home.join(".ultron"));
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = command
        .output()
        .map_err(|e| format!("spawn {}: {}", cmd, e))?;
    Ok(MaintenanceResult {
        kind,
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        elapsed_ms: start.elapsed().as_millis(),
    })
}
