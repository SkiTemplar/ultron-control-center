// Wrapper Tauri del CLI `~/.ultron/scripts/project-create.mjs` (asistente
// "Nuevo proyecto" de la pestana Projects). El script scaffoldea
// asignaturas/proyectos personales sobre disco (git init, CLAUDE.md,
// plantillas) y habla `--json` puro por stdout; este comando solo lo lanza,
// aplica la allowlist de subcomandos y traduce el resultado.
//
// Contrato de subcomandos: roots|list|templates|subject|mkdir|create. La
// configuracion de raices (`roots set`) NO se expone a la UI: permitiria a un
// webview comprometido declarar una raiz arbitraria y escribir fuera de ella.
//
// Reutiliza `ai_router::exec::run_with_timeout` (mismo helper que ya arma
// los CLIs de codex/gemini): drena stdout/stderr en hilos aparte para no
// bloquear con pipes llenos y mata el proceso si excede el timeout.

use std::path::PathBuf;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::ai_router::exec::run_with_timeout;

/// Subcomandos que el contrato de `project-create.mjs` reconoce. Cualquier
/// otro primer argumento se rechaza ANTES de tocar `std::process::Command`
/// — nunca se delega la validacion al propio proceso hijo.
const ALLOWED_SUBCOMMANDS: [&str; 6] = ["roots", "list", "templates", "subject", "mkdir", "create"];

/// Hay generadores de plantilla que instalan dependencias (npm/uv/cargo);
/// 6 minutos de margen antes de matar el proceso.
const TIMEOUT: Duration = Duration::from_secs(360);

fn validate_subcommand(args: &[String]) -> Result<&str, String> {
    let first = args.first().ok_or_else(|| {
        "project_create_cli: falta el subcomando (roots|list|templates|subject|mkdir|create)"
            .to_string()
    })?;
    if !ALLOWED_SUBCOMMANDS.contains(&first.as_str()) {
        return Err(format!(
            "project_create_cli: subcomando no permitido: {first:?} (permitidos: {})",
            ALLOWED_SUBCOMMANDS.join("|")
        ));
    }
    let second = args.get(1).map(String::as_str);
    if first == "roots" && second.is_some_and(|s| !s.starts_with("--")) {
        return Err(
            "project_create_cli: `roots` solo admite lectura desde la app; las raices se configuran por terminal"
                .to_string(),
        );
    }
    if first == "subject" && second != Some("new") {
        return Err("project_create_cli: `subject` solo admite `new`".to_string());
    }
    Ok(first.as_str())
}

/// Tope de stdout aceptado: el script emite un unico objeto JSON pequeno; algo
/// mayor indica salida inesperada y no se parsea.
const MAX_STDOUT_BYTES: usize = 1024 * 1024;

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
        .join("project-create.mjs"))
}

/// Lanza `node ~/.ultron/scripts/project-create.mjs <args> [--json]` sin
/// shell (args en array) y devuelve el JSON que emite por stdout tal cual —
/// tanto el caso `{"ok":true,...}` como `{"ok":false,"error":{...}}` son
/// parseos validos; el frontend decide segun el campo `ok`. Solo se
/// devuelve `Err` cuando el proceso no produjo JSON en absoluto (crash,
/// script ausente, node no encontrado, timeout).
#[tauri::command]
pub fn project_create_cli(args: Vec<String>) -> Result<serde_json::Value, String> {
    validate_subcommand(&args)?;

    let script = script_path()?;
    if !script.is_file() {
        return Err(format!(
            "no se encontro el script project-create.mjs en {}",
            script.display()
        ));
    }

    let mut cmd = crate::proc::oculto("node");
    cmd.arg(&script);
    cmd.args(&args);
    if !args.iter().any(|a| a == "--json") {
        cmd.arg("--json");
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output =
        run_with_timeout(cmd, TIMEOUT, None).map_err(|e| format!("project-create.mjs: {e}"))?;

    parse_cli_stdout(&output.stdout).map_err(|parse_err| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr_short: String = stderr.chars().take(2000).collect();
        format!("project-create.mjs no devolvio JSON valido ({parse_err}); stderr: {stderr_short}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acepta_todos_los_subcomandos_del_contrato() {
        for sc in ALLOWED_SUBCOMMANDS {
            let mut args = vec![sc.to_string()];
            if sc == "subject" {
                args.push("new".to_string());
            }
            assert!(validate_subcommand(&args).is_ok(), "deberia aceptar {sc:?}");
        }
    }

    /// Caso negativo: un primer argumento fuera de la allowlist (por ejemplo
    /// intentar colar una flag arbitraria o un subcomando inventado) se
    /// rechaza antes de spawnear nada.
    #[test]
    fn rechaza_subcomando_no_permitido() {
        let args = vec!["rm".to_string(), "-rf".to_string()];
        assert!(validate_subcommand(&args).is_err());

        let args = vec!["--json".to_string()];
        assert!(validate_subcommand(&args).is_err());
    }

    /// `roots set` reescribiria las raices desde la UI: solo por terminal.
    #[test]
    fn rechaza_roots_set_y_subject_distinto_de_new() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(validate_subcommand(&s(&["roots", "set", "--path", "C:\\"])).is_err());
        assert!(validate_subcommand(&s(&["roots"])).is_ok());
        assert!(validate_subcommand(&s(&["roots", "--json"])).is_ok());
        assert!(validate_subcommand(&s(&["subject", "new", "--code", "X"])).is_ok());
        assert!(validate_subcommand(&s(&["subject", "rm"])).is_err());
        assert!(validate_subcommand(&s(&["subject"])).is_err());
    }

    #[test]
    fn parse_cli_stdout_rechaza_salida_enorme_y_no_json() {
        assert!(parse_cli_stdout(b"{\"ok\":true}\n").is_ok());
        assert!(parse_cli_stdout(b"npm warn\n{\"ok\":true}").is_err());
        assert!(parse_cli_stdout(&vec![b' '; MAX_STDOUT_BYTES + 1]).is_err());
    }

    #[test]
    fn rechaza_lista_de_argumentos_vacia() {
        let args: Vec<String> = vec![];
        assert!(validate_subcommand(&args).is_err());
    }
}
