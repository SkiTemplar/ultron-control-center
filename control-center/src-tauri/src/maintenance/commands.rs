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
    /// La acción borra datos, reinicia algo del sistema o aplica cambios sin
    /// preguntar: la UI pide confirmación antes de lanzarla (Rust no tiene
    /// diálogos). La paleta Ctrl+K y Diagnostics lo respetan.
    pub destructive: bool,
}

/// Una entrada del catálogo; `destructive` decide si la UI confirma antes.
fn entry(
    kind: &str,
    label: &str,
    description: &str,
    group: &str,
    destructive: bool,
) -> MaintenanceCommand {
    MaintenanceCommand {
        kind: kind.into(),
        label: label.into(),
        description: description.into(),
        group: group.into(),
        destructive,
    }
}

/// The set the UI lists in the Dashboard and the Ctrl+K palette. Order matters
/// — preserved. Every script-backed kind must point to a script that exists
/// and only pass flags it defines (see the tests below).
pub fn list_maintenance_commands_inner() -> Vec<MaintenanceCommand> {
    vec![
        entry(
            "skill-security-audit",
            "Auditoría de seguridad de skills",
            "Pasa el detector de prompt injection por cada skill instalada (informe JSON).",
            "skills",
            false,
        ),
        entry(
            "registry-sync",
            "Sincronizar el registro",
            "Reconstruye el manifiesto de skills entre CLIs (espejos de Claude, Codex y Agents).",
            "skills",
            false,
        ),
        entry(
            "mcp-health",
            "Comprobar la salud de los MCP",
            "Sondea los servidores MCP configurados y guarda la última foto de su estado.",
            "system",
            false,
        ),
        entry(
            "weekly-backup",
            "Backup semanal",
            "Ejecuta el script del backup espejo semanal. Actualiza el estado del backup en Doctor.",
            "system",
            false,
        ),
        entry(
            "deadwood-scan",
            "Buscar código muerto",
            "Detecta scripts huérfanos, skills obsoletas y ficheros de datos sin referencias.",
            "system",
            false,
        ),
        entry(
            "doctor-fix",
            "Doctor: aplicar los arreglos propuestos",
            "Ejecuta doctor --fix --yes: aplica sin preguntar cada arreglo que propone (regenerar manifiestos, índices y contexto).",
            "system",
            true,
        ),
        // v2.5: PC-focused actions surfaced in the Dashboard "Fix common issues"
        // strip. Each maps to a known-good Windows command.
        entry(
            "pc-flush-dns",
            "Vaciar la caché DNS",
            "Ejecuta ipconfig /flushdns para borrar entradas DNS obsoletas.",
            "pc",
            false,
        ),
        entry(
            "pc-reset-network",
            "Restablecer el adaptador de red",
            "netsh int ip reset: devuelve la pila TCP/IP a sus valores por defecto. Necesita permisos de administrador y conviene reiniciar.",
            "pc",
            true,
        ),
        entry(
            "pc-disk-cleanup",
            "Liberar espacio en disco",
            "Lanza el Liberador de espacio en disco de Windows con la configuración por defecto.",
            "pc",
            false,
        ),
        entry(
            "pc-reliability-monitor",
            "Abrir el Monitor de confiabilidad",
            "Abre perfmon /rel: el registro diario de estabilidad del sistema.",
            "pc",
            false,
        ),
        entry(
            "pc-task-manager",
            "Abrir el Administrador de tareas",
            "Lanza taskmgr.exe.",
            "pc",
            false,
        ),
        entry(
            "pc-restart-explorer",
            "Reiniciar el Explorador",
            "Cierra explorer.exe y lo vuelve a lanzar; arregla fallos de la barra de tareas y del shell.",
            "pc",
            true,
        ),
        entry(
            "pc-clear-temp",
            "Borrar ficheros temporales",
            "Borra %TEMP%\\* (en lo posible: los ficheros bloqueados se saltan).",
            "pc",
            true,
        ),
        entry(
            "pc-windows-update",
            "Abrir la configuración de Windows Update",
            "Abre ms-settings:windowsupdate con la URI del shell.",
            "pc",
            false,
        ),
        entry(
            "pc-open-hosts",
            "Abrir el fichero hosts",
            "Abre %SystemRoot%\\System32\\drivers\\etc\\hosts en el Bloc de notas.",
            "pc",
            false,
        ),
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

/// Guardia de PowerShell para las acciones que solo funcionan elevadas: la app no
/// corre como administrador y sin esto dirían «hecho» sin haber hecho nada.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const REQUIRE_ADMIN_PS: &str = "if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { [Console]::Error.WriteLine('Hace falta abrir Control Center como administrador.'); exit 5 }";

/// Ejecutables que abren una ventana y siguen vivos hasta que se cierra.
const WINDOW_EXECUTABLES: &[&str] = &[
    "cleanmgr.exe",
    "perfmon.exe",
    "taskmgr.exe",
    "notepad.exe",
    "mdsched.exe",
    "msdt.exe",
    "rstrui.exe",
    "resmon.exe",
    "mmc.exe",
    "control.exe",
    "wsreset.exe",
];

/// La acción abre una ventana y el resultado no depende de que se cierre. Esperarla
/// dejaba Diagnostics bloqueado y el «hecho» llegaba al cerrar el Bloc de notas.
pub(super) fn opens_window(cmd: &str, args: &[String]) -> bool {
    WINDOW_EXECUTABLES.contains(&cmd)
        || (cmd == "cmd.exe" && args.get(1).is_some_and(|a| a == "start"))
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
                // Sin TTY, doctor rechaza --fix salvo con --yes explícito.
                "--yes".into(),
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
                // Sin elevación falla al principio; un borrado fallido da código
                // de salida distinto de cero y los servicios vuelven igualmente.
                format!(
                    "{REQUIRE_ADMIN_PS} $ErrorActionPreference = 'Stop'; try {{ Stop-Service -Name wuauserv -Force; Stop-Service -Name bits -Force; Remove-Item -Path \"$env:WINDIR\\SoftwareDistribution\" -Recurse -Force }} finally {{ Start-Service -Name bits -ErrorAction Continue; Start-Service -Name wuauserv -ErrorAction Continue }}"
                ),
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
        "pc-services-mmc" => ("mmc.exe".into(), vec!["services.msc".into()]),
        #[cfg(target_os = "windows")]
        "pc-event-viewer" => ("mmc.exe".into(), vec!["eventvwr.msc".into()]),
        #[cfg(target_os = "windows")]
        "pc-device-manager" => ("mmc.exe".into(), vec!["devmgmt.msc".into()]),
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
        "pc-sound-settings" => ("control.exe".into(), vec!["mmsys.cpl".into()]),
        // Open Network Connections (ncpa.cpl) — the classic adapter view.
        #[cfg(target_os = "windows")]
        "pc-network-connections" => ("control.exe".into(), vec!["ncpa.cpl".into()]),
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
        "pc-disk-management" => ("mmc.exe".into(), vec!["diskmgmt.msc".into()]),
        // Open Computer Management.
        #[cfg(target_os = "windows")]
        "pc-computer-management" => ("mmc.exe".into(), vec!["compmgmt.msc".into()]),
        // Open Task Scheduler.
        #[cfg(target_os = "windows")]
        "pc-task-scheduler" => ("mmc.exe".into(), vec!["taskschd.msc".into()]),
        // Open Programs and Features (appwiz.cpl).
        #[cfg(target_os = "windows")]
        "pc-programs-features" => ("control.exe".into(), vec!["appwiz.cpl".into()]),
        // Open Power Options (powercfg.cpl).
        #[cfg(target_os = "windows")]
        "pc-power-options" => ("control.exe".into(), vec!["powercfg.cpl".into()]),
        other => return Err(format!("unknown maintenance kind: {}", other)),
    })
}

