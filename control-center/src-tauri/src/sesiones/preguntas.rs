// sesiones/preguntas.rs — Permisos, preguntas y planes pendientes del puente
// (contrato de estabilidad, §4.1-§4.2).
//
// Un ask **no caduca** mientras la sesión vive: se resuelve como `answered`
// o como `cancelled{reason}` (`interrupted`, `turnEnded`, `sessionExited`,
// `modAborted`, `restart`). Protocolo 2: `POST /v1/ask` asíncrono devuelve
// `{askId}` y el mod espera con un sondeo multiplexado (`esperar`, hasta
// 20 s por vuelta). Protocolo 1: `ask` bloquea el hilo de la petición hasta
// que se resuelve. Las preguntas pendientes se listan (`list`) para que una
// ventana nueva o recargada las pinte; cerrar ventanas no cancela nada. Sin
// ninguna ventana abierta, el ask queda pendiente y se lanza un aviso del
// Control Center. Cada apertura y resolución llega a la máquina de estados
// como `AskAbierta` / `AskCerrada`.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::registro::Sink;
use super::senales::{self, Senal};
use super::types::{ev, AskAnswer, AskCancelReason, AskOutcome, AskResolved};

/// Resultados ya resueltos que se recuerdan para el siguiente `wait` y para
/// responder `ask_gone` con el motivo.
const RECUERDO_RESUELTOS: Duration = Duration::from_secs(120);
/// Asks pendientes por sesión: por encima, `abrir` falla (429 en el puente).
pub const MAX_ASKS_SESION: usize = 32;
/// Error de `abrir` con la sesión en el tope de asks pendientes.
pub const ASKS_LLENOS: &str = "demasiadas preguntas pendientes en esta sesión";

/// Ask registrado.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingAsk {
    pub ask_id: String,
    pub sesion_id: String,
    /// `permission` | `question` | `plan`.
    pub kind: String,
    /// `Ask & { createdAt }` tal como se emitió a la ventana.
    pub payload: Value,
    pub created_at: String,
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Resolucion {
    Pendiente,
    Respondida(AskAnswer),
    Cancelada(AskCancelReason),
}

/// Estado de un ask para el sondeo `/v1/ask/wait`.
#[derive(Debug, Clone, PartialEq)]
pub struct ResultadoAsk {
    pub ask_id: String,
    pub resolucion: Resolucion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskError {
    /// Ya resuelta o desconocida (`ask_gone`).
    Gone,
    /// La respuesta no corresponde al tipo de pregunta.
    Invalid,
}

impl AskError {
    pub fn codigo(self) -> &'static str {
        match self {
            Self::Gone => "ask_gone",
            Self::Invalid => "ask_invalid",
        }
    }
}

struct Entrada {
    ask: PendingAsk,
    resolucion: Resolucion,
    resuelta: Option<Instant>,
}

/// Registro de asks por `askId`.
pub struct Broker {
    mapa: Mutex<HashMap<String, Entrada>>,
    cambio: Condvar,
}

impl Default for Broker {
    fn default() -> Self {
        Self::new()
    }
}

impl Broker {
    pub fn new() -> Self {
        Self {
            mapa: Mutex::new(HashMap::new()),
            cambio: Condvar::new(),
        }
    }

    /// Instancia global usada por la app.
    pub fn global() -> Arc<Broker> {
        static B: OnceLock<Arc<Broker>> = OnceLock::new();
        B.get_or_init(|| Arc::new(Broker::new())).clone()
    }

    fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, Entrada>>, String> {
        self.mapa
            .lock()
            .map_err(|_| "mapa de preguntas envenenado".to_string())
    }

