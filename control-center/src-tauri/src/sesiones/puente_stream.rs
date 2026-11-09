// sesiones/puente_stream.rs — Emparejamiento por identidad del texto en vivo
// con el transcript (contrato de estabilidad, §5.3; chat-orden:F10).
//
// El puente manda `text` con `step` y `block`; aquí se acumula por
// `(turnId, agentId, step, block)`. Cuando el seguidor emite un bloque de
// texto del asistente, se busca una entrada abierta del mismo agente cuyo
// texto coincida **exactamente** (sin espacios finales): si coincide, el
// mensaje lleva `streamKey` y la entrada se libera. El transcript puede
// llegar antes que el último delta: el bloque sin pareja queda 5 s como
// pendiente y se reintenta en cada delta y en cada `stepEnd` de ese agente;
// al emparejar se emite `sesiones://stream-matched`.
//
// El texto final del transcript puede no ser idéntico al emitido en vivo (la
// CLI lo reescribe al cerrar el bloque). Por eso, cuando un paso ya terminó
// (`stepEnd`) sus entradas quedan cerradas y un bloque sin pareja exacta se
// empareja por orden con la entrada cerrada más antigua del mismo agente:
// después del `stepEnd` no llegan más deltas de ese paso.
//
// Propiedad: WP-ESTADO.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::sesiones::buzon::ahora_ms;
use crate::sesiones::maquina::Ms;
use crate::sesiones::types::{Block, ChatMessage};

/// Vida de un bloque del transcript sin pareja.
const PENDIENTE_MAX: Ms = 5_000;
/// Vida de una entrada en vivo sin emparejar.
const ENTRADA_MAX: Ms = 120_000;
// Topes por sesión (auditoría del 2026-10-15): la vida de 120 s no acotaba
// nada dentro de ese plazo; cada `(step, block)` nuevo abría una entrada y
// los deltas se acumulaban sin límite, y cada búsqueda recorre las listas.
/// Entradas en vivo; por encima sale la más antigua (pierde su `streamKey`).
const MAX_ENTRADAS: usize = 64;
/// Texto acumulado de una entrada (~64k tokens, más que una respuesta larga).
/// Por encima deja de acumular y solo empareja por orden tras el `stepEnd`.
const MAX_TEXTO_ENTRADA: usize = 256 * 1024;
/// Bloques del transcript sin pareja; por encima sale el más antiguo.
const MAX_PENDIENTES: usize = 64;

/// Clave de una entrada en vivo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clave {
    pub turn_id: String,
    pub agente: Option<String>,
    pub step: u64,
    pub block: u64,
}

impl Clave {
    pub fn de_evento(e: &Value) -> Self {
        let n = |k: &str| e.get(k).and_then(Value::as_u64).unwrap_or(0);
        Self {
            turn_id: e
                .get("turnId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            agente: e
                .get("agentId")
                .and_then(Value::as_str)
                .filter(|a| !a.is_empty())
                .map(str::to_string),
            step: n("step"),
            block: n("block"),
        }
    }

    /// `"turnId:agentId|main:step:block"`.
    pub fn texto(&self) -> String {
        format!(
            "{}:{}:{}:{}",
            self.turn_id,
            self.agente.as_deref().unwrap_or("main"),
            self.step,
            self.block
        )
    }
}

/// Bloque del transcript emparejado con su entrada en vivo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Emparejado {
    pub stream_key: String,
    pub message_uuid: String,
}

impl Emparejado {
    pub fn payload(&self, id: &str) -> Value {
        json!({ "id": id, "streamKey": self.stream_key, "messageUuid": self.message_uuid })
    }
}

struct Entrada {
    clave: Clave,
    texto: String,
    desde: Ms,
    /** Su paso ya recibió `stepEnd`: el texto no crecerá más. */
    cerrada: bool,
    /** Pasó de `MAX_TEXTO_ENTRADA`: su texto está incompleto y no empareja
    por identidad. */
    desbordada: bool,
}

impl Entrada {
    fn acumular(&mut self, delta: &str) {
        if self.desbordada {
            return;
        }
        if self.texto.len() + delta.len() > MAX_TEXTO_ENTRADA {
            self.desbordada = true;
            self.texto = String::new();
            return;
        }
        self.texto.push_str(delta);
    }
}

