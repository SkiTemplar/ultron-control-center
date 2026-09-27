// qdrant_inference_gate.rs — turno FIFO para los forward pass de ONNX.
//
// POR QUÉ (medido 2026-09-27, 3 sesiones simultáneas x 10 rondas): fastembed
// abre cada sesión de ONNX con `intra_threads = available_parallelism()` (32
// en esta máquina), así que UNA inferencia ya ocupa todos los núcleos. Dos a la
// vez —dos embeds de E5, o un embed y un re-rank del cross-encoder— no suman
// rendimiento: sobresuscriben la CPU con 64 hilos que se pisan, y la varianza
// resultante (re-ranks de 15-25 s con el modelo caliente) era la que obligaba a
// poner topes cortos y a abandonar el re-rank a los 3,5 s. Con el turno, los
// forward pass van de uno en uno y en orden de llegada: cada uno corre a
// velocidad plena y ninguno se descarta por contención; quien llega tarde
// espera su turno.
//
// Es un ticket lock (Mutex + Condvar, sin dependencias): a diferencia de un
// `Mutex` a secas, que en Windows (SRWLock) no garantiza orden, aquí nadie
// adelanta a nadie. Con tres sesiones compitiendo, un orden injusto se traduce
// en un turno que espera indefinidamente mientras los demás pasan.
//
// Lo que NO serializa: lectura de SQLite, búsquedas HTTP a Qdrant, llamadas a
// proveedores LLM ni la aceptación de conexiones. Solo el cómputo de los modelos.

use std::cell::Cell;
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::Instant;

/// Estado del ticket lock: siguiente número a repartir y número que se sirve.
struct Turnos {
    siguiente: u64,
    sirviendo: u64,
}

/// Cola FIFO de un solo titular.
pub(crate) struct InferenceGate {
    turnos: Mutex<Turnos>,
    cambio: Condvar,
}

/// Turno vivo. Al soltarse pasa el turno al siguiente de la cola, también si
/// el forward pass entra en pánico (se suelta al desenrollar).
pub(crate) struct InferenceTurn {
    gate: &'static InferenceGate,
}

impl InferenceGate {
    pub(crate) const fn new() -> Self {
        Self {
            turnos: Mutex::new(Turnos {
                siguiente: 0,
                sirviendo: 0,
            }),
            cambio: Condvar::new(),
        }
    }

    /// Espera el turno sin tope: la espera es contención, y la contención ya
    /// no degrada nada. Un cuelgue real lo acota quien llama (ver
    /// `rerank_pairs_bounded`), no la cola.
    pub(crate) fn acquire(&'static self) -> InferenceTurn {
        let t0 = Instant::now();
        let mut turnos = self.turnos.lock().unwrap_or_else(PoisonError::into_inner);
        let mio = turnos.siguiente;
        turnos.siguiente += 1;
        while turnos.sirviendo != mio {
            turnos = self
                .cambio
                .wait(turnos)
                .unwrap_or_else(PoisonError::into_inner);
        }
        drop(turnos);
        let esperado = u64::try_from(t0.elapsed().as_millis()).unwrap_or(u64::MAX);
        WAIT_MS.with(|w| w.set(w.get().saturating_add(esperado)));
        InferenceTurn { gate: self }
    }

    /// Cuántos esperan o están dentro ahora mismo (telemetría y tests).
    #[cfg(test)]
    fn en_cola(&self) -> u64 {
        let t = self.turnos.lock().unwrap_or_else(PoisonError::into_inner);
        t.siguiente - t.sirviendo
    }
}

impl Drop for InferenceTurn {
    fn drop(&mut self) {
        let mut turnos = self
            .gate
            .turnos
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        turnos.sirviendo += 1;
        drop(turnos);
        // notify_all: el Condvar es compartido y solo UNO de los despertados
        // tiene el número que toca; los demás vuelven a dormir.
        self.gate.cambio.notify_all();
    }
}

/// El turno único del proceso para E5 y el cross-encoder.
static GATE: InferenceGate = InferenceGate::new();

/// Toma el turno de inferencia del proceso (bloquea hasta que toque).
pub(crate) fn inference_turn() -> InferenceTurn {
    GATE.acquire()
}

thread_local! {
    /// Milisegundos que ESTE hilo ha esperado turno desde el último `take`.
    static WAIT_MS: Cell<u64> = const { Cell::new(0) };
}

/// Devuelve y pone a cero la espera acumulada por el hilo actual. El daemon lo
/// anota por petición en `memory-daemon.jsonl` (`inference_wait_ms`): así se
/// distingue en el log la espera por contención del cómputo real.
pub fn take_inference_wait_ms() -> u64 {
    WAIT_MS.with(|w| w.replace(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    fn gate_de_test() -> &'static InferenceGate {
        Box::leak(Box::new(InferenceGate::new()))
    }

    #[test]
    fn nunca_hay_dos_titulares_a_la_vez() {
        let gate = gate_de_test();
        let dentro = Arc::new(AtomicUsize::new(0));
        let max_visto = Arc::new(AtomicUsize::new(0));
        let hilos: Vec<_> = (0..8)
            .map(|_| {
                let dentro = Arc::clone(&dentro);
                let max_visto = Arc::clone(&max_visto);
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        let _t = gate.acquire();
                        let n = dentro.fetch_add(1, Ordering::SeqCst) + 1;
                        max_visto.fetch_max(n, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_micros(200));
                        dentro.fetch_sub(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for h in hilos {
            h.join().unwrap();
        }
        assert_eq!(max_visto.load(Ordering::SeqCst), 1, "exclusión mutua");
        assert_eq!(gate.en_cola(), 0, "todos los turnos devueltos");
    }

    #[test]
    fn se_sirve_en_orden_de_llegada() {
        let gate = gate_de_test();
        let orden = Arc::new(Mutex::new(Vec::new()));
        let titular = gate.acquire();
        let mut hilos = Vec::new();
        for i in 0..5 {
            let orden = Arc::clone(&orden);
            hilos.push(std::thread::spawn(move || {
                let _t = gate.acquire();
                orden.lock().unwrap().push(i);
            }));
            // Cada hilo coge número antes de lanzar el siguiente.
            while gate.en_cola() < (i as u64) + 2 {
                std::thread::yield_now();
            }
        }
        drop(titular);
        for h in hilos {
            h.join().unwrap();
        }
        assert_eq!(*orden.lock().unwrap(), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn un_panico_del_titular_no_bloquea_la_cola() {
        let gate = gate_de_test();
        let r = std::thread::spawn(move || {
            let _t = gate.acquire();
            panic!("forward pass simulado que revienta");
        })
        .join();
        assert!(r.is_err());
        let t0 = Instant::now();
        let _t = gate.acquire();
        assert!(
            t0.elapsed() < Duration::from_secs(1),
            "el turno se devolvió"
        );
    }

    #[test]
    fn la_espera_por_contencion_se_contabiliza_por_hilo() {
        let gate = gate_de_test();
        let _ = take_inference_wait_ms();
        let titular = gate.acquire();
        let esperante = std::thread::spawn(move || {
            let _t = gate.acquire();
            take_inference_wait_ms()
        });
        std::thread::sleep(Duration::from_millis(120));
        drop(titular);
        let esperado = esperante.join().unwrap();
        assert!(esperado >= 100, "esperó ~120 ms y anotó {esperado}");
        // Caso negativo: sin contención, la espera anotada es ~0.
        let _t = gate.acquire();
        drop(_t);
        assert!(take_inference_wait_ms() < 50);
    }
}