    /// Registra el ask, lo emite a las ventanas y avisa a la máquina. Sin
    /// ventana abierta, aviso del Control Center (el ask sigue pendiente).
    pub fn abrir(
        &self,
        sink: &dyn Sink,
        sesion_id: &str,
        ask: &Value,
        turn_id: Option<String>,
    ) -> Result<PendingAsk, String> {
        let payload = build_payload(sesion_id, ask)?;
        let p = PendingAsk {
            ask_id: texto(&payload, "askId"),
            sesion_id: sesion_id.to_string(),
            kind: texto(&payload, "kind"),
            created_at: texto(&payload, "createdAt"),
            payload,
            turn_id,
        };
        let mut m = self.purgar()?;
        if pendientes_de(&m, sesion_id) >= MAX_ASKS_SESION {
            return Err(ASKS_LLENOS.to_string());
        }
        m.insert(
            p.ask_id.clone(),
            Entrada {
                ask: p.clone(),
                resolucion: Resolucion::Pendiente,
                resuelta: None,
            },
        );
        drop(m);
        sink.emit(ev::ASK, p.payload.clone());
        if !sink.window_open() {
            sink.avisar("Claude espera tu respuesta en ULTRON Sessions");
        }
        senales::emitir(
            sesion_id,
            Senal::AskAbierta {
                ask_id: p.ask_id.clone(),
                kind: p.kind.clone(),
            },
        );
        Ok(p)
    }

