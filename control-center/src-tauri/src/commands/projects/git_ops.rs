// commands/projects/git_ops.rs — Git operations per project path.
//
// All commands take a `path` string (absolute dir) and run git
// in that directory. Returns stdout+stderr merged as String.
// Errors surface as Err(String) so the frontend shows them directly.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// 3.7: cache TTL de git_repo_state. El panel del repo refresca periodicamente;
// sin cache cada tick spawnea git.exe (`git_ops.rs`). TTL corto: dato fresco pero
// sin ráfagas de procesos en refrescos seguidos.
const REPO_STATE_TTL: Duration = Duration::from_millis(1500);

/// path -> (instante de captura, estado). El instante da el TTL.
type RepoStateCache = HashMap<String, (Instant, GitRepoState)>;

fn repo_state_cache() -> &'static Mutex<RepoStateCache> {
    static CACHE: OnceLock<Mutex<RepoStateCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn run_git(args: &[&str], cwd: &str) -> Result<String, String> {
    let out = crate::proc::oculto("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git not found: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let combined = format!("{stdout}{stderr}").trim().to_string();
    if out.status.success() || !stdout.is_empty() {
        Ok(if combined.is_empty() {
            "OK".to_string()
        } else {
            combined
        })
    } else {
        Err(if combined.is_empty() {
            format!("git exited with code {:?}", out.status.code())
        } else {
            combined
        })
    }
}

#[tauri::command]
pub fn git_pull(path: String) -> Result<String, String> {
    run_git(&["pull", "--ff-only"], &path)
}

#[tauri::command]
pub fn git_push(path: String) -> Result<String, String> {
    run_git(&["push"], &path)
}

#[tauri::command]
pub fn git_init(path: String) -> Result<String, String> {
    run_git(&["init"], &path)
}

#[tauri::command]
pub fn git_fetch(path: String) -> Result<String, String> {
    run_git(&["fetch", "--quiet"], &path)
}

/// Returns a structured summary for the UI: branch, remote, ahead, behind, dirty.
/// Parses `git status --short --branch` output.
#[tauri::command]
pub fn git_repo_state(path: String) -> Result<GitRepoState, String> {
    // 3.7: sirve el estado cacheado si es reciente (< TTL) para no spawnear git.exe
    // en cada refresh del panel.
    if let Ok(cache) = repo_state_cache().lock() {
        if let Some((ts, state)) = cache.get(&path) {
            if ts.elapsed() < REPO_STATE_TTL {
                return Ok(state.clone());
            }
        }
    }
    if !std::path::Path::new(&path).join(".git").exists() {
        return Ok(GitRepoState {
            is_repo: false,
            branch: None,
            remote: None,
            ahead: 0,
            behind: 0,
            dirty: false,
            dirty_count: 0,
            path: path.clone(),
        });
    }
    let raw = run_git(&["status", "--short", "--branch", "--porcelain=v1"], &path)?;
    let mut branch = None::<String>;
    let mut remote = None::<String>;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut dirty_count = 0u32;
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // e.g. "main...origin/main [ahead 2, behind 1]" or "main" or "HEAD (no branch)"
            let (tracking, counts) = if let Some(idx) = rest.find(" [") {
                (&rest[..idx], Some(&rest[idx + 2..rest.len() - 1]))
            } else {
                (rest, None)
            };
            if let Some((b, r)) = tracking.split_once("...") {
                branch = Some(b.to_string());
                remote = Some(r.to_string());
            } else {
                branch = Some(tracking.replace("No commits yet on ", ""));
            }
            if let Some(counts_str) = counts {
                for part in counts_str.split(", ") {
                    if let Some(n) = part.strip_prefix("ahead ") {
                        ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix("behind ") {
                        behind = n.parse().unwrap_or(0);
                    }
                }
            }
        } else if !line.trim().is_empty() {
            dirty_count += 1;
        }
    }
    let state = GitRepoState {
        is_repo: true,
        branch,
        remote,
        ahead,
        behind,
        dirty: dirty_count > 0,
        dirty_count,
        path: path.clone(),
    };
    if let Ok(mut cache) = repo_state_cache().lock() {
        cache.insert(path.clone(), (Instant::now(), state.clone()));
    }
    Ok(state)
}

