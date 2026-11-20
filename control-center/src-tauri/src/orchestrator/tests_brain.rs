// orchestrator/tests_brain.rs — brain.db temporal para los tests del orquestador.
//
// Fichero hermano de `tests.rs` (límite de 800 líneas), incluido con
// `#[path]` como `engine_stages.rs` en recall_unified.

use super::super::orchestrate::orchestrate as real_orchestrate;
use super::super::types_model::OrchestrationContext;
use crate::memory::sqlite_store as store;

/// `brain.db` temporal para los tests que llaman a `orchestrate()`.
///
/// `orchestrate()` hace un recall `Live` (evento Retrieved y `touch_injected`
/// de lo inyectado) y `open_conn` aplica el esquema: contra la base del HOME,
/// cada `cargo test` subía `access_count`/`last_accessed_at` de items reales y
/// falseaba el decaimiento del GC, y el resultado dependía de la memoria
/// personal. La guarda apunta `ULTRON_BRAIN_DB` a una base vacía en un
/// directorio temporal mientras vive. La variable es global del proceso, así que
/// la guarda serializa a sus usuarios con un mutex y restaura el valor previo
/// al soltarse.
struct HermeticBrain {
    _lock: std::sync::MutexGuard<'static, ()>,
    dir: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
}

impl HermeticBrain {
    fn new() -> Self {
        static BRAIN_ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let lock = BRAIN_ENV_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::tempdir().expect("directorio temporal para brain.db");
        let previous = std::env::var_os(store::BRAIN_DB_ENV);
        std::env::set_var(store::BRAIN_DB_ENV, dir.path().join("brain.db"));
        Self {
            _lock: lock,
            dir,
            previous,
        }
    }

    fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("brain.db")
    }

    /// Eventos `retrieved` registrados en la base temporal.
    fn retrieved_events(&self) -> i64 {
        let conn = rusqlite::Connection::open(self.path()).expect("abrir la brain.db temporal");
        conn.query_row(
            "SELECT COUNT(*) FROM memory_events WHERE event_type = 'retrieved'",
            [],
            |r| r.get(0),
        )
        .expect("contar eventos retrieved")
    }
}

impl Drop for HermeticBrain {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(v) => std::env::set_var(store::BRAIN_DB_ENV, v),
            None => std::env::remove_var(store::BRAIN_DB_ENV),
        }
    }
}

/// `orchestrate()` contra la `brain.db` temporal de [`HermeticBrain`].
pub(super) fn orchestrate(prompt: &str, project_id: Option<&str>) -> OrchestrationContext {
    let _brain = HermeticBrain::new();
    real_orchestrate(prompt, project_id)
}

/// Caso negativo del hallazgo 16 (auditoría 2026-11-08): el recall de un test
/// no puede tocar la `brain.db` del HOME. La ruta efectiva tiene que ser la
/// temporal y el evento Retrieved del recall `Live` tiene que aterrizar en ella.
#[test]
fn el_recall_de_los_tests_no_toca_la_brain_db_del_home() {
    let brain = HermeticBrain::new();
    let efectiva = store::brain_db_override(std::env::var_os(store::BRAIN_DB_ENV))
        .expect("ULTRON_BRAIN_DB tiene que estar fijada");
    assert_eq!(efectiva, brain.path());
    let home_db = dirs::home_dir().map(|h| h.join(".ultron").join("brain.db"));
    assert_ne!(
        Some(efectiva),
        home_db,
        "el test apunta a la brain.db del HOME"
    );

    let ctx = real_orchestrate("arregla el test roto del build de la app", None);
    assert!(
        !ctx.warnings
            .iter()
            .any(|w| w.starts_with("recall unavailable")),
        "el recall tiene que correr contra la base temporal: {:?}",
        ctx.warnings
    );
    assert!(
        brain.retrieved_events() >= 1,
        "el evento Retrieved del recall no llegó a la brain.db temporal"
    );
}
