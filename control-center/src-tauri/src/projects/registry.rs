// projects/registry.rs — Registry I/O helpers: load, atomic write, path helpers.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use crate::file_lock::{FileLock, LOCK_STALE, LOCK_TIMEOUT};

// ---------------------------------------------------------------------------
// Process-wide write lock
// ---------------------------------------------------------------------------
//
// Every mutator does a load-all -> modify -> atomic_write cycle. Without a
// lock, two concurrent Tauri commands (e.g. `create_project` racing with
// `update_project`) both read the same baseline and the second writer
// clobbers the first writer's change — silent data loss. The lock is held
// across the whole read-modify-write so the operation is atomic from the
// caller's point of view. Same pattern as `sessions_tags::SESSIONS_TAGS_WRITE_LOCK`.
// Pure reads (`list_projects_inner`, `load_items_for`)
// are excluded intentionally.
//
// The Mutex only covers this process. The Node CLIs (`scripts/project-new.mjs`,
// `project-socratic.mjs`, `project-remove.mjs`, through
// `scripts/lib/projects-registry.mjs`) also rewrite projects.json, so every
// mutator goes through `lock_registry`, which adds the cross-process file lock
// `projects.json.lock` (`crate::file_lock`, same protocol as the kanban;
// auditoría 2026-11-08, #12).
static PROJECTS_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn projects_lock() -> &'static Mutex<()> {
    PROJECTS_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

/// Guardia de escritura del registro: el Mutex del proceso (hilos de la app) y
/// el lock de fichero `projects.json.lock` (otros procesos: los CLI de
/// `scripts/`). Orden fijo, Mutex y luego fichero, igual que
/// `kanban::board_io::lock_board`. Los campos se sueltan en orden de
/// declaración: primero el fichero y después el Mutex.
pub(crate) struct RegistryWriteGuard {
    _file: FileLock,
    _mutex: MutexGuard<'static, ()>,
}

/// Toma la guardia de escritura de `registry`. Todo leer-modificar-escribir de
/// projects.json va dentro de ella; si el lock de fichero no llega en el plazo,
/// error explícito y no se escribe nada.
pub(crate) fn lock_registry(registry: &Path) -> Result<RegistryWriteGuard, String> {
    lock_registry_with(registry, LOCK_TIMEOUT, LOCK_STALE)
}

/// `lock_registry` con plazos explícitos (los tests los acortan).
pub(crate) fn lock_registry_with(
    registry: &Path,
    timeout: Duration,
    stale: Duration,
) -> Result<RegistryWriteGuard, String> {
    let mutex = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {e}"))?;
    let file = FileLock::acquire_with(registry, timeout, stale)?;
    Ok(RegistryWriteGuard {
        _file: file,
        _mutex: mutex,
    })
}

/// Ruta de projects.json o error si no hay HOME.
pub(crate) fn require_registry_path() -> Result<PathBuf, String> {
    registry_path().ok_or_else(|| "no HOME".to_string())
}

pub(crate) fn registry_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/cockpit/projects.json"))
}

/// Path to the Python project launcher (scripts/cockpit/launch_project.py).
/// v15.4: replaces the legacy `ultron.ps1 open <id>` hop.
pub(crate) fn launch_project_py_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/scripts/cockpit/launch_project.py"))
}

/// Tmp-file + rename atomic write. Used everywhere we touch projects.json
/// so a crash between two writes never leaves the registry truncated.
pub(crate) fn atomic_write(registry: &PathBuf, content: &str) -> Result<(), String> {
    let tmp = registry.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, registry).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

pub(crate) fn load_registry_mut() -> Result<(PathBuf, serde_json::Value), String> {
    let registry = require_registry_path()?;
    let root = load_registry_at(&registry)?;
    Ok((registry, root))
}

