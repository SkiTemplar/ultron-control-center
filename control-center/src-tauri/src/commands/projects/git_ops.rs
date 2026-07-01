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

fn run_git(args: &[&str], cwd: &str) -> Result<String, String> {
    let out = Command::new("git")
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
    let out = Command::new("git")
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
            Some((_, new)) => new.to_string(),
            None => rest.to_string(),
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
}
