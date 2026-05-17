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
            // v15.3.6: switched from [Console]::ReadKey to Read-Host. The
            // Console.ReadKey API requires a real interactive console which
            // wt.exe doesn't reliably present (4-window race observed by
            // user — Win32 error 2147942402). Read-Host always works.
            let cmd = format!(
                "& '{}'; Write-Host ''; Read-Host 'Press Enter to close'",
                script.display()
            );
            (ultron.clone(), cmd)
        }
        "update" => {
            // v15.4.3: auto-relaunch after a successful build. We kill the
            // running control-center.exe, wait for the file lock to drop,
            // then Start-Process the fresh binary. The terminal closes
            // itself 3 s after launch so the user isn't left with a stale
            // PowerShell window. On build failure we leave the window open
            // (Read-Host) so the user can read the cargo / npm error
            // instead of seeing the terminal vanish.
            //
            // Run the cmd as a here-string so PS sees the multi-line
            // logic. `$LASTEXITCODE` after `npm run tauri build` tells us
            // whether to relaunch or pause for the user.
            let cmd = r#"
$ErrorActionPreference = 'Continue'

# v15.4.20 fix: kill the running Control Center BEFORE the build, not after.
# `tauri build` overwrites src-tauri\target\release\control-center.exe at
# the end of the compile, which fails with "Acceso denegado" (os error 5)
# when the running app holds the binary's file handle. Same flow used
# below at relaunch time, but here we need it pre-build too.
$exePath = Join-Path (Get-Location) 'src-tauri\target\release\control-center.exe'
if (Test-Path -LiteralPath $exePath) {
    Write-Host '[ULTRON] Closing running Control Center before build...' -ForegroundColor Cyan
    taskkill.exe /IM 'control-center.exe' /F 2>$null | Out-Null
    taskkill.exe /IM 'ULTRON Control Center.exe' /F 2>$null | Out-Null
    # Wait up to 8 s for Windows to release the file handle. Without this
    # the link step can still race the kill and lock the exe.
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
        try {
            $fs = [System.IO.File]::Open($exePath, 'Open', 'ReadWrite', 'None')
            $fs.Close()
            break
        } catch { }
    }
}

Write-Host '[ULTRON] git pull...' -ForegroundColor Cyan
git pull --ff-only
Write-Host '[ULTRON] npm install...' -ForegroundColor Cyan
npm install
Write-Host '[ULTRON] tauri build...' -ForegroundColor Cyan
npm run tauri build
$buildExit = $LASTEXITCODE
if ($buildExit -ne 0) {
    Write-Host ''
    Write-Host '[ULTRON] Build FAILED (exit ' $buildExit '). The window stays open so you can read the error above.' -ForegroundColor Red
    Read-Host 'Press Enter to close this terminal'
    exit $buildExit
}

$exe = Join-Path (Get-Location) 'src-tauri\target\release\control-center.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host ('[ULTRON] Build succeeded but binary missing at ' + $exe) -ForegroundColor Yellow
    Read-Host 'Press Enter to close this terminal'
    exit 1
}

Write-Host ''
Write-Host '[ULTRON] Build OK. Closing old instance + relaunching...' -ForegroundColor Green
# v15.4.7 — Stop-Process -Name solo matchea procesos cuyo nombre del .exe
# es exactamente 'control-center'. Cuando el binario corre desde el NSIS
# installer (Program Files / AppData), el process name puede diferir o
# el spawned PS no tiene permisos suficientes para matarlo. taskkill
# /IM control-center.exe /F mata por imagen sin /T — el /T (tree)
# tomaba también este script PowerShell porque es child de
# control-center, lo que dejaba la app muerta sin relauch (gemini
# review v15.4.16, confirmado).
taskkill.exe /IM 'control-center.exe' /F 2>$null | Out-Null
# Fallback por si el binario fuera renombrado por el installer NSIS al
# productName del tauri.conf (ULTRON Control Center.exe).
taskkill.exe /IM 'ULTRON Control Center.exe' /F 2>$null | Out-Null
$deadline = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
    if (-not (Get-Process -Name 'control-center' -ErrorAction SilentlyContinue)) { break }
}
Start-Process -FilePath $exe
Write-Host '[ULTRON] Relaunched. This terminal closes in 3 s.' -ForegroundColor Green
Start-Sleep -Seconds 3
"#.to_string();
            let cc = ultron.join("control-center");
            if !cc.is_dir() {
                return Err(format!("control-center/ missing: {}", cc.display()));
            }
            (cc, cmd)
        }
        other => return Err(format!("unknown lifecycle kind: {}", other)),
    };

    // v15.3.6: stopped using wt.exe `new-tab` — when wt is already running
    // it routes new-tabs through the existing instance, which has been
    // observed to fire 3-4 child processes on first launch. Use plain
    // powershell.exe directly. The window is still visible to the user
    // (CREATE_NEW_CONSOLE on Windows), just without the wt.exe wrapper.
    //
    // v15.4.3: `-NoExit` only applies to `uninstall`. The new `update`
    // script handles its own lifetime (auto-close after relaunch, pause
    // on failure), so layering `-NoExit` on top would leave a dead
    // PowerShell window behind after the user's relaunch.
    let mut command = std::process::Command::new("powershell.exe");
    command
        .current_dir(&cwd)
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass");
    if kind == "uninstall" {
        command.arg("-NoExit");
    }
    command.arg("-Command").arg(&ps_script);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_CONSOLE = 0x00000010
        command.creation_flags(0x00000010);
    }

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
        MaintenanceCommand {
            kind: "agents-reembed".into(),
            label: "Agents re-embed".into(),
            description: "Re-vectorize ~/.claude/agents into Qdrant for semantic discovery.".into(),
            group: "skills".into(),
        },
        MaintenanceCommand {
            kind: "deadwood-scan".into(),
            label: "Deadwood scan".into(),
            description: "Detect orphaned scripts, stale skills, unreferenced data files.".into(),
            group: "system".into(),
        },
        MaintenanceCommand {
            kind: "doctor-fix".into(),
            label: "Doctor — auto-fix safe issues".into(),
            description: "Run doctor with --fix to apply only the changes marked safe.".into(),
            group: "system".into(),
        },
        MaintenanceCommand {
            kind: "audit-skills".into(),
            label: "Persona audit (skills + agents)".into(),
            description: "Aggregate usage / freshness stats per persona — output to ~/.ultron/cockpit/audits/.".into(),
            group: "skills".into(),
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
        "agents-reembed" => (
            "uv".into(),
            vec![
                "run".into(),
                "python".into(),
                cock.join("embed_agents.py").to_string_lossy().into_owned(),
            ],
        ),
        "deadwood-scan" => (
            "uv".into(),
            vec![
                "run".into(),
                "python".into(),
                cock.join("deadwood_scanner.py").to_string_lossy().into_owned(),
            ],
        ),
        "doctor-fix" => (
            "uv".into(),
            vec![
                "run".into(),
                "python".into(),
                cock.join("doctor.py").to_string_lossy().into_owned(),
                "--fix".into(),
                "--non-interactive".into(),
            ],
        ),
        "audit-skills" => (
            "uv".into(),
            vec![
                "run".into(),
                "python".into(),
                cock.join("persona_audit.py").to_string_lossy().into_owned(),
            ],
        ),
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
