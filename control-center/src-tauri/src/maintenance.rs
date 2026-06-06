// ULTRON Control Center — one-shot maintenance commands surfaced as
// buttons in the Dashboard. Each kind in the whitelist below maps to a
// specific cockpit script with hardcoded args. Frontend never injects
// raw arguments — it only passes the `kind` string.
//
// We invoke via std::process::Command (not the Tauri shell plugin) so
// the capability ACL is irrelevant. CREATE_NO_WINDOW keeps console
// flashes off the user's screen.

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

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

/// Spawn wt.exe in a new window running either the uninstaller or
/// `npm run tauri build`. The Control Center keeps running; the spawned
/// terminal shows progress / asks for confirmation. Fire-and-forget —
/// we do not wait for completion.
#[cfg(target_os = "windows")]
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

/// Linux/macOS stub — the lifecycle scripts (`uninstall.ps1`, the
/// in-place `tauri build` + relaunch flow) are PowerShell + Windows-only
/// taskkill calls. There's no equivalent shipped today; the Linux build
/// uses the OS package manager for install/uninstall instead.
#[cfg(not(target_os = "windows"))]
pub fn run_app_lifecycle_inner(_kind: String) -> Result<(), String> {
    Err("app lifecycle commands are Windows-only".to_string())
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
        // v2.5: PC-focused actions surfaced in the Dashboard "Fix common issues"
        // strip. Each maps to a known-good Windows command. Destructive ones
        // (restart explorer, clear temp) MUST be confirmed by the UI before
        // dispatch — the Rust side has no dialog facility.
        MaintenanceCommand {
            kind: "pc-flush-dns".into(),
            label: "Flush DNS cache".into(),
            description: "Run ipconfig /flushdns to clear stale DNS entries.".into(),
            group: "pc".into(),
        },
        MaintenanceCommand {
            kind: "pc-reset-network".into(),
            label: "Reset network adapter".into(),
            description: "netsh int ip reset — restores TCP/IP stack to default. Reboot recommended.".into(),
            group: "pc".into(),
        },
        MaintenanceCommand {
            kind: "pc-disk-cleanup".into(),
            label: "Disk cleanup".into(),
            description: "Launches Windows Disk Cleanup with the default preset.".into(),
            group: "pc".into(),
        },
        MaintenanceCommand {
            kind: "pc-reliability-monitor".into(),
            label: "Open Reliability Monitor".into(),
            description: "Reveals perfmon /rel — the per-day system stability log.".into(),
            group: "pc".into(),
        },
        MaintenanceCommand {
            kind: "pc-task-manager".into(),
            label: "Open Task Manager".into(),
            description: "Launches taskmgr.exe.".into(),
            group: "pc".into(),
        },
        MaintenanceCommand {
            kind: "pc-restart-explorer".into(),
            label: "Restart Explorer".into(),
            description: "Kills explorer.exe and relaunches it — fixes taskbar / shell glitches.".into(),
            group: "pc".into(),
        },
        MaintenanceCommand {
            kind: "pc-clear-temp".into(),
            label: "Clear temp files".into(),
            description: "Deletes %TEMP%\\* (best effort — locked files are skipped).".into(),
            group: "pc".into(),
        },
        MaintenanceCommand {
            kind: "pc-windows-update".into(),
            label: "Open Windows Update settings".into(),
            description: "Opens ms-settings:windowsupdate via shell URI.".into(),
            group: "pc".into(),
        },
        MaintenanceCommand {
            kind: "pc-open-hosts".into(),
            label: "Open hosts file".into(),
            description: "Opens %SystemRoot%\\System32\\drivers\\etc\\hosts in notepad.".into(),
            group: "pc".into(),
        },
    ]
}

fn cockpit(home: &Path) -> PathBuf {
    home.join(".ultron").join("scripts").join("cockpit")
}

#[cfg(target_os = "windows")]
fn backup_script(home: &Path) -> PathBuf {
    home.join(".ultron")
        .join("scripts")
        .join("backup")
        .join("weekly-backup.ps1")
}

#[cfg(not(target_os = "windows"))]
fn backup_script(home: &Path) -> PathBuf {
    home.join(".ultron")
        .join("scripts")
        .join("backup")
        .join("weekly-backup.sh")
}