struct Pendiente {
    uuid: String,
    agente: Option<String>,
    texto: String,
    desde: Ms,
}

/// Estado de emparejamiento de una sesión.
#[derive(Default)]
pub struct Emparejador {
    entradas: Vec<Entrada>,
    pendientes: Vec<Pendiente>,
}

impl Emparejador {
    pub fn delta(&mut self, clave: &Clave, delta: &str, ahora: Ms) -> Vec<Emparejado> {
        self.purgar(ahora);
        if let Some(e) = self.entradas.iter_mut().find(|e| e.clave == *clave) {
            e.acumular(delta);
        } else {
            let mut e = Entrada {
                clave: clave.clone(),
                texto: String::new(),
                desde: ahora,
                cerrada: false,
                desbordada: false,
            };
            e.acumular(delta);
            self.entradas.push(e);
            descartar_antiguos(&mut self.entradas, MAX_ENTRADAS);
        }
        self.reintentar(clave.agente.as_deref())
    }

    pub fn paso_fin(&mut self, clave: &Clave, ahora: Ms) -> Vec<Emparejado> {
        self.purgar(ahora);
        let agente = clave.agente.as_deref();
        for e in self.entradas.iter_mut().filter(|e| {
            e.clave.agente.as_deref() == agente
                && e.clave.turn_id == clave.turn_id
                && e.clave.step <= clave.step
        }) {
            e.cerrada = true;
        }
        let mut out = self.reintentar(agente);
        out.extend(self.por_orden(agente));
        out
    }

    /// Pendientes del agente contra entradas cerradas, los dos en orden de llegada.
    fn por_orden(&mut self, agente: Option<&str>) -> Vec<Emparejado> {
        let mut out = Vec::new();
        let mut quedan = Vec::new();
        for p in std::mem::take(&mut self.pendientes) {
            let k = if p.agente.as_deref() == agente {
                self.tomar_cerrada(agente)
            } else {
                None
            };
            match k {
                Some(stream_key) => out.push(Emparejado {
                    stream_key,
                    message_uuid: p.uuid,
                }),
                None => quedan.push(p),
            }
        }
        self.pendientes = quedan;
        out
    }

    fn tomar_cerrada(&mut self, agente: Option<&str>) -> Option<String> {
        let i = self
            .entradas
            .iter()
            .position(|e| e.cerrada && e.clave.agente.as_deref() == agente)?;
        Some(self.entradas.remove(i).clave.texto())
    }

    /// Bloque de texto del transcript: devuelve la `streamKey` si ya hay
    /// pareja; si no, lo deja pendiente 5 s.
    pub fn bloque(
        &mut self,
        agente: Option<&str>,
        texto: &str,
        uuid: &str,
        ahora: Ms,
    ) -> Option<String> {
        self.purgar(ahora);
        if let Some(k) = self
            .tomar(agente, texto)
            .or_else(|| self.tomar_cerrada(agente))
        {
            return Some(k);
        }
        self.pendientes.push(Pendiente {
            uuid: uuid.to_string(),
            agente: agente.map(str::to_string),
            texto: texto.to_string(),
            desde: ahora,
        });
        descartar_antiguos(&mut self.pendientes, MAX_PENDIENTES);
        None
    }

    fn tomar(&mut self, agente: Option<&str>, texto: &str) -> Option<String> {
        let objetivo = texto.trim_end();
        let i = self.entradas.iter().position(|e| {
            !e.desbordada && e.clave.agente.as_deref() == agente && e.texto.trim_end() == objetivo
        })?;
        Some(self.entradas.remove(i).clave.texto())
    }

    fn reintentar(&mut self, agente: Option<&str>) -> Vec<Emparejado> {
        let mut out = Vec::new();
        let mut quedan = Vec::new();
        for p in std::mem::take(&mut self.pendientes) {
            let k = if p.agente.as_deref() == agente {
                self.tomar(agente, &p.texto)
            } else {
                None
            };
            match k {
                Some(stream_key) => out.push(Emparejado {
                    stream_key,
                    message_uuid: p.uuid,
                }),
                None => quedan.push(p),
            }
        }
        self.pendientes = quedan;
        out
    }