#[derive(serde::Serialize, Clone)]
pub struct GitRepoState {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub dirty_count: u32,
    /// Ruta absoluta del repo. Desambigua el panel (antes parecia "siempre Ultron"
    /// porque no mostraba de que repo era el estado). 3.7.
    pub path: String,
}

// ---------------------------------------------------------------------------
// Micro GitHub Desktop: changed files, per-file diff, stage/unstage, commit, log
// ---------------------------------------------------------------------------

/// Like `run_git` but returns RAW stdout (no trim, no stderr merge). Required for
/// `--porcelain` (leading spaces are significant) and diffs (leading context
/// spaces). `git diff` exits 1 when there ARE differences — that is not an error,
/// so a non-empty stdout is always treated as success.
fn git_stdout(args: &[&str], cwd: &str) -> Result<String, String> {
    let out = crate::proc::oculto("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git not found: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() || !stdout.is_empty() {
        Ok(stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// One changed file in the working tree, parsed from `git status --porcelain=v1`.
#[derive(serde::Serialize)]
pub struct GitFileChange {
    pub path: String,
    /// Index (staged) status char: 'M', 'A', 'D', 'R', ' ', '?'…
    pub index_status: String,
    /// Worktree status char.
    pub worktree_status: String,
    /// Whether the file has staged changes (index side is set and not untracked).
    pub staged: bool,
    pub untracked: bool,
}

/// Structured list of changed files (the left pane of GitHub Desktop).
#[tauri::command]
pub fn git_changes(path: String) -> Result<Vec<GitFileChange>, String> {
    if !std::path::Path::new(&path).join(".git").exists() {
        return Ok(Vec::new());
    }
    let raw = git_stdout(&["status", "--porcelain=v1"], &path)?;
    let mut changes = Vec::new();
    for line in raw.split('\n') {
        if line.len() < 3 {
            continue;
        }
        let x = &line[0..1];
        let y = &line[1..2];
        let rest = &line[3..];
        // Renames look like "old -> new"; show the destination path.
        let disp = match rest.split_once(" -> ") {
            Some((_, new)) => sin_comillas_de_git(new),
            None => sin_comillas_de_git(rest),
        };
        let untracked = x == "?";
        let staged = x != " " && x != "?";
        changes.push(GitFileChange {
            path: disp,
            index_status: x.to_string(),
            worktree_status: y.to_string(),
            staged,
            untracked,
        });
    }
    Ok(changes)
}

/// Deshace el entrecomillado estilo C con el que `git status --porcelain=v1`
/// imprime las rutas con espacios, comillas o bytes >= 0x80 (con
/// `core.quotePath` en su valor por defecto, «ñó.md» sale como
/// `"\303\261\303\263.md"`). Hasta el 2026-09-22 esa cadena viajaba tal cual
/// a la interfaz y de ahi a `git ls-files`/`checkout`/`diff`, que no la
/// reconocian: el panel Cambios acusaba de «no está en git» a un fichero
/// seguido y no descartaba nada. Se decodifica AQUI, en el origen, para que
/// ningun consumidor (preparar, quitar, diff, descartar) tenga que saberlo.
fn sin_comillas_de_git(ruta: &str) -> String {
    let Some(interior) = ruta.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
        return ruta.to_string();
    };
    let bytes = interior.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b != b'\\' || i + 1 >= bytes.len() {
            out.push(b);
            i += 1;
            continue;
        }
        let e = bytes[i + 1];
        i += 2;
        match e {
            b'n' => out.push(b'\n'),
            b't' => out.push(b'\t'),
            b'r' => out.push(b'\r'),
            b'a' => out.push(7),
            b'b' => out.push(8),
            b'f' => out.push(12),
            b'v' => out.push(11),
            b'0'..=b'7' => {
                // Hasta tres digitos octales: un byte del UTF-8 original.
                let mut v = u32::from(e - b'0');
                let mut n = 1;
                while n < 3 && i < bytes.len() && (b'0'..=b'7').contains(&bytes[i]) {
                    v = v * 8 + u32::from(bytes[i] - b'0');
                    i += 1;
                    n += 1;
                }
                out.push(v as u8);
            }
            // `\\`, `\"` y cualquier otro escape: el caracter literal.
            otro => out.push(otro),
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Unified diff for a single file. `staged=true` shows the index-vs-HEAD diff;
/// otherwise the worktree diff (falling back to a full --no-index diff for
/// untracked files, where `git diff` would print nothing).
#[tauri::command]
pub fn git_diff_file(path: String, file: String, staged: bool) -> Result<String, String> {
    if staged {
        return git_stdout(&["diff", "--cached", "--", &file], &path);
    }
    let d = git_stdout(&["diff", "--", &file], &path)?;
    if d.trim().is_empty() {
        // Likely untracked — show the whole file as additions.
        return git_stdout(&["diff", "--no-index", "--", "/dev/null", &file], &path)
            .or(Ok(String::new()));
    }
    Ok(d)
}

/// Stage files. Empty list = stage everything (`git add -A`).
#[tauri::command]
pub fn git_stage(path: String, files: Vec<String>) -> Result<String, String> {
    if files.is_empty() {
        return run_git(&["add", "-A"], &path);
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(files.iter().map(String::as_str));
    run_git(&args, &path)
}

/// Unstage files (keep working-tree changes). Empty list = unstage everything.
#[tauri::command]
pub fn git_unstage(path: String, files: Vec<String>) -> Result<String, String> {
    if files.is_empty() {
        return run_git(&["reset", "-q"], &path);
    }
    let mut args: Vec<&str> = vec!["reset", "-q", "--"];
    args.extend(files.iter().map(String::as_str));
    run_git(&args, &path)
}

/// Commit the staged changes with `message`. Fails fast on an empty message.
#[tauri::command]
pub fn git_commit(path: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("el mensaje de commit no puede estar vacío".to_string());
    }
    run_git(&["commit", "-m", &message], &path)
}

/// Descarta los cambios de UN fichero: lo deja como esta en HEAD, preparado o
/// no. Es la unica operacion irreversible del panel Cambios (2026-09-22).
///
/// Dos puertas antes de tocar nada, porque no hay punto de control al que
/// volver:
///
///  1. El fichero tiene que estar SEGUIDO. Descartar uno sin seguir seria
///     borrarlo, y git no tiene de donde recuperarlo: eso no lo hace este
///     comando, lo hace el usuario desde el explorador si de verdad quiere.
///  2. El fichero tiene que existir en HEAD. Uno recien anadido al indice
///     tampoco tiene version anterior a la que volver — mismo caso.
///
/// La interfaz ademas lo pide con `confirmDialog` diciendo el nombre. Aqui se
/// cierra la puerta igualmente: la comprobacion no puede vivir solo en React.
#[tauri::command]
pub fn git_discard_file(path: String, file: String) -> Result<String, String> {
    if file.trim().is_empty() {
        return Err("no se ha dicho qué fichero descartar".to_string());
    }
    // La unica puerta que bloquea es HEAD: si el fichero existe ahi, volver a
    // el nunca pierde nada, este o no en el indice. Hasta el 2026-09-22 se
    // preguntaba primero a `ls-files`, y un borrado ya preparado (`D `, que
    // el indice ya no conoce) se rechazaba acusando al fichero de «no estar
    // en git»: justo el caso en que descartar es recuperar.
    let en_head = crate::proc::oculto("git")
        .args(["cat-file", "-e", &format!("HEAD:{file}")])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("git not found: {e}"))?
        .status
        .success();
    if en_head {
        // `checkout HEAD --` pisa indice Y arbol de trabajo: sin el `HEAD`, lo
        // preparado sobreviviria y el fichero seguiria saliendo como cambiado.
        return run_git(&["checkout", "HEAD", "--", &file], &path);
    }
    // Sin version en HEAD no hay a que volver. `ls-files --error-unmatch`
    // (codigo != 0 si el indice no conoce la ruta) solo decide el mensaje.
    let seguido = crate::proc::oculto("git")
        .args(["ls-files", "--error-unmatch", "--", &file])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("git not found: {e}"))?
        .status
        .success();
    if seguido {
        return Err(format!(
            "«{file}» es nuevo: no hay versión anterior a la que volver. \
             Quítalo de preparado y bórralo tú si no lo quieres."
        ));
    }
    Err(format!(
        "«{file}» no está en git todavía: descartarlo sería borrarlo y no \
         habría de dónde recuperarlo. Bórralo tú si es lo que quieres."
    ))
}

/// One commit in the history list.
#[derive(serde::Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

/// Parsed commit history (newest first). `limit` defaults to 50.
#[tauri::command]
pub fn git_log_full(path: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    if !std::path::Path::new(&path).join(".git").exists() {
        return Ok(Vec::new());
    }
    let n = format!("-{}", limit.unwrap_or(50));
    // Unit-separator (\x1f) between fields, newline between commits.
    let raw = git_stdout(
        &[
            "log",
            &n,
            "--date=short",
            "--pretty=format:%H\x1f%h\x1f%an\x1f%ad\x1f%s",
        ],
        &path,
    )?;
    let commits = raw
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let mut f = line.split('\x1f');
            Some(GitCommit {
                hash: f.next()?.to_string(),
                short: f.next()?.to_string(),
                author: f.next()?.to_string(),
                date: f.next()?.to_string(),
                subject: f.next().unwrap_or("").to_string(),
            })
        })
        .collect();
    Ok(commits)
}

