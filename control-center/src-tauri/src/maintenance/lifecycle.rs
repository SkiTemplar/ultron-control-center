// App lifecycle commands: uninstall and in-place update + relaunch.
// These are Windows-only PowerShell scripts spawned in a new terminal
// window (fire-and-forget). Non-Windows returns an error stub.

#[cfg(target_os = "windows")]
use std::path::PathBuf;

/// Script de la terminal de Rebuild. No cierra ULTRON ni espera a que salga:
/// `npm run build:local` llama a `scripts/release-locked-exe.mjs`, que aparta
/// el control-center.exe en uso a `*.old-<ts>.exe` (Windows deja renombrar un
/// binario en ejecución), así que la app abierta sigue con el binario anterior
/// y el nuevo entra al reiniciarla. Si el renombrado falla, ese script cae al
/// cierre forzoso y lo dice. Al terminar, la terminal relanza ULTRON solo si
/// ya no está abierto; si sigue abierto, dice que hay que reiniciarlo.
///
/// `$LASTEXITCODE` tras cada paso decide si seguir; ante un fallo la ventana
/// queda abierta (`Read-Host`) para leer el error.
const UPDATE_SCRIPT: &str = r#"
$ErrorActionPreference = 'Continue'
$exe = Join-Path (Get-Location) 'src-tauri\target\release\control-center.exe'
$names = @('control-center', 'ULTRON Control Center')

# Si el build tuvo que cerrar ULTRON (fallback de release-locked-exe) y luego
# falla, se reabre el binario anterior si sigue en su sitio.
function Stop-Rebuild([string]$msg, [int]$code) {
    Write-Host ''
    Write-Host ('[ULTRON] ' + $msg) -ForegroundColor Red
    Read-Host 'Press Enter to close this terminal'
    if ((Test-Path -LiteralPath $exe) -and -not (Get-Process -Name $names -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $exe
    }
    exit $code
}

Write-Host '[ULTRON] git pull --ff-only...' -ForegroundColor Cyan
git pull --ff-only
if ($LASTEXITCODE -ne 0) {
    Write-Host ('[ULTRON] git pull failed (exit ' + $LASTEXITCODE + '): offline, no upstream or the branch diverged.') -ForegroundColor Yellow
    $answer = Read-Host 'Build the local sources anyway? (y/N)'
    if ($answer -notmatch '^(y|yes|s|si)$') { Stop-Rebuild 'Rebuild cancelled. Nothing was built.' 1 }
}

Write-Host '[ULTRON] npm install...' -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { Stop-Rebuild ('npm install failed (exit ' + $LASTEXITCODE + '). Nothing was built.') $LASTEXITCODE }

# build:local (no `tauri build`): incluye Finance si existen sus fuentes locales
# y aparta el .exe en uso sin cerrar ULTRON.
Write-Host '[ULTRON] npm run build:local (ULTRON stays open; the running binary is set aside)...' -ForegroundColor Cyan
npm run build:local
$buildExit = $LASTEXITCODE
if ($buildExit -ne 0) { Stop-Rebuild ('Build FAILED (exit ' + $buildExit + '). Read the error above.') $buildExit }
if (-not (Test-Path -LiteralPath $exe)) { Stop-Rebuild ('Build succeeded but the binary is missing at ' + $exe) 1 }

Write-Host ''
if (Get-Process -Name $names -ErrorAction SilentlyContinue) {
    Write-Host '[ULTRON] Build OK. ULTRON is still running the previous binary: restart the app to use the new one.' -ForegroundColor Green
    Read-Host 'Press Enter to close this terminal'
    exit 0
}
Write-Host '[ULTRON] Build OK. ULTRON is not running: launching the new binary...' -ForegroundColor Green
Start-Process -FilePath $exe
Write-Host '[ULTRON] Launched. This terminal closes in 3 s.' -ForegroundColor Green
Start-Sleep -Seconds 3
"#;

/// Spawn a new PowerShell window running either the uninstaller or the
/// Rebuild script above (`npm run build:local`, Finance-aware). The Control
/// Center keeps running; the frontend asks the user to confirm first
/// (`rebuildFlow.startRebuild`). Fire-and-forget — we do not wait for
/// completion.
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
            let cc = ultron.join("control-center");
            if !cc.is_dir() {
                return Err(format!("control-center/ missing: {}", cc.display()));
            }
            (cc, UPDATE_SCRIPT.to_string())
        }
        other => return Err(format!("unknown lifecycle kind: {}", other)),
    };

    // v15.3.6: stopped using wt.exe `new-tab` — when wt is already running
    // it routes new-tabs through the existing instance, which has been
    // observed to fire 3-4 child processes on first launch. Use plain
    // powershell.exe directly. The window is still visible to the user
    // (CREATE_NEW_CONSOLE on Windows), just without the wt.exe wrapper.
    //
    // v15.4.3: `-NoExit` only applies to `uninstall`. The `update` script
    // handles its own lifetime (auto-close after relaunch, pause on
    // failure), so layering `-NoExit` on top would leave a dead PowerShell
    // window behind after the relaunch.
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
/// in-place `tauri build` + relaunch flow) are PowerShell + Windows-only.
/// There's no equivalent shipped today; the Linux build uses the OS
/// package manager for install/uninstall instead.
#[cfg(not(target_os = "windows"))]
pub fn run_app_lifecycle_inner(_kind: String) -> Result<(), String> {
    let _ = UPDATE_SCRIPT;
    Err("app lifecycle commands are Windows-only".to_string())
}

