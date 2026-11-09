// sesiones/relevo_limite.rs — Cola en pausa por el límite de uso de Claude
// (submódulo de `relevo`).
//
// Tras cada aviso de cuota la CLI termina el turno y la cola sacaba el mensaje
// siguiente, que recibía otro aviso: con N mensajes, en N segundos quedaban
// todos `delivered` sin respuesta. La pausa la lleva la máquina
// (`Senal::LimiteUso` y `LimiteFin`); aquí se decide cuándo empieza y cuándo
// acaba, también con `automaticRelay` apagado:
//
// - Empieza con el primer aviso del transcript (`relevo::observe`) o, antes de
//   drenar, con el aviso ya escrito que el seguidor aún no ha leído (el
//   `turnEnd` del puente llega antes) o con la muestra local de uso agotada
//   (una sesión restaurada en pleno límite).
// - Con relevo, acaba en la vuelta a Claude. Sin relevo, a la hora de vuelta
//   del aviso o de la muestra, aplazada si la muestra sigue al 100 %.
// - Sin hora de vuelta conocida, o con el relevo en error, espera a «Enviar
//   ahora».
//
// Lo encolado espera en la cola y sale al volver: no pasa al traspaso, porque
// entonces llegaría dos veces.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use chrono::{DateTime, Duration, Local, Utc};
use serde_json::Value;

use super::aviso::{detect_usage_limit, exhausted_window};
use crate::sesiones::senales::{self, Senal};
use crate::sesiones::types::PlanUsage;
use crate::sesiones::{cola, lectura_final, registro};

/// Final del transcript que se mira antes de drenar: basta para las últimas
/// líneas, y un aviso de cuota es una línea corta.
const VENTANA_FINAL: u64 = 64 * 1024;

/// Un aviso más viejo no es el del turno que acaba de cerrar: es el de un
/// límite que ya pasó y sigue siendo la última línea de una sesión parada.
fn aviso_fresco() -> Duration {
    Duration::seconds(60)
}

/// Sesiones en pausa por el límite → hora de vuelta (RFC 3339), si se conoce.
fn esperas() -> MutexGuard<'static, HashMap<String, Option<String>>> {
    static E: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    E.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Sesiones cuyo relevo se está preparando en su hilo.
fn entradas() -> MutexGuard<'static, HashSet<String>> {
    static E: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    E.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// false si el relevo de la sesión ya se está preparando.
pub(super) fn reservar_entrada(session_id: &str) -> bool {
    entradas().insert(session_id.to_string())
}

pub(super) fn liberar_entrada(session_id: &str) {
    entradas().remove(session_id);
}

/// Retiene la cola hasta `vuelta`. Idempotente: la máquina avisa una sola vez.
pub(super) fn pausar(session_id: &str, vuelta: Option<String>) {
    esperas().insert(session_id.to_string(), vuelta);
    senales::emitir(session_id, Senal::LimiteUso);
}

/// La cuota volvió o el relevo terminó: la cola se reanuda.
pub(super) fn levantar(session_id: &str) {
    esperas().remove(session_id);
    senales::emitir(session_id, Senal::LimiteFin);
}

/// La sesión se cerró: sin señal, porque ya no hay máquina que la reciba.
pub(super) fn olvidar(session_id: &str) {
    esperas().remove(session_id);
    entradas().remove(session_id);
}

#[cfg(test)]
pub(super) fn vuelta_anotada(session_id: &str) -> Option<Option<String>> {
    esperas().get(session_id).cloned()
}

fn hora_pasada(vuelta: Option<&str>, ahora: DateTime<Local>) -> bool {
    vuelta
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .is_some_and(|at| at <= ahora)
}

/// Hora de reinicio de la ventana agotada, si sigue en el futuro. Una muestra
/// al 100 % con el reinicio ya pasado es de la ventana anterior.
fn reinicio_pendiente(usage: Option<&PlanUsage>, ahora: DateTime<Utc>) -> Option<String> {
    let (_, ventana) = exhausted_window(usage)?;
    let reinicio = ventana.resets_at.clone()?;
    let at = DateTime::parse_from_rfc3339(&reinicio).ok()?;
    (at > ahora).then_some(reinicio)
}

/// Sin relevo: pasada la hora de vuelta, reanuda la cola, salvo que la muestra
/// siga agotada (entonces la vuelta se aplaza a su reinicio). `usage` solo se
/// consulta con la hora ya vencida: esto corre en cada vuelta del seguidor.
pub(super) fn poll(session_id: &str, usage: impl FnOnce() -> Option<PlanUsage>) {
    let vencida = esperas()
        .get(session_id)
        .is_some_and(|v| hora_pasada(v.as_deref(), Local::now()));
    if !vencida {
        return;
    }
    if let Some(reinicio) = reinicio_pendiente(usage().as_ref(), Utc::now()) {
        esperas().insert(session_id.to_string(), Some(reinicio));
        return;
    }
    levantar(session_id);
}

/// Aviso de cuota reciente como última línea de conversación de `texto`. Solo
/// cuenta si nada se ha dicho después: tras él, un prompt o una respuesta de
/// verdad significan que el límite ya pasó.
fn aviso_al_final(texto: &str, ahora: DateTime<Utc>) -> Option<Option<String>> {
    let linea = texto
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .find(|v| {
            matches!(
                v.get("type").and_then(Value::as_str),
                Some("assistant" | "user")
            )
        })?;
    let limite = detect_usage_limit(&linea)?;
    let cuando = linea
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())?
        .with_timezone(&Utc);
    (ahora - cuando <= aviso_fresco()).then_some(limite.return_at)
}

/// Hora de vuelta si Claude está en el límite ahora mismo (`Some`, aunque la
/// hora sea desconocida), según el final del transcript o la muestra de uso.
pub(super) fn limite_vigente(
    final_transcript: Option<&str>,
    usage: Option<&PlanUsage>,
    ahora: DateTime<Utc>,
) -> Option<Option<String>> {
    final_transcript
        .and_then(|t| aviso_al_final(t, ahora))
        .or_else(|| reinicio_pendiente(usage, ahora).map(Some))
}

/// Comprobación previa al drenaje: true si la cola se retiene ahora.
pub(super) fn frena_drenaje(session_id: &str, usage: impl FnOnce() -> Option<PlanUsage>) -> bool {
    if !cola::global().hay_en_cola(session_id) {
        return false;
    }
    let transcript = registro::read(session_id, |s| s.transcript.clone())
        .ok()
        .flatten();
    let texto = transcript.and_then(|p| match lectura_final::leer_final(&p, VENTANA_FINAL) {
        Ok(f) => Some(f.texto),
        Err(e) => {
            tracing::debug!(sesion = session_id, error = %e, "drenaje: sin final del transcript");
            None
        }
    });
    let Some(vuelta) = limite_vigente(texto.as_deref(), usage().as_ref(), Utc::now()) else {
        return false;
    };
    tracing::info!(
        sesion = session_id,
        "límite de uso antes de drenar: la cola se retiene"
    );
    pausar(session_id, vuelta);
    true
}
