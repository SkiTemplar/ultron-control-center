// commands/projects/terminal — abrir una consola EXTERNA en la raiz del
// proyecto. Sustituye al terminal embebido (pty) retirado: la card
// "Terminal" de ProjectWorkspace lanza la shell configurada en el proyecto
// (`Project.default_shell`: powershell | powershell-admin | cmd) como
// ventana nativa. Patron heredado de maintenance/lifecycle.rs v15.3.6:
// nada de `wt.exe new-tab` (raza de 3-4 procesos observada); powershell.exe
// directo con CREATE_NEW_CONSOLE.

use std::path::Path;

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
            let mut c = std::process::Command::new("powershell.exe");
            c.arg("-NoProfile").arg("-Command").arg(format!(
                "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoExit','-Command','Set-Location -LiteralPath \"{}\"'",
                dir.display()
            ));
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
}
