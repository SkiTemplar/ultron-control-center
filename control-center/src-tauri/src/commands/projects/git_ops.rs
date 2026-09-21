// commands/projects/git_ops.rs — Git operations per project path.
//
// All commands take a `path` string (absolute dir) and run git
// in that directory. Returns stdout+stderr merged as String.
// Errors surface as Err(String) so the frontend shows them directly.

use std::collections::HashMap;
use std::process::Command;
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

/// Borra la entrada cacheada de `path`. Se llama tras cada operación de
/// escritura (stage/unstage/commit/pull/push/fetch): sin esto el panel podía
/// mostrar hasta `REPO_STATE_TTL` de estado viejo justo después de actuar.
fn invalidate_repo_state(path: &str) {
    if let Ok(mut cache) = repo_state_cache().lock() {
        cache.remove(path);
    }
}

/// `git` preparado para correr sin ventana de consola en Windows.
///
/// Sin `CREATE_NO_WINDOW` cada invocación crea (y destruye) una consola: coste
/// fijo por comando y parpadeo visible. El panel dispara varios comandos por
/// interacción, así que el coste se multiplica. Resto de spawns de la app ya
/// usan este flag; `git_ops.rs` era el único que faltaba.
fn git_command(args: &[&str], cwd: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn run_git(args: &[&str], cwd: &str) -> Result<String, String> {
    let out = git_command(args, cwd)
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
    invalidate_repo_state(&path);
    run_git(&["pull", "--ff-only"], &path)
}

#[tauri::command]
pub fn git_push(path: String) -> Result<String, String> {
    invalidate_repo_state(&path);
    run_git(&["push"], &path)
}

#[tauri::command]
pub fn git_init(path: String) -> Result<String, String> {
    invalidate_repo_state(&path);
    run_git(&["init"], &path)
}

#[tauri::command]
pub fn git_fetch(path: String) -> Result<String, String> {
    invalidate_repo_state(&path);
    run_git(&["fetch", "--quiet"], &path)
}

/// Parsea la cabecera `## main...origin/main [ahead 2, behind 1]` de
/// `git status --branch` en (branch, remote, ahead, behind).
fn parse_branch_header(rest: &str) -> (Option<String>, Option<String>, u32, u32) {
    // e.g. "main...origin/main [ahead 2, behind 1]" or "main" or "HEAD (no branch)"
    let (tracking, counts) = match rest.find(" [") {
        Some(idx) => (&rest[..idx], Some(&rest[idx + 2..rest.len() - 1])),
        None => (rest, None),
    };
    let (branch, remote) = match tracking.split_once("...") {
        Some((b, r)) => (Some(b.to_string()), Some(r.to_string())),
        None => (
            Some(tracking.replace("No commits yet on ", "")),
            None::<String>,
        ),
    };
    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Some(counts_str) = counts {
        for part in counts_str.split(", ") {
            if let Some(n) = part.strip_prefix("ahead ") {
                ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("behind ") {
                behind = n.parse().unwrap_or(0);
            }
        }
    }
    (branch, remote, ahead, behind)
}

/// Parsea una línea `XY path` de `--porcelain=v1`. `None` si no es una línea de
/// archivo (cabecera de rama, línea vacía o demasiado corta).
fn parse_change_line(line: &str) -> Option<GitFileChange> {
    // Los 3 primeros bytes de porcelain=v1 son ASCII (dos codigos de estado y
    // un espacio). Se leen como bytes para no depender de limites de char: la
    // RUTA si puede ser UTF-8 multibyte.
    let bytes = line.as_bytes();
    if bytes.len() < 4 || !bytes[..3].is_ascii() || line.starts_with("##") {
        return None;
    }
    let x = &line[0..1];
    let y = &line[1..2];
    let rest = line[3..].trim_end_matches('\r');
    // Renames look like "old -> new"; show the destination path. Solo cuando el
    // estado ES un rename: un archivo llamado "a -> b.txt" no es un rename y
    // antes se mostraba cortado por el " -> ".
    let is_rename = x == "R" || y == "R";
    let disp = match rest.split_once(" -> ") {
        Some((_, new)) if is_rename => new.to_string(),
        _ => rest.to_string(),
    };
    if disp.is_empty() {
        return None;
    }
    Some(GitFileChange {
        path: disp,
        index_status: x.to_string(),
        worktree_status: y.to_string(),
        untracked: x == "?",
        staged: x != " " && x != "?",
    })
}

/// Parsea la salida COMPLETA de `status --short --branch --porcelain=v1` en el
/// estado del repo + la lista de archivos cambiados. Un solo `git` cubre las dos
/// mitades del panel (antes eran dos procesos con la misma información).
fn parse_status(raw: &str, path: &str) -> (GitRepoState, Vec<GitFileChange>) {
    let mut header = (None, None, 0u32, 0u32);
    let mut changes = Vec::new();
    for line in raw.split('\n') {
        match line.strip_prefix("## ") {
            Some(rest) => header = parse_branch_header(rest.trim_end_matches('\r')),
            None => {
                if let Some(c) = parse_change_line(line) {
                    changes.push(c);
                }
            }
        }
    }
    let (branch, remote, ahead, behind) = header;
    let dirty_count = changes.len() as u32;
    let state = GitRepoState {
        is_repo: true,
        branch,
        remote,
        ahead,
        behind,
        dirty: dirty_count > 0,
        dirty_count,
        path: path.to_string(),
    };
    (state, changes)
}

/// Estado del repo sin abrir git: usado cuando `path` no es un repositorio.
fn empty_repo_state(path: &str) -> GitRepoState {
    GitRepoState {
        is_repo: false,
        branch: None,
        remote: None,
        ahead: 0,
        behind: 0,
        dirty: false,
        dirty_count: 0,
        path: path.to_string(),
    }
}

fn is_repo(path: &str) -> bool {
    std::path::Path::new(path).join(".git").exists()
}

/// Lee el estado + los cambios con UN solo `git status`, y cachea el estado.
fn read_status(path: &str) -> Result<(GitRepoState, Vec<GitFileChange>), String> {
    if !is_repo(path) {
        return Ok((empty_repo_state(path), Vec::new()));
    }
    let raw = git_stdout(&["status", "--short", "--branch", "--porcelain=v1"], path)?;
    let (state, changes) = parse_status(&raw, path);
    if let Ok(mut cache) = repo_state_cache().lock() {
        cache.insert(path.to_string(), (Instant::now(), state.clone()));
    }
    Ok((state, changes))
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
    Ok(read_status(&path)?.0)
}

/// Estado + archivos cambiados en UNA llamada. El modal los pedía por separado
/// (`git_repo_state` + `git_changes`): dos IPC y dos `git status` para la misma
/// información. Aquí es un proceso git y un round-trip.
#[derive(serde::Serialize)]
pub struct GitRepoSnapshot {
    pub state: GitRepoState,
    pub changes: Vec<GitFileChange>,
}

#[tauri::command]
pub fn git_repo_snapshot(path: String) -> Result<GitRepoSnapshot, String> {
    let (state, changes) = read_status(&path)?;
    Ok(GitRepoSnapshot { state, changes })
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
    let out = git_command(args, cwd)
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

/// Unified diff for a single file. `staged=true` shows the index-vs-HEAD diff;
/// otherwise the worktree diff (falling back to a full --no-index diff for
/// untracked files, where `git diff` would print nothing).
#[tauri::command]
pub fn git_diff_file(path: String, file: String, staged: bool) -> Result<String, String> {
    if staged {
        return Ok(cap_diff(git_stdout(
            &["diff", "--cached", "--", &file],
            &path,
        )?));
    }
    let d = git_stdout(&["diff", "--", &file], &path)?;
    if d.trim().is_empty() {
        // Likely untracked — show the whole file as additions. `/dev/null` es
        // válido también en Git for Windows (verificado en runtime).
        return Ok(cap_diff(git_stdout(
            &["diff", "--no-index", "--", "/dev/null", &file],
            &path,
        )?));
    }
    Ok(cap_diff(d))
}

/// Máximo de líneas de diff que cruzan el IPC y llegan al DOM. Un diff de
/// decenas de miles de líneas congelaba el modal (una fila por línea).
const MAX_DIFF_LINES: usize = 2_000;

/// Recorta el diff a `MAX_DIFF_LINES` dejando constancia explícita del corte
/// (nunca truncar en silencio).
fn cap_diff(diff: String) -> String {
    let lines: Vec<&str> = diff.split('\n').collect();
    let total = lines.len();
    if total <= MAX_DIFF_LINES {
        return diff;
    }
    let head = &lines[..MAX_DIFF_LINES];
    format!(
        "{}\n\n… diff recortado: {} de {} líneas. Abre el archivo en el IDE para verlo entero.",
        head.join("\n"),
        MAX_DIFF_LINES,
        total
    )
}

/// Stage files. Empty list = stage everything (`git add -A`).
#[tauri::command]
pub fn git_stage(path: String, files: Vec<String>) -> Result<String, String> {
    invalidate_repo_state(&path);
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
    invalidate_repo_state(&path);
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
    invalidate_repo_state(&path);
    run_git(&["commit", "-m", &message], &path)
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
    let out = Command::new("codegraph")
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

    #[test]
    fn invalidate_repo_state_borra_la_entrada() {
        let key = "___kirkardo_git_cache_invalidate___".to_string();
        let st = GitRepoState {
            is_repo: true,
            branch: Some("main".to_string()),
            remote: None,
            ahead: 0,
            behind: 0,
            dirty: false,
            dirty_count: 0,
            path: key.clone(),
        };
        repo_state_cache()
            .lock()
            .unwrap()
            .insert(key.clone(), (Instant::now(), st));
        invalidate_repo_state(&key);
        assert!(
            repo_state_cache().lock().unwrap().get(&key).is_none(),
            "tras una escritura el estado cacheado no debe sobrevivir"
        );
    }

    #[test]
    fn parse_status_separa_estado_y_archivos_de_una_sola_salida() {
        // Salida real de `git status --short --branch --porcelain=v1`.
        // Sin continuaciones de linea: '\' en un literal Rust se come el
        // espacio inicial de la siguiente, y en porcelain ese espacio ES el
        // estado del indice.
        let raw = concat!(
            "## main...origin/main [ahead 2, behind 1]\n",
            "M  src/a.rs\n",
            " M src/b.rs\n",
            "?? nuevo.txt\n",
            "R  viejo.rs -> nuevo.rs\n"
        );
        let (state, changes) = parse_status(raw, "C:/repo");

        assert_eq!(state.branch.as_deref(), Some("main"));
        assert_eq!(state.remote.as_deref(), Some("origin/main"));
        assert_eq!((state.ahead, state.behind), (2, 1));
        assert_eq!(state.dirty_count, 4, "la cabecera no cuenta como cambio");
        assert!(state.dirty);

        assert_eq!(changes.len(), 4);
        assert!(changes[0].staged, "'M ' = cambio en el indice");
        assert!(!changes[1].staged, "' M' = solo en el worktree");
        assert!(
            changes[2].untracked && !changes[2].staged,
            "'??' = untracked"
        );
        assert_eq!(changes[3].path, "nuevo.rs", "el rename muestra el destino");
    }

    #[test]
    fn parse_status_sin_remoto_ni_cambios() {
        let (state, changes) = parse_status("## main\n", "C:/repo");
        assert_eq!(state.branch.as_deref(), Some("main"));
        assert!(state.remote.is_none(), "sin '...' no hay remoto");
        assert!(!state.dirty && changes.is_empty());
    }

    #[test]
    fn parse_change_line_rechaza_lo_que_no_es_un_archivo() {
        // Caso negativo: cabecera, linea vacia y linea corta no son cambios.
        assert!(parse_change_line("## main...origin/main").is_none());
        assert!(parse_change_line("").is_none());
        assert!(parse_change_line("M").is_none());
        assert!(
            parse_change_line("M  ").is_none(),
            "ruta vacia -> no es cambio"
        );
    }

    #[test]
    fn parse_change_line_solo_parte_por_flecha_si_es_un_rename() {
        let rename = parse_change_line("R  viejo.rs -> nuevo.rs").expect("rename valido");
        assert_eq!(rename.path, "nuevo.rs", "R -> se queda el destino");

        // Un archivo cuyo NOMBRE contiene " -> " no es un rename.
        let raro = parse_change_line("?? a -> b.txt").expect("untracked valido");
        assert_eq!(raro.path, "a -> b.txt", "el nombre no se parte");
    }

    #[test]
    fn parse_change_line_acepta_rutas_utf8_multibyte() {
        let c = parse_change_line(" M src/año/ñandú.rs").expect("ruta multibyte valida");
        assert_eq!(c.path, "src/año/ñandú.rs");
        assert!(!c.staged, "' M' = solo worktree");
    }

    #[test]
    fn cap_diff_recorta_y_lo_dice() {
        let corto = "a\nb\nc".to_string();
        assert_eq!(
            cap_diff(corto.clone()),
            corto,
            "por debajo del tope, intacto"
        );

        let largo = (0..MAX_DIFF_LINES + 500)
            .map(|i| format!("+linea {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let capped = cap_diff(largo);
        assert!(capped.contains("diff recortado"), "el corte se anuncia");
        assert!(
            capped.split('\n').count() < MAX_DIFF_LINES + 500,
            "el diff recortado es mas corto que el original"
        );
    }
}
