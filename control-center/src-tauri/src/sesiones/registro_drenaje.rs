// sesiones/registro_drenaje.rs — Drenaje de la cola de cada sesión en un
// hilo propio (contrato de estabilidad, §1.6): nunca escribe en el PTY desde
// el hilo que emitió la señal. Submódulo de `registro_estado.rs`.
//
// Propiedad: WP-ESTADO.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use super::{aviso, contexto};
use crate::sesiones::buzon::ahora_ms;
use crate::sesiones::cola;
use crate::sesiones::maquina::Nivel;
use crate::sesiones::{caja, pantalla};

/// Función de drenaje de una sesión (inyectable en los tests).
type FnDrenar = Arc<dyn Fn(&str) + Send + Sync>;

/// Drenajes en curso, uno por sesión. Antes había un solo hilo global con un
/// canal sin tope: el G3 de una sesión (buzón, esperas y Ctrl+U, de 8 s a
/// casi 50 s) frenaba el drenaje de todas, y el tick de cada sesión con cola
/// apilaba una petición por segundo que después salía en ráfaga. Ahora cada
/// sesión drena en su propio hilo (serie dentro de la sesión, en paralelo
/// entre sesiones) y las peticiones se coalescen: con el drenaje de una
/// sesión en marcha, pedir otro solo anota una pasada más al terminar.
#[derive(Default)]
struct Drenajes {
    /// Sesión con hilo de drenaje vivo → llegó otra petición mientras drenaba.
    activos: Mutex<HashMap<String, bool>>,
}

impl Drenajes {
    fn pedir(&'static self, id: &str, f: &FnDrenar) {
        {
            let Ok(mut g) = self.activos.lock() else {
                tracing::error!(sesion = id, "drenajes envenenados");
                return;
            };
            if let Some(otra) = g.get_mut(id) {
                *otra = true;
                return;
            }
            g.insert(id.to_string(), false);
        }
        let (sid, f) = (id.to_string(), f.clone());
        let hilo = std::thread::Builder::new()
            .name("sesiones-drenaje".into())
            .spawn(move || self.bucle(&sid, &f));
        if let Err(e) = hilo {
            tracing::error!(sesion = id, error = %e, "no se pudo arrancar el hilo de drenaje");
            if let Ok(mut g) = self.activos.lock() {
                g.remove(id);
            }
        }
    }

    /// Drena hasta que no quede ninguna petición pendiente de la sesión.
    fn bucle(&self, id: &str, f: &FnDrenar) {
        loop {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(id)));
            if r.is_err() {
                tracing::error!(sesion = %id, "pánico en el drenaje de la cola");
            }
            let Ok(mut g) = self.activos.lock() else {
                return;
            };
            match g.get_mut(id) {
                Some(otra) if *otra => *otra = false,
                _ => {
                    g.remove(id);
                    return;
                }
            }
        }
    }
}

fn drenajes() -> &'static Drenajes {
    static D: OnceLock<Drenajes> = OnceLock::new();
    D.get_or_init(Drenajes::default)
}

fn drenar_real() -> &'static FnDrenar {
    static F: OnceLock<FnDrenar> = OnceLock::new();
    F.get_or_init(|| Arc::new(drenar))
}

/// Drenaje pedido por el usuario (Reintentar): levanta la pausa por caja
/// ocupada (`caja::Pausas`) y drena.
pub fn pedir_drenaje(id: &str) {
    caja::pausas().levantar(id);
    drenajes().pedir(id, drenar_real());
}

/// Drenaje automático (fin de turno, tick, pantalla, terminal soltada): no
/// sale mientras la caja de la TUI siga como la dejó un vaciado fallido
/// (G3): lo reintentaría cada tick con el mismo resultado.
pub(super) fn drenaje_automatico(id: &str) {
    let entrada = || pantalla::actual(id).entrada;
    if caja::pausas().en_pausa(id, entrada, Instant::now()) {
        tracing::trace!(
            sesion = id,
            "drenaje en pausa: la caja de la TUI sigue ocupada"
        );
        return;
    }
    drenajes().pedir(id, drenar_real());
}

