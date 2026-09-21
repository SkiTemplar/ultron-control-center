// commands/projects/terminal — abrir una consola EXTERNA en la raiz del
// proyecto. Sustituye al terminal embebido (pty) retirado: la card
// "Terminal" de ProjectWorkspace lanza la shell configurada en el proyecto
// (`Project.default_shell`: powershell | powershell-admin | cmd) como
// ventana nativa. Patron heredado de maintenance/lifecycle.rs v15.3.6:
// nada de `wt.exe new-tab` (raza de 3-4 procesos observada); powershell.exe
// directo con CREATE_NEW_CONSOLE.

use std::path::Path;

/// Script de elevacion. Es una CONSTANTE a proposito: la ruta del proyecto
/// llega por `ULTRON_TERM_DIR` y PowerShell la expande como valor, asi que no
/// hay nada que escapar y una ruta con comillas no puede inyectar codigo.
/// El test `admin_script_carries_no_path` guarda esta propiedad.
#[cfg_attr(not(windows), allow(dead_code))]
const ADMIN_SCRIPT: &str = "Start-Process powershell.exe -Verb RunAs \
     -WorkingDirectory $env:ULTRON_TERM_DIR -ArgumentList '-NoExit'";

/// Abre una consola externa en `path`. `shell` viene de
/// `Project.default_shell`; `None`/desconocido degrada a PowerShell normal.
#[tauri::command]
pub fn open_project_terminal(path: String, shell: Option<String>) -> Result<(), String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("project path is not a directory: {}", path));
    }

    let kind = shell.as_deref().unwrap_or("powershell");
    spawn_console(dir, kind)
}

#[cfg(target_os = "windows")]
fn spawn_console(dir: &Path, kind: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

    let mut command = match kind {
        "cmd" => {
            let mut c = std::process::Command::new("cmd.exe");
            c.arg("/K"); // keep the window open
            c
        }
        "powershell-admin" => {
            // Elevacion via Start-Process -Verb RunAs: el UAC prompt es el
            // punto de consentimiento; la ventana elevada abre en el dir
            // del proyecto y se queda abierta (-NoExit).
            //
            // La ruta viaja por VARIABLE DE ENTORNO, nunca interpolada en el
            // script (auditoria de seguridad 2026-09-21, HIGH). La version
            // anterior metia `dir` dentro de un `-Command` que a su vez
            // llevaba un `-ArgumentList '...'` anidado: una ruta con comilla
            // simple cerraba el literal y el resto se ejecutaba como codigo
            // PowerShell. Basta con registrar (o dejar que el auto-scan
            // registre) un proyecto en una carpeta llamada `it's-a-test`.
            //
            // Con la ruta en el entorno, el texto de -Command es constante y
            // no hay nada que escapar: PowerShell expande $env:... como valor,
            // no como sintaxis.
            let mut c = std::process::Command::new("powershell.exe");
            c.arg("-NoProfile")
                .arg("-Command")
                .arg(ADMIN_SCRIPT)
                .env("ULTRON_TERM_DIR", dir);
            c
        }
        // "powershell" y cualquier valor desconocido: PowerShell normal.
        _ => {
            let mut c = std::process::Command::new("powershell.exe");
            c.arg("-NoExit");
            c
        }
    };

    command
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {}", kind, e))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn spawn_console(dir: &Path, _kind: &str) -> Result<(), String> {
    // Linux/macOS: mejor esfuerzo con los emuladores mas comunes. La card
    // muestra el error si ninguno existe (mandamiento 11: nada de no-ops).
    for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
        if std::process::Command::new(term)
            .current_dir(dir)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    Err(
        "no terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xterm)"
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_directory() {
        let err = open_project_terminal("Z:\\definitely\\not\\a\\dir".into(), None)
            .expect_err("nonexistent path must be rejected");
        assert!(err.contains("not a directory"));
    }

    /// Regresion (auditoria 2026-09-21, HIGH): la ruta del proyecto se
    /// interpolaba dentro de un `-Command` con un `-ArgumentList '...'`
    /// anidado, asi que una carpeta llamada `it's-a-test` cerraba el literal
    /// y el resto corria como PowerShell. El script tiene que seguir siendo
    /// constante: la ruta va por entorno, no por texto.
    #[test]
    fn admin_script_carries_no_path() {
        assert!(
            ADMIN_SCRIPT.contains("$env:ULTRON_TERM_DIR"),
            "la ruta debe llegar por variable de entorno"
        );
        assert!(
            !ADMIN_SCRIPT.contains("Set-Location"),
            "Set-Location con la ruta embebida era justo el vector de inyeccion"
        );
        // Un formateador no puede volver a colar datos: sin marcadores de
        // sustitucion, el script no admite interpolacion.
        assert!(!ADMIN_SCRIPT.contains("{}"), "el script no admite formateo");
    }
}
