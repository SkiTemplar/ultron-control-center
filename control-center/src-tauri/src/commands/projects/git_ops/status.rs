// commands/projects/git_ops/status.rs — Estado del repo para el panel.
//
// Raíz del repo (`rev-parse --show-toplevel`), un solo `git status` que
// alimenta estado y lista de cambios, y las dos cachés con TTL (estado y
// raíz) que evitan lanzar git en cada refresco del panel.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::{git_output, git_stdout, off_main_thread, GIT_LOCAL_TIMEOUT};

// 3.7: cache TTL de git_repo_state. El panel del repo refresca periodicamente;
// sin cache cada tick spawnea git.exe (`git_ops.rs`). TTL corto: dato fresco pero
// sin ráfagas de procesos en refrescos seguidos.
pub(super) const REPO_STATE_TTL: Duration = Duration::from_millis(1500);

/// path -> (instante de captura, estado). El instante da el TTL.
type RepoStateCache = HashMap<String, (Instant, GitRepoState)>;

pub(super) fn repo_state_cache() -> &'static Mutex<RepoStateCache> {
    static CACHE: OnceLock<Mutex<RepoStateCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Borra la entrada cacheada de `path`. Se llama tras cada operación de
/// escritura (stage/unstage/commit/pull/push/fetch): sin esto el panel podía
/// mostrar hasta `REPO_STATE_TTL` de estado viejo justo después de actuar.
pub(super) fn invalidate_repo_state(path: &str) {
    if let Ok(mut cache) = repo_state_cache().lock() {
        cache.remove(path);
    }
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

/// Parsea un registro `XY ruta` de `--porcelain=v1 -z`. Con `-z` la ruta llega
/// literal: sin comillas ni escapes octales (espacios, tildes, comillas) y sin
/// la flecha ` -> ` de los renombrados, que traen el origen en el registro
/// siguiente. `None` si el registro no es un fichero.
fn parse_change_record(record: &str) -> Option<GitFileChange> {
    // Los 3 primeros bytes son ASCII (dos códigos de estado y un espacio). Se
    // leen como bytes para no depender de límites de char: la RUTA sí puede ser
    // UTF-8 multibyte.
    let bytes = record.as_bytes();
    if bytes.len() < 4 || !bytes[..3].is_ascii() || record.starts_with("##") {
        return None;
    }
    let x = &record[0..1];
    let y = &record[1..2];
    Some(GitFileChange {
        path: record[3..].to_string(),
        index_status: x.to_string(),
        worktree_status: y.to_string(),
        untracked: x == "?",
        staged: x != " " && x != "?",
    })
}

/// Un renombrado o una copia traen la ruta de origen en el registro siguiente.
fn has_origin_record(change: &GitFileChange) -> bool {
    let is_rename_or_copy = |code: &str| code == "R" || code == "C";
    is_rename_or_copy(&change.index_status) || is_rename_or_copy(&change.worktree_status)
}

/// Parsea la salida COMPLETA de `status --branch --porcelain=v1 -z` en el estado
/// del repo + la lista de archivos cambiados. Un solo `git` cubre las dos mitades
/// del panel (antes eran dos procesos con la misma información).
fn parse_status(raw: &str, path: &str) -> (GitRepoState, Vec<GitFileChange>) {
    let mut header = (None, None, 0u32, 0u32);
    let mut changes = Vec::new();
    let mut records = raw.split('\0');
    while let Some(record) = records.next() {
        if let Some(rest) = record.strip_prefix("## ") {
            header = parse_branch_header(rest);
            continue;
        }
        let Some(change) = parse_change_record(record) else {
            continue;
        };
        if has_origin_record(&change) {
            // El origen no es un cambio aparte: sin saltarlo saldría como un
            // fichero más, o con un nombre partido si empieza por dos letras.
            records.next();
        }
        changes.push(change);
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
pub(super) fn empty_repo_state(path: &str) -> GitRepoState {
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

// H7 (auditoría 2026-10-17): la raíz del repo sale de `git rev-parse
// --show-toplevel`. Antes solo se miraba `<path>/.git`, y un proyecto
// registrado en una subcarpeta del repo (`control-center`, `mods`…) salía
// como «no es un repositorio». Se cachea también el «no es repo», con un TTL
// más largo que el del estado: la raíz casi nunca cambia y así un refresco
// del panel no lanza un git de más.
const REPO_ROOT_TTL: Duration = Duration::from_secs(30);

/// path pedido -> (instante, raíz del repo o `None` si no está en ninguno).
type RepoRootCache = HashMap<String, (Instant, Option<String>)>;

fn repo_root_cache() -> &'static Mutex<RepoRootCache> {
    static CACHE: OnceLock<Mutex<RepoRootCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn invalidate_repo_root(path: &str) {
    if let Ok(mut cache) = repo_root_cache().lock() {
        cache.remove(path);
    }
}

/// Raíz del repo que contiene `path`, o `None` si no está en ninguno (o la
/// carpeta no existe). Un fallo que no sea «no es un repo» es `Err`, para que
/// el panel enseñe el motivo en vez de afirmar algo falso.
pub(super) fn repo_root(path: &str) -> Result<Option<String>, String> {
    if let Ok(cache) = repo_root_cache().lock() {
        if let Some((ts, root)) = cache.get(path) {
            if ts.elapsed() < REPO_ROOT_TTL {
                return Ok(root.clone());
            }
        }
    }
    let root = resolve_repo_root(path)?;
    if let Ok(mut cache) = repo_root_cache().lock() {
        cache.insert(path.to_string(), (Instant::now(), root.clone()));
    }
    Ok(root)
}

fn resolve_repo_root(path: &str) -> Result<Option<String>, String> {
    if path.trim().is_empty() || !std::path::Path::new(path).is_dir() {
        return Ok(None);
    }
    let out = git_output(&["rev-parse", "--show-toplevel"], path, GIT_LOCAL_TIMEOUT)?;
    parse_toplevel(out.status.success(), &out.stdout, &out.stderr)
}

/// Interpreta la salida de `rev-parse --show-toplevel`. Un repo con dueño
/// distinto (`safe.directory`) no es «no es un repo»: es un error con su
/// mensaje. La clave de configuración no se traduce, el resto del texto sí.
fn parse_toplevel(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<Option<String>, String> {
    if !success {
        let err = String::from_utf8_lossy(stderr).trim().to_string();
        return if err.contains("safe.directory") {
            Err(err)
        } else {
            Ok(None)
        };
    }
    let raw = String::from_utf8_lossy(stdout).trim().to_string();
    if raw.is_empty() {
        return Ok(None);
    }
    // git devuelve `C:/a/b` también en Windows; la UI enseña rutas nativas.
    Ok(Some(if cfg!(windows) {
        raw.replace('/', "\\")
    } else {
        raw
    }))
}

/// Carpeta donde correr git para `path`: la raíz de su repo o, fuera de un
/// repo, la propia carpeta (git dará el error que toque).
pub(super) fn work_dir(path: &str) -> Result<String, String> {
    Ok(repo_root(path)?.unwrap_or_else(|| path.to_string()))
}

/// Lee el estado + los cambios con UN solo `git status`, y cachea el estado.
/// Corre en la raíz del repo: `state.path` dice de qué repo es el estado y
/// las rutas de los cambios son relativas a ella, como espera `git_diff_file`.
fn read_status(path: &str) -> Result<(GitRepoState, Vec<GitFileChange>), String> {
    let Some(root) = repo_root(path)? else {
        return Ok((empty_repo_state(path), Vec::new()));
    };
    let raw = git_stdout(&["status", "--branch", "--porcelain=v1", "-z"], &root)?;
    let (state, changes) = parse_status(&raw, &root);
    if let Ok(mut cache) = repo_state_cache().lock() {
        cache.insert(path.to_string(), (Instant::now(), state.clone()));
    }
    Ok((state, changes))
}

/// Returns a structured summary for the UI: branch, remote, ahead, behind, dirty.
/// Parses `git status --branch --porcelain=v1 -z` output.
#[tauri::command]
pub async fn git_repo_state(path: String) -> Result<GitRepoState, String> {
    off_main_thread(move || repo_state_blocking(&path)).await
}

fn repo_state_blocking(path: &str) -> Result<GitRepoState, String> {
    // 3.7: sirve el estado cacheado si es reciente (< TTL) para no spawnear git.exe
    // en cada refresh del panel.
    if let Ok(cache) = repo_state_cache().lock() {
        if let Some((ts, state)) = cache.get(path) {
            if ts.elapsed() < REPO_STATE_TTL {
                return Ok(state.clone());
            }
        }
    }
    Ok(read_status(path)?.0)
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
pub async fn git_repo_snapshot(path: String) -> Result<GitRepoSnapshot, String> {
    off_main_thread(move || repo_snapshot_blocking(&path)).await
}

/// Núcleo síncrono de [`git_repo_snapshot`] para los llamantes de Rust que ya
/// corren fuera del hilo principal (p. ej. `sesiones::mejorar::gather`). El
/// comando pasó a `async` (H22) y ya no se puede llamar sin `.await`.
pub(crate) fn repo_snapshot_blocking(path: &str) -> Result<GitRepoSnapshot, String> {
    let (state, changes) = read_status(path)?;
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

/// One changed file in the working tree, parsed from `git status --porcelain=v1 -z`.
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

#[cfg(test)]
mod tests {
    use super::super::{git_diff_file_blocking, git_log_full_blocking};
    use super::*;

    // H7: la raíz sale de `rev-parse`, no de buscar `<path>/.git`.
    #[test]
    fn parse_toplevel_distingue_repo_fuera_de_repo_y_error() {
        let raiz = parse_toplevel(true, b"C:/repo/raiz\n", b"").unwrap();
        let esperada = if cfg!(windows) {
            "C:\\repo\\raiz"
        } else {
            "C:/repo/raiz"
        };
        assert_eq!(raiz.as_deref(), Some(esperada));
        // Caso negativo: fuera de un repo no es un error, es «no es repo».
        let fuera = b"fatal: not a git repository (or any of the parent directories): .git\n";
        assert_eq!(parse_toplevel(false, b"", fuera), Ok(None));
        assert_eq!(parse_toplevel(true, b"  \n", b""), Ok(None));
        // Un repo de otro dueño no se disfraza de «no es un repositorio».
        let ajeno = b"fatal: detected dubious ownership in repository\n\tgit config --global --add safe.directory C:/x\n";
        let err = parse_toplevel(false, b"", ajeno).unwrap_err();
        assert!(err.contains("safe.directory"), "{err}");
    }

    #[test]
    fn una_subcarpeta_del_repo_resuelve_a_su_raiz() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let raiz = tmp.path().to_string_lossy().to_string();
        let init = git_output(&["init", "-q"], &raiz, GIT_LOCAL_TIMEOUT).expect("git init");
        assert!(init.status.success());
        let sub = tmp.path().join("control-center").join("src");
        std::fs::create_dir_all(&sub).expect("subcarpeta");
        let sub = sub.to_string_lossy().to_string();

        let resuelta = repo_root(&sub)
            .expect("rev-parse")
            .expect("está en un repo");
        let canon = |p: &str| std::fs::canonicalize(p).expect("canonicalize");
        assert_eq!(canon(&resuelta), canon(&raiz));

        let (state, _) = read_status(&sub).expect("status");
        assert!(
            state.is_repo,
            "la subcarpeta ya no dice «no es un repositorio»"
        );
        assert_eq!(
            canon(&state.path),
            canon(&raiz),
            "el estado dice de qué repo es"
        );
    }

    #[test]
    fn una_carpeta_fuera_de_un_repo_no_es_repo() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_string_lossy().to_string();
        assert_eq!(repo_root(&dir), Ok(None));
        let (state, changes) = read_status(&dir).expect("status");
        assert!(!state.is_repo && changes.is_empty());
        let falta = tmp.path().join("no-existe").to_string_lossy().to_string();
        assert_eq!(
            repo_root(&falta),
            Ok(None),
            "una carpeta inexistente no lanza git"
        );
        assert!(git_log_full_blocking(dir, Some(5)).expect("log").is_empty());
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
        // Salida real de `git status --branch --porcelain=v1 -z`: con -z el
        // renombrado es `R  destino\0origen\0`, al revés que sin -z.
        let raw = concat!(
            "## main...origin/main [ahead 2, behind 1]\0",
            "M  src/a.rs\0",
            " M src/b.rs\0",
            "?? nuevo.txt\0",
            "R  nuevo.rs\0viejo.rs\0"
        );
        let (state, changes) = parse_status(raw, "C:/repo");

        assert_eq!(state.branch.as_deref(), Some("main"));
        assert_eq!(state.remote.as_deref(), Some("origin/main"));
        assert_eq!((state.ahead, state.behind), (2, 1));
        assert_eq!(state.dirty_count, 4, "ni cabecera ni origen cuentan");
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
        let (state, changes) = parse_status("## main\0", "C:/repo");
        assert_eq!(state.branch.as_deref(), Some("main"));
        assert!(state.remote.is_none(), "sin '...' no hay remoto");
        assert!(!state.dirty && changes.is_empty());
    }

    #[test]
    fn parse_change_record_rechaza_lo_que_no_es_un_archivo() {
        // Caso negativo: cabecera, registro vacío y registro corto no son cambios.
        assert!(parse_change_record("## main...origin/main").is_none());
        assert!(parse_change_record("").is_none());
        assert!(parse_change_record("M").is_none());
        assert!(
            parse_change_record("M  ").is_none(),
            "ruta vacia -> no es cambio"
        );
    }

    #[test]
    fn parse_status_no_parte_un_nombre_con_flecha_ni_comillas() {
        // Con -z un nombre con ` -> ` o con comillas es un nombre, y solo un
        // estado R o C consume el registro siguiente.
        let raw = "?? a -> b.txt\0 M \"con comillas\".txt\0";
        let (_, changes) = parse_status(raw, "C:/repo");
        let rutas: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(rutas, ["a -> b.txt", "\"con comillas\".txt"]);
    }

    #[test]
    fn parse_status_salta_el_origen_de_renombrados_y_copias() {
        // Caso negativo del salto: `RM` y `C ` lo consumen; ` M` no. Un origen
        // que parece una línea de estado (`M  raro`) no se cuenta como cambio.
        let raw = "RM nuevo\0M  raro\0C  copia\0orig\0 M normal\0";
        let (state, changes) = parse_status(raw, "C:/repo");
        let rutas: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(rutas, ["nuevo", "copia", "normal"]);
        assert_eq!(state.dirty_count, 3);
    }

    /// Crea un repo temporal con un commit inicial de `viejo nombre.txt`.
    fn repo_con_commit() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_string_lossy().to_string();
        let git = |args: &[&str]| {
            let out = git_output(args, &dir, GIT_LOCAL_TIMEOUT).expect("git");
            assert!(out.status.success(), "{args:?}: {out:?}");
        };
        git(&["init", "-q"]);
        std::fs::write(tmp.path().join("viejo nombre.txt"), "uno\ndos\n").expect("fichero");
        git(&["add", "--all"]);
        git(&[
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-q",
            "-m",
            "inicial",
        ]);
        (tmp, dir)
    }

    // Reproducción del HIGH de la auditoría 2026-11-01: contra git real, sin
    // -z la ruta salía como `"a b.txt"` o con escapes octales, y ni `git add`
    // ni `git diff` la encontraban.
    #[test]
    fn rutas_con_espacios_tildes_y_renombrados_se_preparan_y_comparan() {
        let (tmp, dir) = repo_con_commit();
        std::fs::write(tmp.path().join("a b.txt"), "espacio\n").expect("fichero");
        std::fs::write(tmp.path().join("ñandú.txt"), "tilde\n").expect("fichero");
        let renombrar = git_output(
            &["mv", "viejo nombre.txt", "nuevo nombre.txt"],
            &dir,
            GIT_LOCAL_TIMEOUT,
        )
        .expect("git mv");
        assert!(renombrar.status.success());

        let (state, changes) = read_status(&dir).expect("status");
        let ruta_de = |p: &str| changes.iter().find(|c| c.path == p);
        assert_eq!(state.dirty_count, 3, "el origen no cuenta");
        assert!(ruta_de("a b.txt").is_some_and(|c| c.untracked));
        assert!(ruta_de("ñandú.txt").is_some_and(|c| c.untracked));
        let renombrado = ruta_de("nuevo nombre.txt").expect("destino del renombrado");
        assert_eq!(renombrado.index_status, "R");
        assert!(ruta_de("viejo nombre.txt").is_none(), "origen no listado");

        // Las rutas que devuelve el estado son las que aceptan add y diff.
        let diff = git_diff_file_blocking(dir.clone(), "ñandú.txt".into(), false).expect("diff");
        assert!(diff.contains("+tilde"), "{diff}");
        let add = git_output(
            &["add", "--", "a b.txt", "ñandú.txt"],
            &dir,
            GIT_LOCAL_TIMEOUT,
        )
        .expect("git add");
        assert!(add.status.success(), "{add:?}");

        let (_, changes) = read_status(&dir).expect("status");
        assert_eq!(changes.iter().filter(|c| c.staged).count(), 3);
        let diff = git_diff_file_blocking(dir.clone(), "a b.txt".into(), true).expect("diff");
        assert!(diff.contains("+espacio"), "{diff}");
    }
}
