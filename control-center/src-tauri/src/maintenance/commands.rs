// Maintenance command catalogue and dispatch table.
// `list_maintenance_commands_inner` returns the ordered list shown in the UI.
// `build_cmd` translates a `kind` token into the executable + args to run.

use std::path::{Path, PathBuf};

use serde::Serialize;

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

pub(super) fn cockpit(home: &Path) -> PathBuf {
    home.join(".ultron").join("scripts").join("cockpit")
}

#[cfg(target_os = "windows")]
pub(super) fn backup_script(home: &Path) -> PathBuf {
    home.join(".ultron")
        .join("scripts")
        .join("backup")
        .join("weekly-backup.ps1")
}

#[cfg(not(target_os = "windows"))]
pub(super) fn backup_script(home: &Path) -> PathBuf {
    home.join(".ultron")
        .join("scripts")
        .join("backup")
        .join("weekly-backup.sh")
}

pub(super) fn build_cmd(kind: &str, home: &Path) -> Result<(String, Vec<String>), String> {
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
        "pc-mdsched" => ("mdsched.exe".into(), vec![]),
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
        "pc-services-mmc" => ("services.msc".into(), vec![]),
        #[cfg(target_os = "windows")]
        "pc-event-viewer" => ("eventvwr.msc".into(), vec![]),
        #[cfg(target_os = "windows")]
        "pc-device-manager" => ("devmgmt.msc".into(), vec![]),
        #[cfg(target_os = "windows")]
        "pc-reset-firewall" => (
            "netsh".into(),
            vec!["advfirewall".into(), "reset".into()],
        ),
        #[cfg(target_os = "windows")]
        "pc-gpupdate" => ("gpupdate.exe".into(), vec!["/force".into()]),
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
