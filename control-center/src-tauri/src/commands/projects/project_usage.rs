// Wrapper Tauri del CLI `~/.ultron/scripts/project-usage.mjs` (tarjeta "Uso" de
// ProjectWorkspace). El script agrega los transcripts de Claude Code del proyecto
// (coste nocional, modelos, sesion principal frente a subagentes) y habla `--json`
// puro por stdout; este comando solo valida los argumentos, lo lanza y traduce el
// resultado.
//
// Es `async` con `spawn_blocking`: la primera lectura de un proyecto con cientos
// de MB de transcripts tarda unos segundos (despues hay cache por fichero) y un
// comando sincrono bloquearia la interfaz.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::ai_router::exec::run_with_timeout;

const TIMEOUT: Duration = Duration::from_secs(120);

/// El script emite un unico objeto JSON pequeno (una fila por dia); algo mayor
/// indica salida inesperada y no se parsea.
const MAX_STDOUT_BYTES: usize = 1024 * 1024;

/// Ventana por defecto y maxima, iguales a las que valida el script.
const DEFAULT_DAYS: u32 = 30;
const MAX_DAYS: u32 = 366;

/// El id acaba como argumento de un proceso hijo: solo `[A-Za-z0-9_-]`, sin
/// guion inicial (se leeria como flag) y con tope de longitud.
fn valid_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn parse_cli_stdout(stdout: &[u8]) -> Result<serde_json::Value, String> {
    if stdout.len() > MAX_STDOUT_BYTES {
        return Err(format!(
            "salida de {} bytes, por encima del tope de {MAX_STDOUT_BYTES}",
            stdout.len()
        ));
    }
    let text = String::from_utf8_lossy(stdout);
    serde_json::from_str::<serde_json::Value>(text.trim()).map_err(|e| e.to_string())
}

fn script_path() -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "no se pudo resolver el directorio HOME".to_string())?;
    Ok(home
        .join(".ultron")
        .join("scripts")
        .join("project-usage.mjs"))
}

fn run_script(project_id: &str, days: u32) -> Result<serde_json::Value, String> {
    let script = script_path()?;
    if !script.is_file() {
        return Err(format!(
            "no se encontro el script project-usage.mjs en {}",
            script.display()
        ));
    }
    let mut cmd = Command::new("node");
    cmd.arg(&script)
        .arg(project_id)
        .arg("--days")
        .arg(days.to_string())
        .arg("--json");
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output =
        run_with_timeout(cmd, TIMEOUT, None).map_err(|e| format!("project-usage.mjs: {e}"))?;
    parse_cli_stdout(&output.stdout).map_err(|parse_err| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr_short: String = stderr.chars().take(2000).collect();
        format!("project-usage.mjs no devolvio JSON valido ({parse_err}); stderr: {stderr_short}")
    })
}

/// Uso de Claude Code de un proyecto en los ultimos `days` dias (30 por defecto).
/// Devuelve el JSON del script tal cual: `{"ok":true,...}` o
/// `{"ok":false,"error":{...}}`; solo es `Err` si el proceso no produjo JSON.
#[tauri::command]
pub async fn project_usage(
    project_id: String,
    days: Option<u32>,
) -> Result<serde_json::Value, String> {
    if !valid_project_id(&project_id) {
        return Err(format!(
            "project_usage: id de proyecto no valido: {project_id:?}"
        ));
    }
    let days = days.unwrap_or(DEFAULT_DAYS);
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(format!(
            "project_usage: days fuera de rango (1-{MAX_DAYS}): {days}"
        ));
    }
    tauri::async_runtime::spawn_blocking(move || run_script(&project_id, days))
        .await
        .map_err(|e| format!("project_usage: la tarea se interrumpio: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acepta_ids_de_proyecto_normales() {
        for id in [
            "ultron",
            "explored",
            "tfg-trabajo-fin-de-grado",
            "__home",
            "a_b-9",
        ] {
            assert!(valid_project_id(id), "deberia aceptar {id:?}");
        }
    }

    /// Caso negativo: nada que pueda leerse como flag, ruta o metacaracter de shell.
    #[test]
    fn rechaza_ids_peligrosos_o_vacios() {
        for id in [
            "",
            "-rf",
            "--json",
            "../x",
            "a b",
            "a;b",
            "a&b",
            "a|b",
            "a\"b",
            "C:\\x",
            "con\u{e1}cento",
        ] {
            assert!(!valid_project_id(id), "deberia rechazar {id:?}");
        }
        assert!(!valid_project_id(&"a".repeat(81)));
    }

    #[test]
    fn parse_cli_stdout_rechaza_salida_enorme_y_no_json() {
        assert!(parse_cli_stdout(b"{\"ok\":true}\n").is_ok());
        assert!(parse_cli_stdout(b"aviso\n{\"ok\":true}").is_err());
        assert!(parse_cli_stdout(&vec![b' '; MAX_STDOUT_BYTES + 1]).is_err());
    }
}
