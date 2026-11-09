// sesiones/puente_desecho.rs — Rechazos que no caben en la cola de los
// respondedores del puente (contrato de estabilidad, §6.1).
//
// Con los respondedores bloqueados por sus conexiones y su cola llena, el
// rechazo se responde en un hilo desechable, con tope de hilos vivos:
// responder o soltar la petición puede bloquear (ver `Rechazo`), pero solo a
// ese hilo, y el cliente recibe su respuesta en cuanto su conexión lo
// permita. Por encima del tope la petición se abandona sin soltarla (su
// conexión no recibe respuesta) y se cuenta: cada potencia de dos de
// abandonadas es un error en el log, para que una fuga que crece se vea.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use super::Rechazo;

/// Hilos desechables vivos como máximo.
pub(in crate::sesiones) const MAX_DESECHABLES: usize = 32;

/// Hilos desechables vivos y peticiones abandonadas desde el arranque.
#[derive(Default)]
pub(in crate::sesiones) struct Desechos {
    vivos: AtomicUsize,
    abandonadas: AtomicUsize,
}

/// Plaza de hilo desechable; se libera al soltarla.
pub(in crate::sesiones) struct PlazaDesecho(Arc<Desechos>);

impl Drop for PlazaDesecho {
    fn drop(&mut self) {
        self.0.vivos.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Desechos {
    /// Plaza para un hilo desechable, o `None` si ya hay `MAX_DESECHABLES`.
    pub(in crate::sesiones) fn ocupar(self: &Arc<Self>) -> Option<PlazaDesecho> {
        let previo = self.vivos.fetch_add(1, Ordering::SeqCst);
        if previo >= MAX_DESECHABLES {
            self.vivos.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(PlazaDesecho(self.clone()))
    }

    /// Cuenta una petición abandonada; devuelve el total.
    pub(in crate::sesiones) fn contar_abandonada(&self) -> usize {
        self.abandonadas.fetch_add(1, Ordering::SeqCst) + 1
    }

    #[cfg(test)]
    pub(in crate::sesiones) fn abandonadas(&self) -> usize {
        self.abandonadas.load(Ordering::SeqCst)
    }
}

/// Responde el rechazo en un hilo desechable o, sin plaza, lo abandona.
pub(super) fn desechar(d: &Arc<Desechos>, r: Rechazo) {
    let Some(plaza) = d.ocupar() else {
        return abandonar(d, r);
    };
    // Si el hilo no arranca, `spawn` suelta el cierre en este hilo: el
    // rechazo va en una celda para recuperarlo sin soltarlo aquí.
    let celda = Arc::new(Mutex::new(Some(r)));
    let dentro = celda.clone();
    let spawned = std::thread::Builder::new()
        .name("sesiones-puente-desecho".into())
        .spawn(move || {
            let _plaza = plaza;
            let Some(r) = tomar(&dentro) else { return };
            let hecho = catch_unwind(AssertUnwindSafe(|| super::error(r.req, r.status, r.msg)));
            if hecho.is_err() {
                tracing::error!("puente: pánico respondiendo un rechazo desechable");
            }
        });
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "puente: no se pudo arrancar un hilo desechable");
        if let Some(r) = tomar(&celda) {
            abandonar(d, r);
        }
    }
}

fn tomar(celda: &Mutex<Option<Rechazo>>) -> Option<Rechazo> {
    celda.lock().unwrap_or_else(PoisonError::into_inner).take()
}

/// Abandona la petición sin soltarla (soltarla puede bloquear) y la cuenta.
fn abandonar(d: &Desechos, r: Rechazo) {
    let total = d.contar_abandonada();
    if total.is_power_of_two() {
        tracing::error!(
            abandonadas = total,
            status = r.status,
            "puente: respondedores y hilos desechables ocupados, peticiones abandonadas sin respuesta"
        );
    } else {
        tracing::warn!(
            abandonadas = total,
            status = r.status,
            "puente: petición abandonada"
        );
    }
    std::mem::forget(r);
}