#[cfg(test)]
mod tests {
    use super::{build_cmd, list_maintenance_commands_inner, opens_window};
    use std::path::{Path, PathBuf};

    /// Raíz del repo (este fichero vive en control-center/src-tauri/src/maintenance).
    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
    }

    /// Texto del script y de sus módulos hermanos `<stem>_*.py` (doctor.py
    /// define sus flags en doctor_core.py).
    fn script_sources(script: &Path) -> String {
        let stem = script
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        let dir = script.parent().expect("script dir");
        let mut text = std::fs::read_to_string(script).unwrap_or_default();
        for entry in std::fs::read_dir(dir).expect("read cockpit dir").flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{stem}_")) && name.ends_with(".py") {
                text.push_str(&std::fs::read_to_string(entry.path()).unwrap_or_default());
            }
        }
        text
    }

    /// Caso negativo de frontend-e2e-3 / docs-ci-2: `audit-skills` lanzaba un
    /// script borrado en mayo y `doctor-fix` un flag que doctor no define.
    /// Toda entrada de la lista que corre un script de cockpit debe apuntar a
    /// un fichero que existe y pasarle solo argumentos que el script declara.
    #[test]
    fn every_listed_script_exists_and_accepts_its_flags() {
        let fake_home = Path::new("/fake-home");
        let prefix = fake_home.join(".ultron");
        for c in list_maintenance_commands_inner() {
            let Ok((exe, args)) = build_cmd(&c.kind, fake_home) else {
                continue; // weekly-backup comprueba el fichero en disco del usuario
            };
            if exe != "uv" {
                continue;
            }
            let rel = Path::new(&args[2])
                .strip_prefix(&prefix)
                .expect("script bajo ~/.ultron")
                .to_path_buf();
            let script = repo_root().join(rel);
            assert!(
                script.is_file(),
                "{}: no existe {}",
                c.kind,
                script.display()
            );
            let sources = script_sources(&script);
            for arg in &args[3..] {
                assert!(
                    sources.contains(&format!("\"{arg}\"")),
                    "{}: {} no define {arg}",
                    c.kind,
                    script.display()
                );
            }
        }
    }

    /// CreateProcess no abre un .msc ni un .cpl: fallan con el error 193.
    #[cfg(windows)]
    #[test]
    fn ningun_kind_lanza_directamente_un_msc_o_un_cpl() {
        let home = Path::new("/fake-home");
        for c in list_maintenance_commands_inner() {
            let Ok((exe, _)) = build_cmd(&c.kind, home) else {
                continue;
            };
            assert!(
                !exe.ends_with(".msc") && !exe.ends_with(".cpl"),
                "{}: {exe}",
                c.kind
            );
        }
        let (exe, args) = build_cmd("pc-services-mmc", home).expect("kind");
        assert_eq!(
            (exe.as_str(), args[0].as_str()),
            ("mmc.exe", "services.msc")
        );
        let (exe, args) = build_cmd("pc-sound-settings", home).expect("kind");
        assert_eq!(
            (exe.as_str(), args[0].as_str()),
            ("control.exe", "mmsys.cpl")
        );
    }

    #[cfg(windows)]
    #[test]
    fn las_ventanas_no_se_esperan_y_lo_demas_si() {
        let home = Path::new("/fake-home");
        let abre = |kind: &str| {
            let (exe, args) = build_cmd(kind, home).expect("kind");
            opens_window(&exe, &args)
        };
        for kind in [
            "pc-open-hosts",
            "pc-windows-update",
            "pc-sfc",
            "pc-services-mmc",
            "pc-task-manager",
        ] {
            assert!(abre(kind), "{kind} abre una ventana");
        }
        for kind in [
            "pc-flush-dns",
            "pc-clear-temp",
            "pc-repair-wu",
            "pc-restart-explorer",
        ] {
            assert!(!abre(kind), "{kind} tiene un resultado que esperar");
        }
    }

    /// Solo se ejecuta la guardia, nunca el comando entero: borra SoftwareDistribution.
    #[cfg(windows)]
    #[test]
    fn la_guardia_de_elevacion_coincide_con_el_token_del_proceso() {
        let run = |script: &str| {
            std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .output()
                .expect("powershell")
        };
        let es_admin = String::from_utf8_lossy(
            &run("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)").stdout,
        )
        .trim()
        .eq_ignore_ascii_case("true");
        let out = run(super::REQUIRE_ADMIN_PS);
        assert_eq!(out.status.code(), Some(if es_admin { 0 } else { 5 }));
    }

    #[test]
    fn audit_skills_is_gone_from_list_and_dispatch() {
        assert!(list_maintenance_commands_inner()
            .iter()
            .all(|c| c.kind != "audit-skills"));
        assert!(build_cmd("audit-skills", Path::new("/fake-home")).is_err());
    }

    /// Las acciones que borran, reinician o aplican cambios sin preguntar van
    /// marcadas para que la UI confirme; abrir una ventana no.
    #[test]
    fn destructive_flag_marks_the_actions_that_need_confirmation() {
        let list = list_maintenance_commands_inner();
        let flag = |kind: &str| {
            list.iter()
                .find(|c| c.kind == kind)
                .map(|c| c.destructive)
                .unwrap_or_else(|| panic!("{kind} no está en la lista"))
        };
        for kind in [
            "pc-clear-temp",
            "pc-restart-explorer",
            "pc-reset-network",
            "doctor-fix",
        ] {
            assert!(flag(kind), "{kind} debe pedir confirmación");
        }
        for kind in ["pc-flush-dns", "pc-task-manager", "mcp-health"] {
            assert!(!flag(kind), "{kind} no necesita confirmación");
        }
    }
}
