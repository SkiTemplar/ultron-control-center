// commands/projects/git_ops.rs — Git operations per project path.
//
// All commands take a `path` string (absolute dir) and run git
// in that directory. Returns stdout+stderr merged as String.
// Errors surface as Err(String) so the frontend shows them directly.
//
// Piezas:
//   * git_ops.rs           — lanzador de git con tope, escrituras, diff y log.
//   * git_ops/status.rs    — raíz del repo, `git status` y sus cachés.
//   * git_ops/codegraph.rs — índice de CodeGraph del proyecto.
//   * git_ops/publish.rs   — publicar un repo o una rama nueva (--set-upstream).

mod codegraph;
mod publish;
mod status;

pub use codegraph::*;
pub use publish::*;
pub use status::*;

use std::process::Command;
use std::time::Duration;

use status::{invalidate_repo_root, invalidate_repo_state, repo_root, work_dir};

/// `git` preparado para correr sin ventana de consola en Windows.
///
/// Sin `CREATE_NO_WINDOW` cada invocación crea (y destruye) una consola: coste
/// fijo por comando y parpadeo visible. El panel dispara varios comandos por
/// interacción, así que el coste se multiplica. Hoy `git_output` lo lanza por
/// `run_with_timeout`, que ya pone el flag; aquí se repite por si `git_command`
/// se usa algún día sin pasar por él.
///
/// `GIT_TERMINAL_PROMPT=0`: sin terminal no hay quien conteste a una pregunta
/// de usuario/contraseña, y git se quedaba esperando para siempre. Con la
/// variable falla en el acto con un mensaje que el panel enseña.
fn git_command(args: &[&str], cwd: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

// H22 (auditoría 2026-10-17): topes de git. Antes `.output()` sin límite en
// comandos síncronos: un `push` esperando credenciales (o el diálogo del
// gestor de credenciales) congelaba Control Center, Sessions y Pupus.
/// Operaciones locales (status, diff, log, add, reset, init).
const GIT_LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
/// pull/push/fetch: red y, si acaso, el diálogo del gestor de credenciales.
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(180);
/// commit: los hooks `pre-commit`/`commit-msg` del repo pueden tardar.
const GIT_COMMIT_TIMEOUT: Duration = Duration::from_secs(600);

/// Lanza git con tope de tiempo y traduce el fallo al arrancar o el tope a un
/// mensaje legible.
fn git_output(args: &[&str], cwd: &str, timeout: Duration) -> Result<std::process::Output, String> {
    // Sin esta comprobación, un `cwd` inexistente hace fallar el arranque con
    // `NotFound` y el mensaje culparía a git de no estar instalado.
    if cwd.trim().is_empty() || !std::path::Path::new(cwd).is_dir() {
        return Err(format!("la carpeta del repositorio no existe: {cwd}"));
    }
    crate::ai_router::exec::run_with_timeout(git_command(args, cwd), timeout, None)
        .map_err(|e| git_spawn_error(args, &e, timeout))
}

fn git_spawn_error(args: &[&str], e: &std::io::Error, timeout: Duration) -> String {
    let sub = args.first().copied().unwrap_or("git");
    match e.kind() {
        std::io::ErrorKind::NotFound => "git no está instalado o no está en el PATH".to_string(),
        std::io::ErrorKind::TimedOut => format!(
            "git {sub} superó el tope de {} s y se canceló (¿está pidiendo credenciales o un hook no termina?)",
            timeout.as_secs()
        ),
        _ => format!("no se pudo lanzar git {sub}: {e}"),
    }
}

/// Corre una operación de git fuera del hilo principal. Los comandos
/// síncronos de Tauri se ejecutan en el hilo principal: mientras git trabaja,
/// la ventana entera queda congelada.
async fn off_main_thread<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("git: la tarea se interrumpió: {e}"))?
}

/// Operación de escritura en la raíz del repo que contiene `path` (H7): las
/// rutas de `git status` son relativas a la raíz, así que stage/unstage/diff
/// deben correr allí aunque el proyecto esté registrado en una subcarpeta.
fn write_op(args: &[&str], path: &str, timeout: Duration) -> Result<String, String> {
    invalidate_repo_state(path);
    let cwd = work_dir(path)?;
    write_op_in(args, path, &cwd, timeout)
}

