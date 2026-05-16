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