    /// Quita los resueltos antiguos y devuelve el mapa bloqueado.
    fn purgar(&self) -> Result<MutexGuard<'_, HashMap<String, Entrada>>, String> {
        let mut m = self.lock()?;
        m.retain(|_, e| e.resuelta.is_none_or(|t| t.elapsed() < RECUERDO_RESUELTOS));
        Ok(m)
    }

    /// Sondeo multiplexado: vuelve en cuanto alguno de `ask_ids` está
    /// resuelto o al vencer `timeout`, con el estado de todos. Un `askId`
    /// desconocido es `cancelled{unknown}`.
    pub fn esperar(&self, ask_ids: &[String], timeout: Duration) -> Vec<ResultadoAsk> {
        self.esperar_filtrado(None, ask_ids, timeout)
    }

    /// `esperar` desde el puente de `sesion`: un `askId` de otra sesión es
    /// `cancelled{unknown}`, como uno desconocido (no se filtra su estado ni
    /// su respuesta).
    pub fn esperar_de(
        &self,
        sesion: &str,
        ask_ids: &[String],
        timeout: Duration,
    ) -> Vec<ResultadoAsk> {
        self.esperar_filtrado(Some(sesion), ask_ids, timeout)
    }

    fn esperar_filtrado(
        &self,
        sesion: Option<&str>,
        ask_ids: &[String],
        timeout: Duration,
    ) -> Vec<ResultadoAsk> {
        let fin = Instant::now() + timeout;
        let Ok(mut m) = self.lock() else {
            return desconocidos(ask_ids);
        };
        loop {
            let estado = estados(&m, sesion, ask_ids);
            let hay = estado.iter().any(|r| r.resolucion != Resolucion::Pendiente);
            let ahora = Instant::now();
            if hay || ahora >= fin {
                return estado;
            }
            match self.cambio.wait_timeout(m, fin - ahora) {
                Ok((g, _)) => m = g,
                Err(_) => return desconocidos(ask_ids),
            }
        }
    }

    /// Protocolo 1: bloquea hasta que el ask se resuelve. `None` si se
    /// cancela (decide la TUI, como en el mod antiguo).
    pub fn ask(
        &self,
        sink: &dyn Sink,
        sesion_id: &str,
        ask: &Value,
    ) -> Result<Option<AskAnswer>, String> {
        let p = self.abrir(sink, sesion_id, ask, None)?;
        let ids = [p.ask_id];
        loop {
            let r = self.esperar(&ids, Duration::from_secs(60));
            match r.first().map(|r| &r.resolucion) {
                Some(Resolucion::Respondida(a)) => return Ok(Some(a.clone())),
                Some(Resolucion::Cancelada(_)) | None => return Ok(None),
                Some(Resolucion::Pendiente) => {}
            }
        }
    }

    /// Respuesta desde la ventana.
    pub fn answer(&self, sink: &dyn Sink, ask_id: &str, answer: AskAnswer) -> Result<(), AskError> {
        let sesion = {
            let mut m = self.lock().map_err(|_| AskError::Gone)?;
            let e = m.get_mut(ask_id).ok_or(AskError::Gone)?;
            if e.resolucion != Resolucion::Pendiente {
                return Err(AskError::Gone);
            }
            if !encaja(&e.ask.kind, &answer) {
                return Err(AskError::Invalid);
            }
            e.resolucion = Resolucion::Respondida(answer);
            e.resuelta = Some(Instant::now());
            e.ask.sesion_id.clone()
        };
        self.cambio.notify_all();
        resuelto(sink, ask_id, &sesion, AskOutcome::Answered, None);
        Ok(())
    }

    /// Cancela un ask concreto (`/v1/ask/cancel` del mod). Devuelve si
    /// estaba pendiente.
    pub fn cancelar(&self, sink: &dyn Sink, ask_id: &str, reason: AskCancelReason) -> bool {
        let sesion = {
            let Ok(mut m) = self.lock() else { return false };
            match m.get_mut(ask_id) {
                Some(e) if e.resolucion == Resolucion::Pendiente => {
                    e.resolucion = Resolucion::Cancelada(reason);
                    e.resuelta = Some(Instant::now());
                    e.ask.sesion_id.clone()
                }
                _ => return false,
            }
        };
        self.cambio.notify_all();
        resuelto(sink, ask_id, &sesion, AskOutcome::Cancelled, Some(reason));
        true
    }

    /// Cancela los pendientes de una sesión; devuelve sus `askId`.
    pub fn cancel_for(
        &self,
        sink: &dyn Sink,
        sesion_id: &str,
        reason: AskCancelReason,
    ) -> Vec<String> {
        let ids: Vec<String> = self
            .pending_for(sesion_id)
            .into_iter()
            .map(|p| p.ask_id)
            .collect();
        ids.into_iter()
            .filter(|id| self.cancelar(sink, id, reason))
            .collect()
    }

    /// Compatibilidad con los llamantes de la v0.2 (`gestor`, `ventana`):
    /// `Some(id)` cancela los de la sesión con `sessionExited`; `None`, todos.
    pub fn cancel(&self, sink: &dyn Sink, sesion_id: Option<&str>) {
        let ids: Vec<String> = self
            .list_pending(sesion_id)
            .into_iter()
            .map(|p| p.ask_id)
            .collect();
        for id in ids {
            self.cancelar(sink, &id, AskCancelReason::SessionExited);
        }
    }

    fn list_pending(&self, sesion_id: Option<&str>) -> Vec<PendingAsk> {
        let Ok(m) = self.lock() else {
            return Vec::new();
        };
        let mut v: Vec<PendingAsk> = m
            .values()
            .filter(|e| e.resolucion == Resolucion::Pendiente)
            .filter(|e| sesion_id.is_none_or(|s| e.ask.sesion_id == s))
            .map(|e| e.ask.clone())
            .collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        v
    }

    /// Pendientes de la sesión, en orden de llegada.
    pub fn pending_for(&self, sesion_id: &str) -> Vec<PendingAsk> {
        self.list_pending(Some(sesion_id))
    }

    /// Payloads pendientes (`sesiones_pending_asks`) de una sesión o de todas.
    pub fn list(&self, sesion_id: Option<&str>) -> Vec<Value> {
        self.list_pending(sesion_id)
            .into_iter()
            .map(|p| p.payload)
            .collect()
    }

    /// Ask todavía pendiente con este `askId` (`None` si se resolvió o no
    /// existe).
    pub fn pendiente(&self, ask_id: &str) -> Option<PendingAsk> {
        let m = self.lock().ok()?;
        m.get(ask_id)
            .filter(|e| e.resolucion == Resolucion::Pendiente)
            .map(|e| e.ask.clone())
    }

    /// Sesión de un ask (pendiente o recién resuelto).
    pub fn sesion_de(&self, ask_id: &str) -> Option<String> {
        self.lock()
            .ok()
            .and_then(|m| m.get(ask_id).map(|e| e.ask.sesion_id.clone()))
    }
}