#[cfg(test)]
mod tests {
    use super::UPDATE_SCRIPT;

    #[test]
    fn update_script_never_kills_the_app() {
        // Caso negativo del hallazgo: el script anterior hacía taskkill /F.
        let lower = UPDATE_SCRIPT.to_lowercase();
        assert!(
            !lower.contains("taskkill"),
            "el Rebuild no debe matar ULTRON"
        );
        assert!(
            !lower.contains("stop-process"),
            "el Rebuild no debe matar ULTRON"
        );
    }

    #[test]
    fn update_script_checks_every_step_before_building() {
        let pull = UPDATE_SCRIPT
            .find("git pull --ff-only\n")
            .expect("git pull");
        let install = UPDATE_SCRIPT.find("npm install\n").expect("npm install");
        let build = UPDATE_SCRIPT.find("npm run build:local\n").expect("build");
        assert!(pull < install && install < build);
        // Cada paso externo va seguido de su comprobación de salida.
        for (step, at) in [
            ("git pull", pull),
            ("npm install", install),
            ("build", build),
        ] {
            let tail = &UPDATE_SCRIPT[at..];
            let next_line = tail.lines().nth(1).unwrap_or_default();
            assert!(
                next_line.contains("$LASTEXITCODE"),
                "{step} sin comprobar $LASTEXITCODE: {next_line}"
            );
        }
    }

    /// Caso negativo de frontend-e2e-4: la terminal decía que se había pedido
    /// la salida de ULTRON y esperaba 10 minutos a que se cerrara. Con el .exe
    /// apartado por release-locked-exe no hay que esperar, y lo que dice al
    /// terminar es que el binario nuevo entra al reiniciar.
    #[test]
    fn update_script_does_not_wait_for_the_app_and_says_when_the_binary_applies() {
        assert!(!UPDATE_SCRIPT.contains("asked to exit"));
        assert!(!UPDATE_SCRIPT.contains("Waiting for ULTRON to close"));
        assert!(!UPDATE_SCRIPT.contains("while (Get-Process"));
        assert!(UPDATE_SCRIPT.contains("restart the app to use the new one"));
    }

    #[test]
    fn update_script_is_ascii() {
        // PowerShell 5.1 y la consola OEM rompen con caracteres no ASCII.
        assert!(UPDATE_SCRIPT.is_ascii());
    }
}
