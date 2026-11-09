// Mascota — ¿qué fichero hay bajo el cursor? (Ctrl+Alt+clic sobre un
// fichero del Explorador o del escritorio: Pupus va hasta él y lo coge).
//
// UI Automation da el NOMBRE del elemento bajo el punto; la ruta sale de la
// carpeta que muestra esa ventana del Explorador (Shell.Application) o del
// escritorio. Se hace con un PowerShell corto en vez de COM desde Rust:
// tarda ~1 s, pero Pupus está volando mientras tanto.

use std::path::PathBuf;
use std::time::Duration;

/// PowerShell 5.1, solo ASCII (el parser rompe con otros caracteres).
/// __X__ y __Y__ se sustituyen por enteros: no hay entrada de texto libre.
const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Namespace U -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v);'
[void][U.Dpi]::SetProcessDpiAwarenessContext([IntPtr]-4)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$auto = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$item = $auto::FromPoint((New-Object System.Windows.Point(__X__, __Y__)))
while ($item -and $item.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem) { $item = $walker.GetParent($item) }
if (-not $item) { exit 0 }
$name = $item.Current.Name
$top = $item
while ($true) { $p = $walker.GetParent($top); if (-not $p -or $p -eq $auto::RootElement) { break }; $top = $p }
$hwnd = $top.Current.NativeWindowHandle
$shell = New-Object -ComObject Shell.Application
$folders = @()
foreach ($w in $shell.Windows()) { try { if ($w.HWND -eq $hwnd) { $folders += $w.Document.Folder } } catch {} }
if ($folders.Count -eq 0) { $folders = @($shell.Namespace(0)) }
foreach ($f in $folders) { foreach ($it in $f.Items()) { if ($it.Name -eq $name -and -not $it.IsFolder) { [Console]::Out.Write($it.Path); exit 0 } } }
"#;

fn script_for(x: i32, y: i32) -> String {
    SCRIPT
        .replace("__X__", &x.to_string())
        .replace("__Y__", &y.to_string())
}

/// Ruta del fichero bajo (x, y) en píxeles físicos, o None si ahí no hay un
/// fichero (carpetas, ventanas que no son del Explorador, el vacío…).
fn file_at(x: i32, y: i32) -> Result<Option<PathBuf>, String> {
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", "-"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // sin consola
    }
    let out = crate::ai_router::exec::run_with_timeout(
        cmd,
        Duration::from_secs(10),
        Some(&script_for(x, y)),
    )
    .map_err(|e| format!("powershell: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("no se pudo leer el Explorador: {}", err.trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Ok(None);
    }
    let p = PathBuf::from(text);
    Ok(p.is_file().then_some(p))
}

#[tauri::command]
pub async fn mascot_file_at(x: i32, y: i32) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || file_at(x, y))
        .await
        .map_err(|e| format!("tarea interrumpida: {e}"))?
        .map(|p| p.map(|p| p.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_script_solo_lleva_las_coordenadas_y_es_ascii() {
        let s = script_for(-2560, 437);
        assert!(s.contains("System.Windows.Point(-2560, 437)"));
        assert!(!s.contains("__X__") && !s.contains("__Y__"));
        assert!(s.is_ascii(), "PowerShell 5.1 rompe con caracteres no ASCII");
    }
}