/// Returns true if the project at `path` has a `.codegraph/codegraph.db` (already indexed).
#[tauri::command]
pub fn codegraph_is_indexed(path: String) -> bool {
    std::path::Path::new(&path)
        .join(".codegraph")
        .join("codegraph.db")
        .exists()
}

/// Resumen del grafo de código de un proyecto, leído DIRECTAMENTE del
/// `.codegraph/codegraph.db` (read-only). Pilar 2 / cat2.5 (2026-06-10):
/// hasta ahora la app solo comprobaba que el fichero existía y delegaba todo
/// el consumo al MCP de las sesiones CLI — el dato existía pero la app no lo
/// usaba (mandamiento 12). Alimenta el panel CodeGraph de ProjectWorkspace.
#[derive(serde::Serialize)]
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
pub fn codegraph_summary(path: String) -> Result<CodeGraphSummary, String> {
    let db = std::path::Path::new(&path)
        .join(".codegraph")
        .join("codegraph.db");
    if !db.exists() {
        return Err("proyecto sin indexar (no existe .codegraph/codegraph.db)".to_string());
    }
    let conn =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("abrir codegraph.db: {e}"))?;

    let count = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0))
            .map_err(|e| format!("query codegraph.db: {e}"))
    };
    let files = count("SELECT COUNT(*) FROM files")?;
    let nodes = count("SELECT COUNT(*) FROM nodes")?;
    let edges = count("SELECT COUNT(*) FROM edges")?;

    let mut stmt = conn
        .prepare(
            "SELECT language, COUNT(*) AS n FROM files \
             WHERE language IS NOT NULL GROUP BY language ORDER BY n DESC LIMIT 8",
        )
        .map_err(|e| e.to_string())?;
    let languages = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let last_indexed_at = conn
        .query_row("SELECT MAX(indexed_at) FROM files", [], |r| r.get(0))
        .ok();

    Ok(CodeGraphSummary {
        files,
        nodes,
        edges,
        languages,
        last_indexed_at,
    })
}

