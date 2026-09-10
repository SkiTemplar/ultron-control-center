//! Concurrencia de las peticiones pesadas: cuántas se sirven a la vez contra el
//! modelo residente y cuánto se espera por un hueco antes de responder "busy".

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// Espera máxima por el lock global de orchestrate (audit 2026-08-09): un
/// request colgado (p.ej. Qdrant zombi) encolaba a TODOS los hooks detrás del
/// Mutex sin límite — cada prompt pagaba ~9.2s para recibir contexto vacío.
/// Pasado este plazo el daemon responde "busy" y el hook degrada en local.
pub(super) const ORCH_LOCK_WAIT: Duration = Duration::from_millis(2500);
/// Peticiones pesadas (orchestrate/skill_query) servidas A LA VEZ. Antes era un
/// `Mutex<()>`: UNA sola, por precaución ante "concurrent SQLite/ONNX", nunca
/// medida. Ambas premisas se verificaron falsas el 2026-08-22:
///
/// - E5 vive en un `static RwLock<Option<TextEmbedding>>` y `embed_e5` toma el
///   lock en modo LECTURA — el compilador ya exige `TextEmbedding: Sync`, así
///   que N hilos pueden embeber contra el MISMO modelo residente.
/// - brain.db está en `journal_mode=wal` (verificado): lectores concurrentes
///   + un escritor, con busy_timeout para el que escribe.
///
/// Serializar de más tenía coste real: con varias sesiones abiertas, cada una
/// esperaba su turno, recibía "busy" y lanzaba un proceso one-shot que cargaba
/// OTRA copia del modelo (15s medidos, 5/5 prompts sin memoria).
/// Un semáforo en vez de barra libre: el modelo es único y compartido, pero
/// cada inferencia concurrente sí consume CPU y buffers. Configurable por
/// `ULTRON_ORCH_CONCURRENCY`.
/// 4 -> 2 (2026-09-07, decidido por el usuario tras medir): cada hilo de
/// inferencia concurrente deja su arena de ONNX residente — 4 orchestrates a la
/// vez subieron el daemon de 3.582 a 4.131 MB y ahí se quedó. Dos plazas
/// cubren el uso real (una sesión activa y otra de fondo); una tercera sesión
/// simultánea recibe "busy" y el hook reintenta 6 s contra el mismo daemon.
const ORCH_CONCURRENCY_DEFAULT: usize = 2;

/// Semáforo contado sobre `std` (sin dependencias nuevas): admite `n` titulares
/// a la vez y libera el permiso al soltar el guard.
pub(super) struct Semaforo {
    permisos: Mutex<usize>,
    hay_hueco: Condvar,
}

/// Permiso vivo. Al soltarse devuelve su hueco y despierta a UN esperante.
pub(super) struct PermisoSemaforo<'a> {
    sem: &'a Semaforo,
}

impl Semaforo {
    pub(super) fn nuevo(n: usize) -> Self {
        Self {
            permisos: Mutex::new(n.max(1)),
            hay_hueco: Condvar::new(),
        }
    }

    /// Toma un permiso esperando como mucho `max_wait`. `None` = sin hueco a
    /// tiempo (el llamante responde "busy" y el hook degrada sin spawnear).
    pub(super) fn adquirir(&self, max_wait: Duration) -> Option<PermisoSemaforo<'_>> {
        let deadline = Instant::now() + max_wait;
        let mut libres = self
            .permisos
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while *libres == 0 {
            let restante = deadline.checked_duration_since(Instant::now())?;
            let (siguiente, espera) = self
                .hay_hueco
                .wait_timeout(libres, restante)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            libres = siguiente;
            if espera.timed_out() && *libres == 0 {
                return None;
            }
        }
        *libres -= 1;
        Some(PermisoSemaforo { sem: self })
    }
}

impl Drop for PermisoSemaforo<'_> {
    fn drop(&mut self) {
        let mut libres = self
            .sem
            .permisos
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *libres += 1;
        self.sem.hay_hueco.notify_one();
    }
}

/// Cuántas peticiones pesadas se sirven a la vez (`ULTRON_ORCH_CONCURRENCY`).
pub(super) fn orch_concurrency() -> usize {
    std::env::var("ULTRON_ORCH_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(ORCH_CONCURRENCY_DEFAULT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semaforo_admite_varios_titulares_a_la_vez() {
        // El punto del cambio: N peticiones pesadas simultáneas, no una.
        let sem = Semaforo::nuevo(3);
        let a = sem.adquirir(Duration::from_millis(50));
        let b = sem.adquirir(Duration::from_millis(50));
        let c = sem.adquirir(Duration::from_millis(50));
        assert!(
            a.is_some() && b.is_some() && c.is_some(),
            "3 plazas, 3 permisos"
        );
    }

    #[test]
    fn semaforo_agotado_responde_none_sin_colgarse() {
        let sem = Semaforo::nuevo(1);
        let _ocupado = sem
            .adquirir(Duration::from_millis(50))
            .expect("primer permiso");
        let t0 = Instant::now();
        assert!(
            sem.adquirir(Duration::from_millis(80)).is_none(),
            "sin plazas libres debe rendirse, no bloquear para siempre"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(2),
            "la espera está acotada"
        );
    }

    #[test]
    fn semaforo_devuelve_el_hueco_al_soltar_el_permiso() {
        let sem = Semaforo::nuevo(1);
        {
            let _p = sem
                .adquirir(Duration::from_millis(50))
                .expect("permiso inicial");
        } // Drop -> hueco devuelto
        assert!(
            sem.adquirir(Duration::from_millis(50)).is_some(),
            "el permiso soltado debe volver al pool"
        );
    }

    #[test]
    fn semaforo_nunca_tiene_cero_plazas() {
        // Un 0 mal configurado dejaría el daemon incapaz de servir nada.
        let sem = Semaforo::nuevo(0);
        assert!(sem.adquirir(Duration::from_millis(50)).is_some());
    }
}