/// Invalida el estado cacheado de `key` antes y después de correr git en
/// `cwd`, para que un refresco del panel durante la operación no deje
/// cacheado el estado previo.
fn write_op_in(args: &[&str], key: &str, cwd: &str, timeout: Duration) -> Result<String, String> {
    invalidate_repo_state(key);
    let result = run_git_with(args, cwd, timeout);
    invalidate_repo_state(key);
    result
}

fn run_git_with(args: &[&str], cwd: &str, timeout: Duration) -> Result<String, String> {
    let out = git_output(args, cwd, timeout)?;
    git_outcome(
        out.status.success(),
        out.status.code(),
        &out.stdout,
        &out.stderr,
    )
}

/// Resultado de una orden de git. Solo cuenta el código de salida: antes una
/// orden fallida con algo en stdout (`commit` sin cambios, un `pull`
/// rechazado que imprime progreso) se daba por buena.
fn git_outcome(
    success: bool,
    code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(stdout);
    let stderr = String::from_utf8_lossy(stderr);
    let combined = format!("{stdout}{stderr}").trim().to_string();
    if success {
        Ok(if combined.is_empty() {
            "OK".to_string()
        } else {
            combined
        })
    } else {
        Err(if combined.is_empty() {
            format!("git exited with code {code:?}")
        } else {
            combined
        })
    }
}

#[tauri::command]
pub async fn git_pull(path: String) -> Result<String, String> {
    off_main_thread(move || write_op(&["pull", "--ff-only"], &path, GIT_NETWORK_TIMEOUT)).await
}

#[tauri::command]
pub async fn git_push(path: String) -> Result<String, String> {
    off_main_thread(move || write_op(&["push"], &path, GIT_NETWORK_TIMEOUT)).await
}

