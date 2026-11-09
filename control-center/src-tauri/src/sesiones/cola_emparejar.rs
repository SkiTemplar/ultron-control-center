// sesiones/cola_emparejar.rs — Emparejamiento de la cola con lo que registra
// la CLI (contrato de estabilidad, §5.2): `queue-operation` del transcript,
// mensajes de usuario y `queued_command`, y el evento `prompt` del puente.
// Texto normalizado con `senales::normalizar_envio`, FIFO entre los
// pendientes de la sesión: el primero que coincide gana. Las
// `<task-notification>` se ignoran.
//
// Propiedad: WP-ESTADO.

use super::{nuevo, Colas, Elemento};
use crate::sesiones::maquina::Ms;
use crate::sesiones::senales::normalizar_envio;
use crate::sesiones::transcript::clases::OpCola;
use crate::sesiones::types::{QueueItemInput, QueueItemKind, QueueOrigin, QueueState};

/// Aviso que acompaña a un `popAll` que devolvió elementos a la cola.
pub const AVISO_POPALL: &str = "Devuelto a la cola tras interrumpir";

/// Resultado de emparejar: `clientId` del elemento, si lo hubo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Emparejado {
    pub client_id: String,
}

/// Por qué un mensaje no emparejó. Solo `SinCandidato` sugiere un envío que
/// la CLI transformó: un `uuid` ya emparejado (la salida de un `!comando`
/// lo reemite) o una sesión sin cola no prueban nada.
enum SinPar {
    NoAplica,
    SinCandidato,
}

fn es_tarea(t: &str) -> bool {
    t.trim_start().starts_with("<task-notification>")
}

fn primero<'a>(
    v: &'a mut [Elemento],
    norm: &str,
    estados: &[QueueState],
) -> Option<&'a mut Elemento> {
    v.iter_mut()
        .find(|e| estados.contains(&e.item.state) && e.norm == norm)
}

fn de_cli(texto: &str, estado: QueueState, ahora: Ms) -> Elemento {
    let input = QueueItemInput {
        client_id: format!("cli:{}", uuid::Uuid::new_v4()),
        text: texto.to_string(),
        attachments: Vec::new(),
        delegate: false,
        kind: QueueItemKind::Prompt,
    };
    let mut e = nuevo(input, QueueOrigin::Cli, ahora);
    e.item.state = estado;
    e
}