    fn purgar(&mut self, ahora: Ms) {
        self.pendientes
            .retain(|p| ahora.saturating_sub(p.desde) < PENDIENTE_MAX);
        self.entradas
            .retain(|e| ahora.saturating_sub(e.desde) < ENTRADA_MAX);
    }
}

/// Deja en `v` (en orden de llegada) los `max` últimos.
fn descartar_antiguos<T>(v: &mut Vec<T>, max: usize) {
    if v.len() > max {
        let sobran = v.len() - max;
        v.drain(..sobran);
    }
}

fn mapa() -> &'static Mutex<HashMap<String, Emparejador>> {
    static M: OnceLock<Mutex<HashMap<String, Emparejador>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn con<T: Default>(id: &str, f: impl FnOnce(&mut Emparejador) -> T) -> T {
    match mapa().lock() {
        Ok(mut m) => f(m.entry(id.to_string()).or_default()),
        Err(_) => {
            tracing::error!(sesion = id, "emparejador del stream envenenado");
            T::default()
        }
    }
}

pub fn delta(id: &str, clave: &Clave, d: &str) -> Vec<Emparejado> {
    con(id, |e| e.delta(clave, d, ahora_ms()))
}

pub fn paso_fin(id: &str, clave: &Clave) -> Vec<Emparejado> {
    con(id, |e| e.paso_fin(clave, ahora_ms()))
}

/// Rellena `streamKey` de un mensaje del asistente si su texto ya tiene
/// pareja en vivo (lo llama el seguidor antes de emitirlo).
pub fn emparejar_mensaje(id: &str, m: &mut ChatMessage) {
    if m.role != "assistant" {
        return;
    }
    let Some(texto) = m.blocks.iter().find_map(|b| match b {
        Block::Text { text } => Some(text.clone()),
        _ => None,
    }) else {
        return;
    };
    let agente = m.agent_id.clone();
    let uuid = m.uuid.clone();
    m.stream_key = con(id, |e| {
        e.bloque(agente.as_deref(), &texto, &uuid, ahora_ms())
    });
}