#[tauri::command]
pub async fn git_init(path: String) -> Result<String, String> {
    // `init` va en la carpeta pedida, no en la raíz de un repo que la contenga.
    off_main_thread(move || {
        let r = write_op_in(&["init"], &path, &path, GIT_LOCAL_TIMEOUT);
        invalidate_repo_root(&path);
        r
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(path: String) -> Result<String, String> {
    off_main_thread(move || write_op(&["fetch", "--quiet"], &path, GIT_NETWORK_TIMEOUT)).await
}

// ---------------------------------------------------------------------------
// Micro GitHub Desktop: changed files, per-file diff, stage/unstage, commit, log
// ---------------------------------------------------------------------------

/// Like `run_git` but returns RAW stdout (no trim, no stderr merge). Required for
/// `--porcelain` (leading spaces are significant) and diffs (leading context
/// spaces). `git diff` exits 1 when there ARE differences — that is not an error,
/// so a non-empty stdout is always treated as success.
fn git_stdout(args: &[&str], cwd: &str) -> Result<String, String> {
    let out = git_output(args, cwd, GIT_LOCAL_TIMEOUT)?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() || !stdout.is_empty() {
        Ok(stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Unified diff for a single file. `staged=true` shows the index-vs-HEAD diff;
/// otherwise the worktree diff (falling back to a full --no-index diff for
/// untracked files, where `git diff` would print nothing).
#[tauri::command]
pub async fn git_diff_file(path: String, file: String, staged: bool) -> Result<String, String> {
    off_main_thread(move || git_diff_file_blocking(path, file, staged)).await
}

fn git_diff_file_blocking(path: String, file: String, staged: bool) -> Result<String, String> {
    // `file` viene de `git status` en la raíz (H7): el diff corre allí.
    let path = work_dir(&path)?;
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
pub async fn git_stage(path: String, files: Vec<String>) -> Result<String, String> {
    off_main_thread(move || {
        let mut args: Vec<&str> = vec!["add"];
        if files.is_empty() {
            args.push("-A");
        } else {
            args.push("--");
            args.extend(files.iter().map(String::as_str));
        }
        write_op(&args, &path, GIT_LOCAL_TIMEOUT)
    })
    .await
}

/// Unstage files (keep working-tree changes). Empty list = unstage everything.
#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<String, String> {
    off_main_thread(move || {
        let mut args: Vec<&str> = vec!["reset", "-q"];
        if !files.is_empty() {
            args.push("--");
            args.extend(files.iter().map(String::as_str));
        }
        write_op(&args, &path, GIT_LOCAL_TIMEOUT)
    })
    .await
}

/// Commit the staged changes with `message`. Fails fast on an empty message.
#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("el mensaje de commit no puede estar vacío".to_string());
    }
    off_main_thread(move || write_op(&["commit", "-m", &message], &path, GIT_COMMIT_TIMEOUT)).await
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
pub async fn git_log_full(path: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    off_main_thread(move || git_log_full_blocking(path, limit)).await
}

fn git_log_full_blocking(path: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let Some(path) = repo_root(&path)? else {
        return Ok(Vec::new());
    };
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

#[cfg(test)]
mod tests {
    use super::status::{empty_repo_state, repo_state_cache};
    use super::*;
    use std::time::Instant;

    // H22: sin terminal, una pregunta de credenciales dejaba git colgado.
    #[test]
    fn git_command_desactiva_las_preguntas_por_terminal() {
        let cmd = git_command(&["push"], ".");
        let prompt = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("GIT_TERMINAL_PROMPT"))
            .and_then(|(_, v)| v);
        assert_eq!(prompt, Some(std::ffi::OsStr::new("0")));
    }

    #[test]
    fn git_spawn_error_distingue_tope_ausencia_y_otros() {
        let t = Duration::from_secs(180);
        let tope = std::io::Error::new(std::io::ErrorKind::TimedOut, "x");
        let msg = git_spawn_error(&["push"], &tope, t);
        assert!(msg.contains("git push") && msg.contains("180 s"), "{msg}");
        let falta = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(git_spawn_error(&["pull"], &falta, t).contains("PATH"));
        let otro = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "acceso denegado");
        let msg = git_spawn_error(&["fetch"], &otro, t);
        assert!(
            msg.contains("acceso denegado") && !msg.contains("PATH"),
            "{msg}"
        );
    }

    /// Caso negativo: una carpeta inexistente no se atribuye a «git no
    /// instalado», no lanza nada y aun así invalida el estado cacheado.
    #[test]
    fn write_op_en_carpeta_inexistente_falla_claro_e_invalida_la_cache() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let falta = tmp.path().join("no-existe").to_string_lossy().to_string();
        repo_state_cache()
            .lock()
            .unwrap()
            .insert(falta.clone(), (Instant::now(), empty_repo_state(&falta)));
        let err = write_op(&["push"], &falta, GIT_NETWORK_TIMEOUT).unwrap_err();
        assert!(err.contains("no existe"), "{err}");
        assert!(
            !err.contains("PATH"),
            "no culpa a la instalación de git: {err}"
        );
        assert!(repo_state_cache().lock().unwrap().get(&falta).is_none());
    }

    #[test]
    fn git_output_con_tope_devuelve_la_salida_real() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_string_lossy().to_string();
        let out = git_output(&["--version"], &dir, GIT_LOCAL_TIMEOUT).expect("git disponible");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("git version"));
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

    // Auditoría 2026-10-17 (T-errores): una orden fallida que escribe en
    // stdout se daba por buena («Pull OK» falso). Manda el código de salida.
    #[test]
    fn git_outcome_solo_mira_el_codigo_de_salida() {
        let err = git_outcome(false, Some(1), b"nothing to commit\n", b"").unwrap_err();
        assert_eq!(err, "nothing to commit");
        assert_eq!(
            git_outcome(false, Some(128), b"", b"").unwrap_err(),
            "git exited with code Some(128)"
        );
        assert_eq!(
            git_outcome(true, Some(0), b"Already up to date.\n", b"").unwrap(),
            "Already up to date."
        );
        assert_eq!(git_outcome(true, Some(0), b"", b"").unwrap(), "OK");
    }

    /// Caso real: `git commit` sin cambios sale con 1 y escribe en stdout.
    #[test]
    fn commit_sin_cambios_es_un_error() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let raiz = tmp.path().to_string_lossy().to_string();
        let init = git_output(&["init", "-q"], &raiz, GIT_LOCAL_TIMEOUT).expect("git init");
        assert!(init.status.success());
        let r = write_op_in(&["commit", "-m", "vacío"], &raiz, &raiz, GIT_LOCAL_TIMEOUT);
        assert!(r.is_err(), "commit sin cambios no puede devolver Ok: {r:?}");
    }
}