fn build_cmd(kind: &str, home: &Path) -> Result<(String, Vec<String>), String> {
    let cock = cockpit(home);
    Ok(match kind {
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
            #[cfg(target_os = "windows")]
            {
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
            #[cfg(not(target_os = "windows"))]
            {
                ("bash".into(), vec![script.to_string_lossy().into_owned()])
            }
        }
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
        // v2.5: PC-focused quick actions. All command strings are hardcoded
        // here — the frontend only passes the `kind` token. On non-Windows
        // hosts they fall through to the unknown-kind error since none of
        // these have *nix equivalents.
        #[cfg(target_os = "windows")]
        "pc-flush-dns" => ("ipconfig".into(), vec!["/flushdns".into()]),
        #[cfg(target_os = "windows")]
        "pc-reset-network" => (
            "netsh".into(),
            vec!["int".into(), "ip".into(), "reset".into()],
        ),
        #[cfg(target_os = "windows")]
        "pc-disk-cleanup" => ("cleanmgr.exe".into(), vec![]),
        #[cfg(target_os = "windows")]
        "pc-reliability-monitor" => ("perfmon.exe".into(), vec!["/rel".into()]),
        #[cfg(target_os = "windows")]
        "pc-task-manager" => ("taskmgr.exe".into(), vec![]),
        #[cfg(target_os = "windows")]
        "pc-restart-explorer" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "taskkill.exe /IM explorer.exe /F | Out-Null; Start-Sleep -Milliseconds 400; Start-Process explorer.exe".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-clear-temp" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                // Best-effort — locked files raise non-terminating errors which
                // we silence so the command always returns 0 on no-fatal cases.
                "Get-ChildItem -Path $env:TEMP -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-windows-update" => (
            "cmd.exe".into(),
            vec![
                "/c".into(),
                "start".into(),
                "".into(),
                "ms-settings:windowsupdate".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-open-hosts" => (
            "notepad.exe".into(),
            vec!["C:\\Windows\\System32\\drivers\\etc\\hosts".into()],
        ),
        // v2.7 expanded fixes: catalogued solutions consumed by the merged
        // Diagnostics tab. Each entry is a one-line Windows shell snippet
        // routed through powershell.exe / netsh / sc / etc. We never inline
        // user data into these commands so injection is structurally
        // impossible.
        #[cfg(target_os = "windows")]
        "pc-renew-ip" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "ipconfig /release; ipconfig /renew".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-winsock-reset" => (
            "netsh".into(),
            vec!["winsock".into(), "reset".into()],
        ),
        #[cfg(target_os = "windows")]
        "pc-restart-spooler" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Restart-Service -Name Spooler -Force".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-restart-audio" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Restart-Service -Name Audiosrv -Force; Restart-Service -Name AudioEndpointBuilder -Force".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-restart-wsearch" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Restart-Service -Name WSearch -Force".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-restart-bits" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Restart-Service -Name BITS -Force".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-restart-wuauserv" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Restart-Service -Name wuauserv -Force".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-repair-wu" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                // SoftwareDistribution wipe is the canonical "fix WU" recipe.
                "Stop-Service -Name wuauserv -Force; Stop-Service -Name bits -Force; Remove-Item -Path \"$env:WINDIR\\SoftwareDistribution\" -Recurse -Force -ErrorAction SilentlyContinue; Start-Service -Name bits; Start-Service -Name wuauserv".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-sfc" => (
            "cmd.exe".into(),
            vec![
                "/c".into(),
                "start".into(),
                "".into(),
                "powershell.exe".into(),
                "-NoExit".into(),
                "-Command".into(),
                "sfc /scannow".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-dism" => (
            "cmd.exe".into(),
            vec![
                "/c".into(),
                "start".into(),
                "".into(),
                "powershell.exe".into(),
                "-NoExit".into(),
                "-Command".into(),
                "DISM /Online /Cleanup-Image /RestoreHealth".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-chkdsk" => (
            "cmd.exe".into(),
            vec![
                "/c".into(),
                "start".into(),
                "".into(),
                "powershell.exe".into(),
                "-NoExit".into(),
                "-Command".into(),
                "chkdsk C: /scan".into(),
            ],
        ),
        #[cfg(target_os = "windows")]
        "pc-mdsched" => (
            "mdsched.exe".into(),
            vec![],
        ),
        #[cfg(target_os = "windows")]
        "pc-power-troubleshooter" => (
            "msdt.exe".into(),
            vec!["/id".into(), "PowerDiagnostic".into()],
        ),
        #[cfg(target_os = "windows")]
        "pc-network-troubleshooter" => (
            "msdt.exe".into(),
            vec!["/id".into(), "NetworkDiagnosticsNetworkAdapter".into()],
        ),
        #[cfg(target_os = "windows")]
        "pc-services-mmc" => (
            "services.msc".into(),
            vec![],
        ),
        #[cfg(target_os = "windows")]
        "pc-event-viewer" => (
            "eventvwr.msc".into(),
            vec![],
        ),
        #[cfg(target_os = "windows")]
        "pc-device-manager" => (
            "devmgmt.msc".into(),
            vec![],
        ),
        #[cfg(target_os = "windows")]
        "pc-reset-firewall" => (
            "netsh".into(),
            vec!["advfirewall".into(), "reset".into()],
        ),
        #[cfg(target_os = "windows")]
        "pc-gpupdate" => (
            "gpupdate.exe".into(),
            vec!["/force".into()],
        ),
        #[cfg(target_os = "windows")]
        "pc-restart-explorer-soft" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Stop-Process -Name explorer -Force; Start-Sleep -Milliseconds 400; Start-Process explorer.exe".into(),
            ],
        ),
        // ---- v2.7.1 additional fixes ----
        // Reset Windows Update components — broader than `pc-repair-wu`, also
        // re-registers cryptsvc + catroot2.
        #[cfg(target_os = "windows")]
        "pc-reset-wu-components" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Stop-Service -Name wuauserv,bits,cryptsvc,msiserver -Force -ErrorAction SilentlyContinue; Remove-Item -Path \"$env:WINDIR\\SoftwareDistribution\" -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -Path \"$env:WINDIR\\System32\\catroot2\" -Recurse -Force -ErrorAction SilentlyContinue; Start-Service -Name cryptsvc,bits,msiserver,wuauserv -ErrorAction SilentlyContinue".into(),
            ],
        ),
        // Reset Microsoft Store cache (wsreset.exe).
        #[cfg(target_os = "windows")]
        "pc-wsreset" => ("wsreset.exe".into(), vec![]),
        // Restart Bluetooth Support service.
        #[cfg(target_os = "windows")]
        "pc-restart-bluetooth" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Restart-Service -Name bthserv -Force".into(),
            ],
        ),
        // Flush the ARP cache.
        #[cfg(target_os = "windows")]
        "pc-flush-arp" => (
            "netsh".into(),
            vec!["interface".into(), "ip".into(), "delete".into(), "arpcache".into()],
        ),
        // Release + renew DHCP + flush DNS + reset Winsock + TCP/IP in one go.
        // The "kitchen sink" reset.
        #[cfg(target_os = "windows")]
        "pc-net-reset-all" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "ipconfig /release; ipconfig /flushdns; ipconfig /renew; netsh winsock reset; netsh int ip reset".into(),
            ],
        ),
        // Re-register all Microsoft Store apps (fixes Start menu / UWP corruption).
        #[cfg(target_os = "windows")]
        "pc-reregister-store-apps" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Get-AppxPackage -AllUsers | Foreach { Add-AppxPackage -DisableDevelopmentMode -Register \"$($_.InstallLocation)\\AppXManifest.xml\" -ErrorAction SilentlyContinue }".into(),
            ],
        ),
        // Restart Windows Time service (fixes time-skew / Kerberos issues).
        #[cfg(target_os = "windows")]
        "pc-restart-time" => (
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Restart-Service -Name w32time -Force; w32tm /resync".into(),
            ],
        ),
        // Open Windows Security (Defender) settings.
        #[cfg(target_os = "windows")]
        "pc-windows-security" => (
            "cmd.exe".into(),
            vec!["/c".into(), "start".into(), "".into(), "windowsdefender:".into()],
        ),
        // Open Sound settings (mmsys.cpl).
        #[cfg(target_os = "windows")]
        "pc-sound-settings" => ("mmsys.cpl".into(), vec![]),
        // Open Network Connections (ncpa.cpl) — the classic adapter view.
        #[cfg(target_os = "windows")]
        "pc-network-connections" => ("ncpa.cpl".into(), vec![]),
        // Run the Audio troubleshooter.
        #[cfg(target_os = "windows")]
        "pc-audio-troubleshooter" => (
            "msdt.exe".into(),
            vec!["/id".into(), "AudioPlaybackDiagnostic".into()],
        ),
        // Run the Bluetooth troubleshooter.
        #[cfg(target_os = "windows")]
        "pc-bluetooth-troubleshooter" => (
            "msdt.exe".into(),
            vec!["/id".into(), "BluetoothDiagnostic".into()],
        ),
        // Run the Search & Indexing troubleshooter.
        #[cfg(target_os = "windows")]
        "pc-search-troubleshooter" => (
            "msdt.exe".into(),
            vec!["/id".into(), "SearchDiagnostic".into()],
        ),
        // Run the Windows Update troubleshooter.
        #[cfg(target_os = "windows")]
        "pc-wu-troubleshooter" => (
            "msdt.exe".into(),
            vec!["/id".into(), "WindowsUpdateDiagnostic".into()],
        ),
        // Open recovery options (advanced startup, system restore).
        #[cfg(target_os = "windows")]
        "pc-recovery" => (
            "cmd.exe".into(),
            vec!["/c".into(), "start".into(), "".into(), "ms-settings:recovery".into()],
        ),
        // Open System Restore (rstrui).
        #[cfg(target_os = "windows")]
        "pc-system-restore" => ("rstrui.exe".into(), vec![]),
        // Open Resource Monitor (resmon).
        #[cfg(target_os = "windows")]
        "pc-resource-monitor" => ("resmon.exe".into(), vec![]),
        // Open Performance Monitor (perfmon).
        #[cfg(target_os = "windows")]
        "pc-perfmon" => ("perfmon.exe".into(), vec![]),
        // Open Disk Management (diskmgmt.msc).
        #[cfg(target_os = "windows")]
        "pc-disk-management" => ("diskmgmt.msc".into(), vec![]),
        // Open Computer Management.
        #[cfg(target_os = "windows")]
        "pc-computer-management" => ("compmgmt.msc".into(), vec![]),
        // Open Task Scheduler.
        #[cfg(target_os = "windows")]
        "pc-task-scheduler" => ("taskschd.msc".into(), vec![]),
        // Open Programs and Features (appwiz.cpl).
        #[cfg(target_os = "windows")]
        "pc-programs-features" => ("appwiz.cpl".into(), vec![]),
        // Open Power Options (powercfg.cpl).
        #[cfg(target_os = "windows")]
        "pc-power-options" => ("powercfg.cpl".into(), vec![]),
        other => return Err(format!("unknown maintenance kind: {}", other)),
    })
}