impl Colas {
    /// Operación de la cola nativa. Devuelve el aviso para la ventana si un
    /// `popAll` devolvió elementos a la cola.
    pub fn op_cli(&self, id: &str, op: &OpCola, ahora: Ms) -> Option<&'static str> {
        let mut m = self.lock().ok()?;
        let v = m.entry(id.to_string()).or_default();
        match op {
            OpCola::Enqueue(t) if !es_tarea(t) => {
                let n = normalizar_envio(t);
                match primero(v, &n, &[QueueState::Sending]) {
                    Some(e) => e.item.state = QueueState::CliQueued,
                    None => v.push(de_cli(t, QueueState::CliQueued, ahora)),
                }
                None
            }
            OpCola::Remove(t) if !es_tarea(t) => {
                let n = normalizar_envio(t);
                if let Some(e) = primero(v, &n, &[QueueState::CliQueued, QueueState::Sending]) {
                    e.item.state = QueueState::Absorbed;
                }
                None
            }
            OpCola::PopAll(t) => pop_all(v, t, ahora),
            _ => None,
        }
    }

    /// Mensaje del transcript (prompt o `queued_command`) emparejado: fija
    /// `messageUuid` y pasa a `delivered` o `absorbed`.
    pub fn entregado(
        &self,
        id: &str,
        texto: &str,
        uuid: &str,
        absorbido: bool,
        ahora: Ms,
    ) -> Option<Emparejado> {
        if es_tarea(texto) {
            return None;
        }
        let n = normalizar_envio(texto);
        match self.emparejar_mensaje(id, uuid, absorbido, ahora, |e| e.norm == n) {
            Ok(par) => Some(par),
            Err(SinPar::SinCandidato) if !n.is_empty() => {
                self.anotar_sin_pareja(id, uuid, &n, ahora);
                None
            }
            Err(_) => None,
        }
    }

    /// `<bash-input>` del transcript: empareja el `!comando` enviado (la CLI
    /// registra el comando sin el `!`).
    pub fn bash_entregado(
        &self,
        id: &str,
        comando: &str,
        uuid: &str,
        absorbido: bool,
        ahora: Ms,
    ) -> Option<Emparejado> {
        let n = normalizar_envio(comando);
        self.emparejar_mensaje(id, uuid, absorbido, ahora, |e| {
            e.item.kind == QueueItemKind::Bash
                && normalizar_envio(e.item.text.trim_start().trim_start_matches('!')) == n
        })
        .ok()
    }

    /// Primer candidato que cumple `coincide`: fija `messageUuid` y pasa a
    /// `delivered` o `absorbed`. Un mensaje ya emparejado no empareja otro
    /// elemento (la salida de un `!comando` reemite su mismo `uuid`). Un
    /// `failed` sin mensaje también empareja, pero solo si no hay otro
    /// candidato: la CLI pudo recibirlo después de darlo por no confirmado
    /// (y así no queda un Reintentar que lo duplique).
    fn emparejar_mensaje(
        &self,
        id: &str,
        uuid: &str,
        absorbido: bool,
        ahora: Ms,
        coincide: impl Fn(&Elemento) -> bool,
    ) -> Result<Emparejado, SinPar> {
        let mut m = self.lock().map_err(|_| SinPar::NoAplica)?;
        let v = m.get_mut(id).ok_or(SinPar::NoAplica)?;
        if v.iter()
            .any(|e| e.item.message_uuid.as_deref() == Some(uuid))
        {
            return Err(SinPar::NoAplica);
        }
        let i = v
            .iter()
            .position(|e| pendiente_de_mensaje(e) && coincide(e))
            .or_else(|| v.iter().position(|e| fallido_sin_mensaje(e) && coincide(e)))
            .ok_or(SinPar::SinCandidato)?;
        let e = &mut v[i];
        e.item.state = if absorbido {
            QueueState::Absorbed
        } else {
            QueueState::Delivered
        };
        e.item.error = None;
        e.item.message_uuid = Some(uuid.to_string());
        e.entregado = Some(ahora);
        Ok(Emparejado {
            client_id: e.item.client_id.clone(),
        })
    }

    /// Evento `prompt` del puente: con `turnId` del turno en curso, el envío
    /// está en la cola nativa; sin él, abre turno (entregado).
    pub fn prompt_entrado(&self, id: &str, texto: &str, en_turno: bool, ahora: Ms) {
        let n = normalizar_envio(texto);
        let Ok(mut m) = self.lock() else { return };
        let Some(v) = m.get_mut(id) else { return };
        if let Some(e) = primero(v, &n, &[QueueState::Sending]) {
            if en_turno {
                e.item.state = QueueState::CliQueued;
            } else {
                e.item.state = QueueState::Delivered;
                e.entregado = Some(ahora);
            }
        }
    }

    /// `commandStart`/`commandEnd` del puente: evidencia de entrega del
    /// primer `/nombre` en `sending`. Un `/clear` o `/compact` cambia de
    /// conversación y nunca aparece como mensaje que emparejar; sin esto se
    /// quedaba en `sending` y la sesión, en `working` para siempre.
    pub fn comando_entregado(&self, id: &str, nombre: &str, ahora: Ms) -> bool {
        let nombre = nombre.trim().trim_start_matches('/');
        let Ok(mut m) = self.lock() else { return false };
        let Some(v) = m.get_mut(id) else { return false };
        let hit = v.iter_mut().find(|e| {
            matches!(e.item.state, QueueState::Sending | QueueState::CliQueued)
                && (e.item.kind == QueueItemKind::Command
                    || e.item.text.trim_start().starts_with('/'))
                && e.item
                    .text
                    .trim()
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    == Some(nombre)
        });
        let Some(e) = hit else { return false };
        e.item.state = QueueState::Delivered;
        e.entregado = Some(ahora);
        true
    }

    /// Texto recuperado de la caja de la TUI (`recuperar_entrada`). Solo
    /// pueden explicarlo los elementos que estaban en la caja: `sending`,
    /// `cliQueued` (la cola nativa que el `popAll` devuelve) y los `queued`
    /// que un `popAll` ya devolvió. Si el texto es uno de ellos, o la
    /// concatenación exacta y en orden de varios, vuelven a `queued` al
    /// principio; si no, entra uno nuevo de la CLI en `failed`, que no se
    /// drena solo (`recuperado`). En la duda se crea: un
    /// duplicado visible se borra, un texto perdido no se recupera.
    /// `en_vuelo` es el envío que se está escribiendo (G3): si la caja tenía
    /// su mismo texto, no se toca nada, porque el pegado se reescribe ahora;
    /// si la caja traía un tramo que lo incluye, solo vuelven los demás.
    pub fn recuperar(&self, id: &str, texto: &str, en_vuelo: Option<&str>, ahora: Ms) {
        if texto.trim().is_empty() {
            return;
        }
        let n = normalizar_envio(texto);
        let Ok(mut m) = self.lock() else { return };
        let v = m.entry(id.to_string()).or_default();
        let es_vuelo = |e: &Elemento| en_vuelo == Some(e.item.client_id.as_str());
        if v.iter().any(|e| es_vuelo(e) && e.norm == n) {
            return;
        }
        // El envío en vuelo entra en la búsqueda del tramo (la caja pudo
        // traerlo junto a otros devueltos) pero no se reencola: se reescribe.
        let en_caja: Vec<usize> = v
            .iter()
            .enumerate()
            .filter(|(_, e)| estuvo_en_caja(e))
            .map(|(i, _)| i)
            .collect();
        match tramo_de_la_caja(v, &en_caja, &n) {
            Some(tramo) => {
                let sin_vuelo = tramo.into_iter().filter(|&i| !es_vuelo(&v[i])).collect();
                reencolar_al_principio(v, sin_vuelo);
            }
            // Ya recuperado antes y sin decidir: no se duplica.
            None if v.iter().any(|e| es_recuperado(e) && e.norm == n) => {}
            None => v.insert(0, recuperado(texto, ahora)),
        }
    }
}