fn texto(v: &Value, k: &str) -> String {
    v.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn estados(
    m: &HashMap<String, Entrada>,
    sesion: Option<&str>,
    ask_ids: &[String],
) -> Vec<ResultadoAsk> {
    ask_ids
        .iter()
        .map(|id| ResultadoAsk {
            ask_id: id.clone(),
            resolucion: m
                .get(id)
                .filter(|e| sesion.is_none_or(|s| e.ask.sesion_id == s))
                .map_or(Resolucion::Cancelada(AskCancelReason::Unknown), |e| {
                    e.resolucion.clone()
                }),
        })
        .collect()
}

/// Asks sin resolver de una sesión.
fn pendientes_de(m: &HashMap<String, Entrada>, sesion_id: &str) -> usize {
    m.values()
        .filter(|e| e.resolucion == Resolucion::Pendiente && e.ask.sesion_id == sesion_id)
        .count()
}

fn desconocidos(ask_ids: &[String]) -> Vec<ResultadoAsk> {
    ask_ids
        .iter()
        .map(|id| ResultadoAsk {
            ask_id: id.clone(),
            resolucion: Resolucion::Cancelada(AskCancelReason::Unknown),
        })
        .collect()
}

/// La respuesta corresponde al tipo de ask.
fn encaja(kind: &str, a: &AskAnswer) -> bool {
    matches!(
        (kind, a),
        ("permission", AskAnswer::Permission { .. })
            | ("question", AskAnswer::Question { .. })
            | ("plan", AskAnswer::Plan(_))
    )
}

fn resuelto(
    sink: &dyn Sink,
    ask_id: &str,
    sesion: &str,
    outcome: AskOutcome,
    reason: Option<AskCancelReason>,
) {
    let p = AskResolved {
        ask_id: ask_id.to_string(),
        id: sesion.to_string(),
        outcome,
        reason,
    };
    sink.emit(
        ev::ASK_RESOLVED,
        serde_json::to_value(p).unwrap_or(Value::Null),
    );
    senales::emitir(
        sesion,
        Senal::AskCerrada {
            ask_id: ask_id.to_string(),
        },
    );
}

/// Resultado de un ask en el cable de `/v1/ask/wait`.
pub fn resultado_json(r: &ResultadoAsk) -> Value {
    match &r.resolucion {
        Resolucion::Pendiente => json!({ "askId": r.ask_id, "status": "pending" }),
        Resolucion::Respondida(a) => {
            json!({ "askId": r.ask_id, "status": "answered", "answer": a })
        }
        Resolucion::Cancelada(reason) => {
            json!({ "askId": r.ask_id, "status": "cancelled", "reason": reason })
        }
    }
}

/// `Ask` completo para la ventana: el objeto del puente más `askId`, `id` y
/// `createdAt`.
pub fn build_payload(sesion_id: &str, ask: &Value) -> Result<Value, String> {
    let obj = ask
        .as_object()
        .ok_or_else(|| "ask debe ser un objeto".to_string())?;
    let kind = obj.get("kind").and_then(Value::as_str).unwrap_or_default();
    if !matches!(kind, "permission" | "question" | "plan") {
        return Err(format!("tipo de ask no válido: '{kind}'"));
    }
    let mut out = obj.clone();
    out.insert(
        "askId".into(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    out.insert("id".into(), Value::String(sesion_id.to_string()));
    out.insert("createdAt".into(), Value::String(super::types::now_iso()));
    if kind == "permission" && !out.contains_key("agentId") {
        out.insert("agentId".into(), Value::Null);
    }
    // H6: la regla concreta que guardaría «Permitir siempre».
    super::permiso_siempre::anunciar(&mut out);
    Ok(Value::Object(out))
}

#[cfg(test)]
#[path = "tests_preguntas.rs"]
mod tests;
