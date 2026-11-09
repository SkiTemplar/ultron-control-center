// pty/registry.rs — Registro global de PTY vivos.
//
// El mapa solo guarda `Arc<PtySession>`: se bloquea para buscar, insertar o
// quitar, y la operación sigue sobre el `Arc` clonado fuera del lock
// (`SC-08`, `seguridad-robustez:F3`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use super::types::{bloquear, PtySession};

type Mapa = HashMap<String, Arc<PtySession>>;

fn registry() -> &'static Mutex<Mapa> {
    static SESSIONS: OnceLock<Mutex<Mapa>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mapa() -> MutexGuard<'static, Mapa> {
    bloquear(registry())
}

/// Sesión `id`, clonada fuera del lock.
pub fn get(id: &str) -> Result<Arc<PtySession>, String> {
    mapa()
        .get(id)
        .cloned()
        .ok_or_else(|| format!("no existe el PTY '{id}'"))
}

pub(super) fn insert(s: Arc<PtySession>) {
    mapa().insert(s.id.clone(), s);
}

/// Saca la entrada del mapa; el llamador la suelta fuera del lock.
pub(super) fn remove(id: &str) -> Option<Arc<PtySession>> {
    mapa().remove(id)
}

pub(super) fn todas() -> Vec<Arc<PtySession>> {
    mapa().values().cloned().collect()
}

pub(crate) fn new_ulid() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    format!("pty-{t}-{n}")
}

/// PTY sin proceso para pruebas: un escritor sobre `w` con la vista `fuente`.
#[cfg(test)]
pub(crate) fn insertar_prueba(
    id: &str,
    w: Box<dyn std::io::Write + Send>,
    fuente: super::escritor::FuenteVista,
) -> Arc<PtySession> {
    use super::types::{PtyStatus, Salida};
    let escritor = super::escritor::Escritor::lanzar(id, w, fuente).expect("escritor de prueba");
    let s = Arc::new(PtySession {
        id: id.to_string(),
        provider: "test".into(),
        estado: Mutex::new(PtyStatus::Running),
        salida: Mutex::new(Salida::default()),
        live_event: None,
        escritor,
        master: Mutex::new(None),
        killer: Mutex::new(None),
        arbol: Mutex::new(None),
    });
    insert(s.clone());
    s
}

/// Mata el árbol de todos los PTY vivos (cierre de la app).
pub fn kill_all_inner() {
    for s in todas() {
        if let Err(e) = super::salida::matar(&s) {
            tracing::warn!(pty = %s.id, error = %e, "no se pudo matar el PTY al cerrar");
        }
    }
}
