// commands/projects/git_ops/codegraph.rs — Índice de CodeGraph por proyecto.
//
// Comprobar si el proyecto está indexado, leer el resumen del grafo
// directamente de `.codegraph/codegraph.db`, lanzar `codegraph init` y, en
// `codegraph/view.rs`, las lecturas del visor (ficheros, búsqueda y
// vecindario). El acceso al índice vive en `codegraph/index_db.rs`.

mod index_db;
mod view;

pub use view::*;

use std::process::Command;
use std::time::Duration;

use index_db::{locate_index, open_index, query_err};

/// True si el proyecto en `path` tiene índice de CodeGraph legible por la app.
/// La carpeta personal da false aunque exista `~/.codegraph/codegraph.db`: ese
/// es el directorio global de CodeGraph, no el índice de un proyecto.
#[tauri::command]
pub fn codegraph_is_indexed(path: String) -> bool {
    let home = dirs::home_dir();
    locate_index(&path, home.as_deref()).is_ok()
}

/// Resumen del grafo de código de un proyecto, leído DIRECTAMENTE del
/// `.codegraph/codegraph.db` (read-only). Pilar 2 / cat2.5 (2026-06-10):
/// hasta ahora la app solo comprobaba que el fichero existía y delegaba todo
/// el consumo al MCP de las sesiones CLI — el dato existía pero la app no lo
/// usaba (mandamiento 12). Alimenta el panel CodeGraph de ProjectWorkspace.
#[derive(Debug, serde::Serialize)]
pub struct CodeGraphSummary {
    pub files: i64,
    pub nodes: i64,
    pub edges: i64,
    /// (lenguaje, nº archivos), descendente.
    pub languages: Vec<(String, i64)>,
    /// epoch ms del último `indexed_at` — frescura del índice.
    pub last_indexed_at: Option<i64>,
}

#[tauri::command]
pub async fn codegraph_summary(path: String) -> Result<CodeGraphSummary, String> {
    summary_of(&open_index(&path)?)
}

/// Lee el resumen. Ningún error se traga: un fallo en lenguajes o en la
/// frescura es un índice que no se puede leer, no un dato opcional.
fn summary_of(conn: &rusqlite::Connection) -> Result<CodeGraphSummary, String> {
    let count = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0)).map_err(query_err)
    };
    let files = count("SELECT COUNT(*) FROM files")?;
    let nodes = count("SELECT COUNT(*) FROM nodes")?;
    let edges = count("SELECT COUNT(*) FROM edges")?;

    let mut stmt = conn
        .prepare(
            "SELECT language, COUNT(*) AS n FROM files \
             WHERE language IS NOT NULL GROUP BY language ORDER BY n DESC LIMIT 8",
        )
        .map_err(query_err)?;
    let languages = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(query_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(query_err)?;

    // MAX sobre una tabla vacía da NULL: None es «sin ficheros», no un error.
    let last_indexed_at = conn
        .query_row("SELECT MAX(indexed_at) FROM files", [], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .map_err(query_err)?;

    Ok(CodeGraphSummary {
        files,
        nodes,
        edges,
        languages,
        last_indexed_at,
    })
}

/// Tope de `codegraph init`. Indexar un repo grande lleva minutos, pero un
/// proceso colgado no puede dejar la tarjeta en «Indexando…» para siempre.
const CODEGRAPH_INIT_TIMEOUT: Duration = Duration::from_secs(600);

/// Traduce el fallo al lanzar `codegraph` a un mensaje que la tarjeta enseña.
fn codegraph_spawn_error(e: &std::io::Error, timeout: Duration) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => {
            "codegraph no está instalado o no está en el PATH".to_string()
        }
        std::io::ErrorKind::TimedOut => format!(
            "codegraph init superó el tope de {} s y se canceló",
            timeout.as_secs()
        ),
        _ => format!("no se pudo lanzar codegraph: {e}"),
    }
}