pub fn olvidar(id: &str) {
    if let Ok(mut m) = mapa().lock() {
        m.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: Ms = 1_700_000_000_000;

    fn clave(step: u64) -> Clave {
        Clave {
            turn_id: "t1".into(),
            agente: None,
            step,
            block: 0,
        }
    }

    #[test]
    fn transcript_tras_el_ultimo_delta_empareja_al_momento() {
        let mut e = Emparejador::default();
        e.delta(&clave(0), "Hola ", T0);
        e.delta(&clave(0), "mundo", T0);
        assert_eq!(
            e.bloque(None, "Hola mundo\n", "u1", T0).as_deref(),
            Some("t1:main:0:0")
        );
        assert!(
            e.bloque(None, "Hola mundo", "u2", T0).is_none(),
            "la entrada se liberó"
        );
    }

    #[test]
    fn transcript_antes_del_ultimo_delta_empareja_con_ese_delta() {
        let mut e = Emparejador::default();
        e.delta(&clave(0), "Hola ", T0);
        assert!(e.bloque(None, "Hola mundo", "u1", T0).is_none());
        let m = e.delta(&clave(0), "mundo", T0 + 50);
        assert_eq!(
            m,
            vec![Emparejado {
                stream_key: "t1:main:0:0".into(),
                message_uuid: "u1".into()
            }]
        );
    }

    #[test]
    fn sin_el_delta_que_completa_no_hay_pareja_y_caduca() {
        let mut e = Emparejador::default();
        e.delta(&clave(0), "Hola ", T0);
        assert!(e.bloque(None, "Hola mundo", "u1", T0).is_none());
        e.delta(&clave(1), "otro", T0 + 6_000);
        assert!(
            e.pendientes.is_empty(),
            "pasados 5 s el pendiente se descarta"
        );
    }

    #[test]
    fn texto_reescrito_empareja_por_orden_tras_el_fin_de_paso() {
        let mut e = Emparejador::default();
        e.delta(&clave(0), "Ya tengo tu captura.", T0);
        assert!(
            e.bloque(None, "Tu captura ya la tengo.", "u1", T0)
                .is_none(),
            "con el paso abierto no se empareja por orden (caso negativo)"
        );
        assert_eq!(
            e.paso_fin(&clave(0), T0 + 50),
            vec![Emparejado {
                stream_key: "t1:main:0:0".into(),
                message_uuid: "u1".into()
            }]
        );
    }

    #[test]
    fn transcript_reescrito_tras_el_fin_de_paso_empareja_la_cerrada_mas_antigua() {
        let mut e = Emparejador::default();
        e.delta(&clave(0), "A", T0);
        e.paso_fin(&clave(0), T0);
        e.delta(&clave(1), "B", T0);
        assert_eq!(
            e.bloque(None, "A'", "u1", T0).as_deref(),
            Some("t1:main:0:0")
        );
        assert!(
            e.bloque(None, "B'", "u2", T0).is_none(),
            "el paso 1 sigue abierto"
        );
        assert_eq!(
            e.paso_fin(&clave(1), T0 + 10),
            vec![Emparejado {
                stream_key: "t1:main:1:0".into(),
                message_uuid: "u2".into()
            }]
        );
    }

    #[test]
    fn cada_paso_es_una_entrada_y_no_se_concatena() {
        let mut e = Emparejador::default();
        e.delta(&clave(0), "A.", T0);
        e.delta(&clave(1), "B.", T0);
        assert!(e.bloque(None, "A.B.", "u1", T0).is_none());
        assert_eq!(
            e.bloque(None, "B.", "u2", T0).as_deref(),
            Some("t1:main:1:0")
        );
    }

    /// Cada `(step, block)` nuevo abría una entrada sin límite durante los
    /// 120 s de vida: hay tope y sale la más antigua.
    #[test]
    fn las_entradas_tienen_tope_y_sale_la_mas_antigua() {
        let mut e = Emparejador::default();
        let total = u64::try_from(MAX_ENTRADAS).expect("tope") + 8;
        for step in 0..total {
            e.delta(&clave(step), &format!("t{step}"), T0);
        }
        assert_eq!(e.entradas.len(), MAX_ENTRADAS);
        assert!(
            e.bloque(None, "t0", "u0", T0).is_none(),
            "la más antigua salió"
        );
        let ultima = format!("t{}", total - 1);
        assert_eq!(
            e.bloque(None, &ultima, "u1", T0),
            Some(format!("t1:main:{}:0", total - 1))
        );
    }

    /// Los deltas de una entrada se acumulaban sin tope: por encima de
    /// `MAX_TEXTO_ENTRADA` se dejan de acumular y la entrada sigue
    /// emparejando por orden tras el `stepEnd`.
    #[test]
    fn el_texto_de_una_entrada_tiene_tope_y_empareja_por_orden() {
        let mut e = Emparejador::default();
        let trozo = "x".repeat(64 * 1024);
        for _ in 0..(MAX_TEXTO_ENTRADA / trozo.len() + 4) {
            e.delta(&clave(0), &trozo, T0);
        }
        assert!(e.entradas[0].texto.len() <= MAX_TEXTO_ENTRADA);
        assert!(e.bloque(None, "texto final", "u1", T0).is_none());
        assert_eq!(
            e.paso_fin(&clave(0), T0),
            vec![Emparejado {
                stream_key: "t1:main:0:0".into(),
                message_uuid: "u1".into()
            }]
        );
    }

    /// Los bloques del transcript sin pareja también tienen tope.
    #[test]
    fn los_pendientes_tienen_tope_y_sale_el_mas_antiguo() {
        let mut e = Emparejador::default();
        for n in 0..(MAX_PENDIENTES + 8) {
            assert!(e
                .bloque(None, &format!("p{n}"), &format!("u{n}"), T0)
                .is_none());
        }
        assert_eq!(e.pendientes.len(), MAX_PENDIENTES);
        assert_eq!(e.pendientes[0].uuid, "u8");
    }

    #[test]
    fn otro_agente_no_empareja() {
        let mut e = Emparejador::default();
        e.delta(&clave(0), "x", T0);
        assert!(e.bloque(Some("sub"), "x", "u1", T0).is_none());
    }
}