/// Lee y parsea `registry`. Los mutadores lo llaman con `lock_registry` tomado.
pub(crate) fn load_registry_at(registry: &Path) -> Result<serde_json::Value, String> {
    let raw =
        std::fs::read_to_string(registry).map_err(|e| format!("read projects.json: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))
}

pub(crate) fn find_entry_mut<'a>(
    root: &'a mut serde_json::Value,
    id: &str,
) -> Result<&'a mut serde_json::Value, String> {
    let projects = root
        .get_mut("projects")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "projects.json has no projects[]".to_string())?;
    projects
        .iter_mut()
        .find(|v| v.get("id").and_then(|x| x.as_str()) == Some(id))
        .ok_or_else(|| format!("project '{}' not found", id))
}

/// CC-08 hardening: defensive sanity check before a path string is
/// interpolated into a PowerShell `-Command` argument. PowerShell
/// single-quoted strings are *literal* (so `;`, `` ` ``, `$`, `&`, `|`
/// inside them don't dispatch), but a malformed projects.json that
/// somehow contains a NUL byte, embedded newline, or path-traversal
/// segment is still pathological — we reject it instead of hoping PS
/// does the right thing.
pub(crate) fn path_ps_safe(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("path is empty".into());
    }
    // Any control char (NUL / CR / LF / etc) is automatic-reject — they
    // would let the path break out of the single-quoted PS payload.
    if path.chars().any(|c| c.is_control()) {
        return Err("path contains control characters".into());
    }
    // Path-traversal sentinel — projects.json must hold canonical
    // absolute paths, not relative `..\..\..` chains.
    if path.contains("..\\") || path.contains("../") {
        return Err("path traversal segments are not allowed".into());
    }
    Ok(())
}

/// Slugify a free-form name into a registry-safe id.
pub(crate) fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_registry() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let registry = tmp.path().join("projects.json");
        fs::write(&registry, r#"{"projects":[]}"#).expect("registro");
        (tmp, registry)
    }

    /// El cerrojo es `projects.json.lock`, el mismo fichero que crean los CLI de
    /// Node (`scripts/lib/projects-registry.mjs`), y se libera al soltarse.
    #[test]
    fn lock_registry_usa_projects_json_lock_y_lo_libera() {
        let (_tmp, registry) = temp_registry();
        let lock = registry.with_file_name("projects.json.lock");
        {
            let _g = lock_registry(&registry).expect("lock libre");
            assert!(lock.exists(), "el .lock existe mientras se sostiene");
        }
        assert!(!lock.exists(), "soltar la guardia borra el .lock");
    }

    /// Caso negativo: un lock vivo de otro proceso agota el plazo con error.
    #[test]
    fn lock_registry_con_lock_vivo_ajeno_falla_con_error() {
        let (_tmp, registry) = temp_registry();
        let lock = registry.with_file_name("projects.json.lock");
        fs::write(&lock, r#"{"pid":0,"token":"ajeno"}"#).expect("lock ajeno");
        let err = lock_registry_with(&registry, Duration::from_millis(150), LOCK_STALE)
            .err()
            .expect("no debe adquirir un lock vivo ajeno");
        assert!(err.contains("projects.json bloqueado"), "{err}");
        assert!(lock.exists(), "no borra el lock ajeno");
    }

    /// Un lock huérfano (proceso muerto, mtime de hace más de `LOCK_STALE`) no
    /// bloquea para siempre: se rompe y se adquiere.
    #[test]
    fn lock_registry_rompe_un_lock_huerfano() {
        let (_tmp, registry) = temp_registry();
        let lock = registry.with_file_name("projects.json.lock");
        let f = fs::File::create(&lock).expect("lock huérfano");
        f.set_modified(std::time::SystemTime::now() - Duration::from_secs(20))
            .expect("mtime");
        drop(f);
        let _g = lock_registry_with(&registry, Duration::from_millis(300), LOCK_STALE)
            .expect("un lock de 20 s es rancio y se rompe");
    }
}
