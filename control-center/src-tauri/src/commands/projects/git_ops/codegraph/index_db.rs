// commands/projects/git_ops/codegraph/index_db.rs — Acceso de solo lectura al
// `.codegraph/codegraph.db` de un proyecto.
//
// Todos los comandos de CodeGraph de la app abren el índice por aquí: modo
// solo lectura (la app nunca escribe en el índice; el daemon de CodeGraph es
// su único escritor), espera acotada si el daemon tiene el fichero bloqueado
// y comprobación del esquema antes de la primera consulta, para que un
// fichero ajeno o a medio crear dé un error claro y no un «no such table».

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

/// Espera máxima si el daemon de CodeGraph está escribiendo (modo WAL).
const BUSY_TIMEOUT: Duration = Duration::from_secs(2);

/// Tablas sin las que el índice no se puede leer.
const REQUIRED_TABLES: [&str; 3] = ["files", "nodes", "edges"];

/// Mensaje de error de un proyecto sin índice. La tarjeta lo enseña tal cual.
pub(crate) const NOT_INDEXED: &str = "proyecto sin indexar (no existe .codegraph/codegraph.db)";

/// Ruta del índice de CodeGraph dentro de la carpeta del proyecto.
pub(crate) fn index_path(project: &Path) -> PathBuf {
    project.join(".codegraph").join("codegraph.db")
}

/// La carpeta personal no es un proyecto indexable: `~/.codegraph` es el
/// directorio global de CodeGraph (daemons, telemetría) y su `codegraph.db`
/// no describe ningún código. `codegraph init` también se niega a indexarla
/// sin `--force`.
pub(crate) fn is_home_dir(project: &Path, home: Option<&Path>) -> bool {
    let Some(home) = home else {
        return false;
    };
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(project) == canon(home)
}

/// Comprueba la ruta del proyecto y devuelve la del índice, o el motivo por
/// el que no hay índice que leer.
pub(crate) fn locate_index(project: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    let dir = Path::new(project);
    if project.trim().is_empty() || !dir.is_dir() {
        return Err(format!("la carpeta del proyecto no existe: {project}"));
    }
    if is_home_dir(dir, home) {
        return Err(
            "la carpeta personal no se indexa: ~/.codegraph es el directorio global de CodeGraph"
                .to_string(),
        );
    }
    let db = index_path(dir);
    if !db.is_file() {
        return Err(NOT_INDEXED.to_string());
    }
    Ok(db)
}

/// Abre el índice en solo lectura y verifica que tiene el esquema esperado.
pub(crate) fn open_index(project: &str) -> Result<Connection, String> {
    let home = dirs::home_dir();
    let db = locate_index(project, home.as_deref())?;
    open_index_file(&db)
}

pub(crate) fn open_index_file(db: &Path) -> Result<Connection, String> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn =
        Connection::open_with_flags(db, flags).map_err(|e| format!("abrir codegraph.db: {e}"))?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| format!("configurar codegraph.db: {e}"))?;
    check_schema(&conn)?;
    Ok(conn)
}

fn check_schema(conn: &Connection) -> Result<(), String> {
    let present: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN (?1, ?2, ?3)",
            REQUIRED_TABLES,
            |r| r.get(0),
        )
        .map_err(|e| format!("codegraph.db ilegible: {e}"))?;
    if present as usize == REQUIRED_TABLES.len() {
        Ok(())
    } else {
        Err(
            "codegraph.db no tiene el esquema de CodeGraph (faltan files, nodes o edges)"
                .to_string(),
        )
    }
}

/// Error de consulta con contexto, para no devolver el texto pelado de SQLite.
pub(crate) fn query_err(e: rusqlite::Error) -> String {
    format!("consulta a codegraph.db: {e}")
}

/// Recorta un texto largo (firmas, nombres cualificados) para acotar el tamaño
/// de la respuesta. Corta en frontera de carácter y marca el recorte.
pub(crate) fn clip(text: String, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text;
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}