/// Error con el que entra el texto recuperado de la caja que no es ningún
/// envío pendiente: un borrador del usuario o algo escrito en la terminal.
pub const AVISO_RECUPERADO: &str =
    "recuperado de la caja de la TUI; no se envía solo: Reintentar para enviarlo o ✕ para descartarlo";

/// El texto recuperado que no explica ningún envío pendiente no lo pidió
/// enviar nadie: entra como `failed` (que el drenaje no toca) con
/// `AVISO_RECUPERADO`, y el usuario decide con Reintentar o ✕.
fn recuperado(texto: &str, ahora: Ms) -> Elemento {
    let mut e = de_cli(texto, QueueState::Failed, ahora);
    e.item.error = Some(AVISO_RECUPERADO.to_string());
    e
}

fn es_recuperado(e: &Elemento) -> bool {
    e.item.state == QueueState::Failed && e.item.error.as_deref() == Some(AVISO_RECUPERADO)
}

/// Elemento que puede estar en la caja de la TUI al recuperarla.
fn estuvo_en_caja(e: &Elemento) -> bool {
    match e.item.state {
        QueueState::Sending | QueueState::CliQueued => true,
        QueueState::Queued => e.devuelto,
        _ => false,
    }
}

/// Tramo contiguo (en el orden de la cola) de `en_caja` cuyo texto, unido
/// con saltos de línea como hace el `popAll` de la CLI y normalizado, es
/// exactamente `n`. Primero se prueba cada elemento solo.
fn tramo_de_la_caja(v: &[Elemento], en_caja: &[usize], n: &str) -> Option<Vec<usize>> {
    if n.is_empty() {
        return None;
    }
    if let Some(&i) = en_caja.iter().find(|&&i| v[i].norm == n) {
        return Some(vec![i]);
    }
    for ini in 0..en_caja.len() {
        for fin in ini + 2..=en_caja.len() {
            let tramo = &en_caja[ini..fin];
            let unido: Vec<String> = tramo
                .iter()
                .map(|&i| super::texto_envio(&v[i].item))
                .collect();
            if normalizar_envio(&unido.join("\n")) == n {
                return Some(tramo.to_vec());
            }
        }
    }
    None
}

/// Los elementos del tramo vuelven a `queued`, al principio y en su orden.
fn reencolar_al_principio(v: &mut Vec<Elemento>, tramo: Vec<usize>) {
    let mut delante = Vec::with_capacity(tramo.len());
    let mut resto = Vec::with_capacity(v.len());
    for (i, mut e) in v.drain(..).enumerate() {
        if tramo.contains(&i) {
            e.item.state = QueueState::Queued;
            e.devuelto = false;
            delante.push(e);
        } else {
            resto.push(e);
        }
    }
    delante.extend(resto);
    *v = delante;
}

/// Candidato normal a emparejar con un mensaje del transcript.
fn pendiente_de_mensaje(e: &Elemento) -> bool {
    matches!(
        e.item.state,
        QueueState::Sending | QueueState::CliQueued | QueueState::Absorbed
    ) || (e.item.state == QueueState::Delivered && e.item.message_uuid.is_none())
}

fn fallido_sin_mensaje(e: &Elemento) -> bool {
    e.item.state == QueueState::Failed && e.item.message_uuid.is_none()
}

/// Los `cliQueued` vuelven a `queued` al principio, en su orden, marcados
/// como devueltos a la caja; el texto que no es exactamente uno de los que
/// están en la caja, o la concatenación en orden de varios, entra como
/// elemento nuevo de la CLI (también devuelto).
fn pop_all(v: &mut Vec<Elemento>, texto: &str, ahora: Ms) -> Option<&'static str> {
    let (mut devueltos, resto): (Vec<Elemento>, Vec<Elemento>) = v
        .drain(..)
        .partition(|e| e.item.state == QueueState::CliQueued);
    for e in &mut devueltos {
        e.item.state = QueueState::Queued;
        e.devuelto = true;
    }
    let delante = devueltos.len();
    devueltos.extend(resto);
    let n = normalizar_envio(texto);
    let en_caja: Vec<usize> = (0..devueltos.len())
        .filter(|&i| estuvo_en_caja(&devueltos[i]))
        .collect();
    let cubierto = tramo_de_la_caja(&devueltos, &en_caja, &n).is_some();
    let nuevo = (!cubierto && !n.is_empty() && !es_tarea(texto)).then(|| {
        let mut e = de_cli(texto, QueueState::Queued, ahora);
        e.devuelto = true;
        e
    });
    let hay = delante > 0 || nuevo.is_some();
    if let Some(e) = nuevo {
        devueltos.insert(delante, e);
    }
    *v = devueltos;
    hay.then_some(AVISO_POPALL)
}
