// Resolución de las keys del router, sin depender del entorno heredado.
//
// Las sesiones de ULTRON quitan las keys del entorno de `claude`
// (`sesiones::lanzamiento::claves_excluidas`), sus hooks heredan ese entorno y
// `ultron-memory` solo carga `~/.ultron/.env`. Si las keys viven en
// `HKCU\Environment` (donde las guarda Settings > API Keys), el sidecar se
// quedaba sin ninguna: `route()` saltaba todos los proveedores y la captura de
// memoria del Stop terminaba en `router_error->skip`.
//
// Prioridad: entorno del proceso (que ya incluye `.env`, cargado sin pisar) y,
// solo para lo que falte, `HKCU\Environment`.
//
// Lo leído del registro se queda en esta caché privada del proceso: NUNCA pasa
// por `std::env::set_var`, así que no vuelve al entorno de `claude` ni lo
// heredan los procesos hijos del sidecar. La lectura es perezosa porque los
// subcomandos del hook que no enrutan (resume, orchestrate) no deben pagar un
// `reg query`, y caduca para que un daemon residente vea una key guardada
// después sin reiniciarse.

/// `name` en el entorno; si falta o está en blanco, `HKCU\Environment`. Un
/// valor en blanco sin alternativa se devuelve tal cual: el llamante lo trata
/// como placeholder, igual que antes.
pub(crate) fn resolve_key(name: &str) -> Option<String> {
    pick_key(std::env::var(name).ok(), || user_scope::lookup(name))
}

/// Núcleo puro de la prioridad: el registro solo se consulta si hace falta.
fn pick_key(env: Option<String>, user_scope: impl FnOnce() -> Option<String>) -> Option<String> {
    match env {
        Some(v) if !v.trim().is_empty() => Some(v),
        blank_or_missing => user_scope().or(blank_or_missing),
    }
}

#[cfg(not(test))]
mod user_scope {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// Antigüedad máxima de la copia en memoria.
    const CACHE_TTL: Duration = Duration::from_secs(300);
    const REG_TIMEOUT: Duration = Duration::from_secs(5);

    static CACHE: Mutex<Option<(Instant, HashMap<String, String>)>> = Mutex::new(None);

    pub(super) fn lookup(name: &str) -> Option<String> {
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = cache
            .as_ref()
            .is_some_and(|(read_at, _)| read_at.elapsed() < CACHE_TTL);
        if !fresh {
            *cache = Some((Instant::now(), read_registry()));
        }
        cache.as_ref().and_then(|(_, keys)| keys.get(name).cloned())
    }

    /// Variables permitidas de `HKCU\Environment` (`env_keys::parse_reg_query`).
    /// Sin ventana de consola y con plazo: lo lanza un hook. Un fallo se
    /// registra y deja la key como ausente: `route()` lo dirá en su error.
    #[cfg(windows)]
    fn read_registry() -> HashMap<String, String> {
        let mut cmd = std::process::Command::new("reg");
        cmd.args(["query", "HKCU\\Environment"]);
        match crate::ai_router::exec::run_with_timeout(cmd, REG_TIMEOUT, None) {
            Ok(out) if out.status.success() => {
                crate::env_keys::parse_reg_query(&String::from_utf8_lossy(&out.stdout))
            }
            Ok(out) => {
                tracing::warn!(code = ?out.status.code(), "reg query HKCU\\Environment ha fallado");
                HashMap::new()
            }
            Err(e) => {
                tracing::warn!(error = %e, "no se ha podido lanzar reg query");
                HashMap::new()
            }
        }
    }

    #[cfg(not(windows))]
    fn read_registry() -> HashMap<String, String> {
        let _ = REG_TIMEOUT;
        HashMap::new()
    }
}

/// En los tests el registro es un mapa simulado por hilo: nunca se lee el real.
#[cfg(test)]
mod user_scope {
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! {
        static SIMULATED: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    }

    pub(super) fn lookup(name: &str) -> Option<String> {
        SIMULATED.with(|s| s.borrow().get(name).cloned())
    }

    pub(super) fn set(name: &str, value: &str) {
        SIMULATED.with(|s| s.borrow_mut().insert(name.to_string(), value.to_string()));
    }

    pub(super) fn clear() {
        SIMULATED.with(|s| s.borrow_mut().clear());
    }
}

/// `HKCU\Environment` simulado mientras dure el guard.
#[cfg(test)]
pub(crate) struct SimulatedUserScope;

#[cfg(test)]
impl SimulatedUserScope {
    pub(crate) fn with(keys: &[(&str, &str)]) -> Self {
        for (name, value) in keys {
            user_scope::set(name, value);
        }
        SimulatedUserScope
    }
}

#[cfg(test)]
impl Drop for SimulatedUserScope {
    fn drop(&mut self) {
        user_scope::clear();
    }
}

#[cfg(test)]
#[path = "key_source_tests.rs"]
mod tests;