/// Resultado de `codegraph init` a partir de su salida. Solo cuenta el código
/// de salida: un fallo con texto en stdout sigue siendo un fallo.
fn codegraph_init_outcome(
    success: bool,
    code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<String, String> {
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    )
    .trim()
    .to_string();
    match (success, combined.is_empty()) {
        (true, true) => Ok("Proyecto indexado correctamente".to_string()),
        (true, false) => Ok(combined),
        (false, true) => Err(format!("codegraph init falló (código {code:?})")),
        (false, false) => Err(combined),
    }
}

fn codegraph_init_blocking(path: &str, timeout: Duration) -> Result<String, String> {
    let dir = std::path::Path::new(path);
    if path.trim().is_empty() || !dir.is_dir() {
        return Err(format!("codegraph init: la carpeta no existe: {path}"));
    }
    // `codegraph` es un shim de npm (`codegraph.cmd`): en Windows
    // `Command::new("codegraph")` solo prueba `.exe` y no lo encuentra.
    #[cfg(target_os = "windows")]
    let program = crate::ai_router::exec::resolve_windows_cli_program("codegraph");
    #[cfg(not(target_os = "windows"))]
    let program = "codegraph".to_string();
    let mut cmd = Command::new(&program);
    // `--yes`: sin preguntas interactivas (stdin va cerrado; una pregunta
    // esperaría hasta el tope). `-i` está obsoleto: indexar ya es el defecto.
    cmd.args(["init", "--yes"]).current_dir(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = crate::ai_router::exec::run_with_timeout(cmd, timeout, None)
        .map_err(|e| codegraph_spawn_error(&e, timeout))?;
    codegraph_init_outcome(
        out.status.success(),
        out.status.code(),
        &out.stdout,
        &out.stderr,
    )
}

/// Lanza `codegraph init --yes` en `path` para construir el índice inicial.
/// Corre fuera del hilo de IPC (`spawn_blocking`): indexar puede durar minutos
/// y antes bloqueaba un hilo del runtime mientras tanto.
#[tauri::command]
pub async fn codegraph_init_project(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        codegraph_init_blocking(&path, CODEGRAPH_INIT_TIMEOUT)
    })
    .await
    .map_err(|e| format!("codegraph init: la tarea se interrumpió: {e}"))?
}

#[cfg(test)]
mod tests_index;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codegraph_init_outcome_solo_mira_el_codigo_de_salida() {
        assert_eq!(
            codegraph_init_outcome(true, Some(0), b"", b""),
            Ok("Proyecto indexado correctamente".to_string())
        );
        assert_eq!(
            codegraph_init_outcome(true, Some(0), b"Indexed 120 files\n", b""),
            Ok("Indexed 120 files".to_string())
        );
        // Caso negativo: texto en stdout con código distinto de cero es un fallo.
        assert_eq!(
            codegraph_init_outcome(false, Some(1), b"Scanning...\n", b"Error: EPERM\n"),
            Err("Scanning...\nError: EPERM".to_string())
        );
        let sin_texto = codegraph_init_outcome(false, Some(3), b"", b"").unwrap_err();
        assert!(sin_texto.contains("Some(3)"), "{sin_texto}");
    }

    #[test]
    fn codegraph_init_rechaza_una_carpeta_inexistente_sin_lanzar_nada() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let falta = tmp.path().join("no-existe");
        let err =
            codegraph_init_blocking(&falta.to_string_lossy(), Duration::from_secs(1)).unwrap_err();
        assert!(err.contains("la carpeta no existe"), "{err}");
        let vacia = codegraph_init_blocking("  ", Duration::from_secs(1)).unwrap_err();
        assert!(vacia.contains("la carpeta no existe"), "{vacia}");
    }

    #[test]
    fn codegraph_spawn_error_explica_el_motivo() {
        let t = Duration::from_secs(600);
        let no_esta = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(codegraph_spawn_error(&no_esta, t).contains("PATH"));
        let tope = std::io::Error::new(std::io::ErrorKind::TimedOut, "x");
        assert!(codegraph_spawn_error(&tope, t).contains("600 s"));
        let otro = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "acceso denegado");
        assert!(codegraph_spawn_error(&otro, t).contains("acceso denegado"));
    }
}