/// Runs `codegraph init -i <path>` to build the initial index.
/// Blocks until done (may take seconds for large repos).
#[tauri::command]
pub fn codegraph_init_project(path: String) -> Result<String, String> {
    let out = crate::proc::oculto("codegraph")
        .args(["init", "-i"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("codegraph not found on PATH: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let combined = format!("{stdout}{stderr}").trim().to_string();
    if out.status.success() {
        Ok(if combined.is_empty() {
            "Proyecto indexado correctamente".to_string()
        } else {
            combined
        })
    } else {
        Err(if combined.is_empty() {
            format!("codegraph init falló (código {:?})", out.status.code())
        } else {
            combined
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Repo de usar y tirar en un tempdir. No toca nada del disco real: el
    /// directorio se borra al soltar el `TempDir` que devuelve.
    fn repo_de_prueba() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        let ruta = dir.path().to_string_lossy().to_string();
        for args in [
            vec!["init", "--quiet"],
            vec!["config", "user.email", "pruebas@example.invalid"],
            vec!["config", "user.name", "pruebas"],
            // Sin esto el test depende del `core.autocrlf` de quien lo ejecute:
            // en Windows git devolveria "original\r\n" al restaurar.
            vec!["config", "core.autocrlf", "false"],
        ] {
            run_git(&args, &ruta).expect("preparar el repo");
        }
        std::fs::write(dir.path().join("uno.txt"), "original\n").expect("escribir");
        run_git(&["add", "uno.txt"], &ruta).expect("add");
        run_git(&["commit", "-m", "primero", "--quiet"], &ruta).expect("commit");
        (dir, ruta)
    }

    #[test]
    fn descartar_devuelve_el_fichero_a_como_estaba() {
        let (dir, ruta) = repo_de_prueba();
        std::fs::write(dir.path().join("uno.txt"), "destrozado\n").expect("escribir");
        assert_eq!(
            git_changes(ruta.clone()).expect("status").len(),
            1,
            "el fichero deberia salir como cambiado antes de descartar"
        );

        git_discard_file(ruta.clone(), "uno.txt".into()).expect("descartar");

        assert_eq!(
            std::fs::read_to_string(dir.path().join("uno.txt")).expect("leer"),
            "original\n"
        );
        assert!(
            git_changes(ruta).expect("status").is_empty(),
            "el arbol de trabajo tiene que quedar limpio"
        );
    }

    #[test]
    fn descartar_tambien_deshace_lo_que_ya_estaba_preparado() {
        // `git checkout -- fichero` (sin HEAD) restaura desde el INDICE: con el
        // cambio preparado no deshacia nada y el fichero seguia saliendo como
        // cambiado. Por eso el comando pasa `HEAD` explicitamente.
        let (dir, ruta) = repo_de_prueba();
        std::fs::write(dir.path().join("uno.txt"), "destrozado\n").expect("escribir");
        git_stage(ruta.clone(), vec!["uno.txt".into()]).expect("stage");

        git_discard_file(ruta.clone(), "uno.txt".into()).expect("descartar");

        assert_eq!(
            std::fs::read_to_string(dir.path().join("uno.txt")).expect("leer"),
            "original\n"
        );
        assert!(git_changes(ruta).expect("status").is_empty());
    }

    #[test]
    fn descartar_un_fichero_sin_seguir_falla_en_vez_de_borrarlo() {
        // Caso negativo, y el que justifica las dos puertas: git no tiene copia
        // de un fichero sin seguir, asi que "descartarlo" seria una perdida
        // irreversible. Tiene que fallar Y dejar el fichero donde estaba.
        let (dir, ruta) = repo_de_prueba();
        let suelto = dir.path().join("nuevo.txt");
        std::fs::write(&suelto, "sin guardar en ningun sitio\n").expect("escribir");

        let err = git_discard_file(ruta.clone(), "nuevo.txt".into())
            .expect_err("un fichero sin seguir no se descarta");
        assert!(err.contains("no está en git"), "mensaje raro: {err}");
        assert!(suelto.exists(), "no se puede haber borrado el fichero");

        // Y tampoco si esta solo preparado: no existe en HEAD.
        git_stage(ruta.clone(), vec!["nuevo.txt".into()]).expect("stage");
        let err = git_discard_file(ruta, "nuevo.txt".into())
            .expect_err("un fichero nuevo preparado tampoco tiene version anterior");
        assert!(err.contains("es nuevo"), "mensaje raro: {err}");
        assert!(suelto.exists(), "no se puede haber borrado el fichero");
    }

    #[test]
    fn el_entrecomillado_de_git_se_deshace_y_lo_normal_no_se_toca() {
        assert_eq!(sin_comillas_de_git("normal.txt"), "normal.txt");
        assert_eq!(
            sin_comillas_de_git("\"con espacio.txt\""),
            "con espacio.txt"
        );
        assert_eq!(sin_comillas_de_git(r#""\303\261\303\263.md""#), "ñó.md");
        assert_eq!(sin_comillas_de_git(r#""a\"b\\c\t.txt""#), "a\"b\\c\t.txt");
        // Caso negativo: una comilla suelta no es un entrecomillado.
        assert_eq!(sin_comillas_de_git("\"a medias"), "\"a medias");
    }

    #[test]
    fn descartar_funciona_con_las_rutas_que_git_entrecomilla() {
        // Caso negativo: `git status --porcelain=v1` imprime la ruta entre
        // comillas y en estilo C cuando lleva un espacio o un byte >= 0x80
        // («con espacio.txt», «ñó.md» -> `"\303\261\303\263.md"`). El panel la
        // pasaba tal cual, `ls-files --error-unmatch` no la reconocia y el
        // comando acusaba de «no está en git» a un fichero seguido y ya
        // commiteado, sin descartar nada (2026-09-22).
        const RAROS: [&str; 2] = ["con espacio.txt", "ñó.md"];
        let (dir, ruta) = repo_de_prueba();
        for nombre in RAROS {
            std::fs::write(dir.path().join(nombre), "original\n").expect("escribir");
        }
        run_git(&["add", "-A"], &ruta).expect("add");
        run_git(&["commit", "-m", "raros", "--quiet"], &ruta).expect("commit");
        for nombre in RAROS {
            std::fs::write(dir.path().join(nombre), "destrozado\n").expect("escribir");
        }

        // La ruta se toma de donde la toma la interfaz, sin retocarla.
        let cambios = git_changes(ruta.clone()).expect("status");
        assert_eq!(cambios.len(), 2, "los dos salen como cambiados");
        for c in &cambios {
            assert!(!c.path.starts_with('"'), "sigue entrecomillada: {}", c.path);
        }
        for c in cambios {
            git_discard_file(ruta.clone(), c.path.clone())
                .unwrap_or_else(|e| panic!("descartar «{}»: {e}", c.path));
        }

        for nombre in RAROS {
            assert_eq!(
                std::fs::read_to_string(dir.path().join(nombre)).expect("leer"),
                "original\n",
                "«{nombre}» no volvio a como estaba"
            );
        }
        assert!(
            git_changes(ruta).expect("status").is_empty(),
            "el arbol de trabajo tiene que quedar limpio"
        );
    }

    #[test]
    fn descartar_recupera_un_borrado_ya_preparado() {
        // Caso negativo (2026-09-22): con `rm` + `git add -A` el fichero sale
        // como `D ` y el indice ya no lo conoce; preguntar primero a
        // `ls-files` lo rechazaba como «no esta en git» cuando descartar es
        // exactamente recuperarlo desde HEAD.
        let (dir, ruta) = repo_de_prueba();
        let f = dir.path().join("borrado.txt");
        std::fs::write(&f, "estaba\n").expect("escribir");
        run_git(&["add", "-A"], &ruta).expect("add");
        run_git(&["commit", "-m", "con fichero", "--quiet"], &ruta).expect("commit");
        std::fs::remove_file(&f).expect("borrar");
        run_git(&["add", "-A"], &ruta).expect("preparar el borrado");
        let cambios = git_changes(ruta.clone()).expect("status");
        assert_eq!(cambios.len(), 1);
        assert_eq!(cambios[0].index_status, "D", "el borrado esta preparado");

        git_discard_file(ruta.clone(), "borrado.txt".into()).expect("descartar el borrado");

        assert_eq!(std::fs::read_to_string(&f).expect("leer"), "estaba\n");
        assert!(git_changes(ruta).expect("status").is_empty());
    }

    #[test]
    fn descartar_sin_fichero_no_hace_nada() {
        let (_dir, ruta) = repo_de_prueba();
        assert!(git_discard_file(ruta, "   ".into()).is_err());
    }

    #[test]
    fn repo_state_cache_roundtrip_and_ttl() {
        // El cache es la unica pieza nueva de 3.7 con logica; git no interviene.
        let key = "___kirkardo_git_cache_test___".to_string();
        let st = GitRepoState {
            is_repo: true,
            branch: Some("main".to_string()),
            remote: None,
            ahead: 1,
            behind: 0,
            dirty: false,
            dirty_count: 0,
            path: key.clone(),
        };
        repo_state_cache()
            .lock()
            .unwrap()
            .insert(key.clone(), (Instant::now(), st.clone()));
        let got = repo_state_cache().lock().unwrap().get(&key).cloned();
        let (ts, cached) = got.expect("estado cacheado presente");
        assert!(
            ts.elapsed() < REPO_STATE_TTL,
            "recien insertado -> dentro de TTL"
        );
        assert_eq!(cached.path, key, "el path desambigua el repo");
        assert_eq!(cached.branch.as_deref(), Some("main"));
    }
}