/// Escribe el primer `queued` si la sesión está libre; un fallo para el
/// drenaje con un aviso visible. Un drenaje que llega tras `gestor::kill`
/// (pedido por una señal anterior al cierre) no escribe ni emite la cola.
pub fn drenar(id: &str) {
    if !crate::sesiones::registro::exists(id) {
        tracing::debug!(sesion = id, "drenaje de una sesión que ya no existe");
        return;
    }
    // El `turnEnd` del puente llega antes de que el seguidor lea el aviso de
    // cuota, y una sesión restaurada puede estar ya en el límite: aquí es donde
    // se evita el primer mensaje contra el aviso.
    if crate::sesiones::relevo::frena_drenaje(id) {
        cola::emitir_actual(id);
        return;
    }
    let ctx = contexto(id);
    let w = cola::escritor();
    match cola::global().drenar(id, ctx, &*w, ahora_ms()) {
        Ok(Some(_)) | Ok(None) => {}
        Err(e) => aviso(
            id,
            Nivel::Error,
            &format!("No se pudo enviar el mensaje en cola: {e}"),
        ),
    }
    cola::emitir_actual(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn con_aviso_de_cuota(id: &str) -> tempfile::TempDir {
        use crate::sesiones::registro;
        use crate::sesiones::types::{QueueItemInput, QueueItemKind};
        registro::insert(registro::sesion_de_prueba(id)).expect("alta");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        let linea = serde_json::json!({
            "type": "assistant",
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "message": { "model": "<synthetic>", "content": [{
                "type": "text", "text": "You've hit your session limit · resets 3:20pm"
            }] }
        });
        std::fs::write(&path, format!("{linea}\n")).expect("transcript");
        registro::update(id, |s| {
            s.transcript = Some(path.clone());
            (false, ())
        })
        .expect("transcript");
        let item = QueueItemInput {
            client_id: "c1".into(),
            text: "siguiente".into(),
            attachments: Vec::new(),
            delegate: false,
            kind: QueueItemKind::Prompt,
        };
        cola::global().encolar(id, item, 0).expect("encolar");
        dir
    }

    /// El drenaje real pasa por la comprobación del límite: con el aviso escrito
    /// y aún sin leer por el seguidor, la cola queda en pausa y no escribe.
    #[test]
    fn drenar_con_el_aviso_ya_escrito_deja_la_cola_en_pausa() {
        use crate::sesiones::{registro, relevo};
        let id = format!("drenar-limite-{}", uuid::Uuid::new_v4());
        let _dir = con_aviso_de_cuota(&id);
        assert_eq!(relevo::pausa_anotada(&id), None);
        drenar(&id);
        assert!(relevo::pausa_anotada(&id).is_some(), "drenar lo comprueba");
        assert!(cola::global().hay_en_cola(&id), "el mensaje sigue en cola");
        relevo::forget_session(&id);
        registro::remove(&id);
    }

    /// M4: el drenaje bloqueado de una sesión (G3 lento) no frena el de las
    /// demás, y las peticiones que llegan mientras tanto se coalescen en una
    /// sola pasada más (antes, un canal sin tope las apilaba una por tick).
    #[test]
    fn drenaje_por_sesion_y_peticiones_coalescidas() {
        use std::sync::mpsc;
        use std::time::Duration;
        let d: &'static Drenajes = Box::leak(Box::default());
        let llamadas: Arc<Mutex<Vec<String>>> = Arc::default();
        let (soltar_tx, soltar_rx) = mpsc::channel::<()>();
        let soltar = Mutex::new(soltar_rx);
        let (hecho_tx, hecho_rx) = mpsc::channel::<String>();
        let hecho = Mutex::new(hecho_tx);
        let l = llamadas.clone();
        let f: FnDrenar = Arc::new(move |id: &str| {
            l.lock().expect("llamadas").push(id.to_string());
            if id == "a" {
                let _ = soltar
                    .lock()
                    .expect("soltar")
                    .recv_timeout(Duration::from_secs(5));
            }
            let _ = hecho.lock().expect("hecho").send(id.to_string());
        });
        let espera = Duration::from_secs(5);
        d.pedir("a", &f);
        d.pedir("b", &f);
        assert_eq!(
            hecho_rx.recv_timeout(espera).as_deref(),
            Ok("b"),
            "b no espera a a"
        );
        for _ in 0..30 {
            d.pedir("a", &f);
        }
        soltar_tx.send(()).expect("soltar");
        soltar_tx.send(()).expect("soltar");
        assert_eq!(hecho_rx.recv_timeout(espera).as_deref(), Ok("a"));
        assert_eq!(hecho_rx.recv_timeout(espera).as_deref(), Ok("a"));
        assert!(hecho_rx.recv_timeout(Duration::from_millis(200)).is_err());
        let a = llamadas
            .lock()
            .expect("llamadas")
            .iter()
            .filter(|x| *x == "a")
            .count();
        assert_eq!(a, 2, "30 peticiones durante el drenaje: una pasada más");
    }
}