/// v2.5: dedicated "run backup now" entry point. Re-uses the same script the
/// Task Scheduler job runs (~/.ultron/scripts/backup/weekly-backup.ps1). We
/// surface this as its own command so the Dashboard BackupCard can call it
/// without piggy-backing on the generic `weekly-backup` maintenance kind —
/// the latter goes through the audit/timeline path and isn't intended for
/// the "I just want to restart the backup" use case.
///
/// v2.7 fix: previously this just spawned the script with the inherited
/// env. The Tauri command `set_backup_root` mirrors the chosen path into
/// `std::env::set_var("ULTRON_BACKUP_ROOT", …)`, but that only sticks for
/// the lifetime of the running Control Center process. If the user
/// restarts the app and then presses "Force backup now" without
/// re-picking the destination, the script wouldn't see any override and
/// would silently fall back to `%USERPROFILE%\BACKUP`, leaving the
/// configured drive empty and the "last backup" badge stuck on the old C:
/// mirror.
///
/// The script itself now reads `~/.ultron/.tmp/backup-root.txt` (matching
/// `backup_status.rs::backup_root()`), and we additionally inject both
/// `ULTRON_BACKUP_ROOT` + `ULTRON_BACKUP_SOURCES` here so the child
/// PowerShell never has to depend on inherited in-process state.
pub fn run_backup_now_inner() -> Result<MaintenanceResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let script = backup_script(&home);
    if !script.is_file() {
        return Err(format!("backup script missing: {}", script.display()));
    }
    let start = std::time::Instant::now();
    #[cfg(target_os = "windows")]
    let (cmd, args): (String, Vec<String>) = (
        "powershell.exe".into(),
        vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            script.to_string_lossy().into_owned(),
        ],
    );
    #[cfg(not(target_os = "windows"))]
    let (cmd, args): (String, Vec<String>) =
        ("bash".into(), vec![script.to_string_lossy().into_owned()]);
    let mut command = Command::new(&cmd);
    command.args(&args).current_dir(home.join(".ultron"));

    // v2.7: explicitly inject the configured destination + sources into
    // the child process. We re-read from disk every invocation so a fresh
    // Control Center process (where `std::env::set_var` from a previous
    // session is gone) still sees the user's preferences.
    let root_cfg = home.join(".ultron").join(".tmp").join("backup-root.txt");
    if let Ok(raw) = std::fs::read_to_string(&root_cfg) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            command.env("ULTRON_BACKUP_ROOT", trimmed);
        }
    }
    let sources_cfg = home
        .join(".ultron")
        .join("cockpit")
        .join("backup-config.json");
    if let Ok(raw) = std::fs::read_to_string(&sources_cfg) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(arr) = val.get("sources").and_then(|v| v.as_array()) {
                let joined: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
                if !joined.is_empty() {
                    command.env("ULTRON_BACKUP_SOURCES", joined.join(","));
                }
            }
        }
    }

    #[cfg(windows)]
    {
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = command
        .output()
        .map_err(|e| format!("spawn {}: {}", cmd, e))?;
    Ok(MaintenanceResult {
        kind: "run-backup-now".into(),
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        elapsed_ms: start.elapsed().as_millis(),
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
