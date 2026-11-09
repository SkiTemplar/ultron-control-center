// sesiones/cola.rs — Cola única de envíos por sesión en el backend (contrato
// de estabilidad, §5.2).
//
// Sustituye a la cola de localStorage: todas las ventanas piden y pintan la
// misma instantánea (`sesiones://queue`), y ninguna ejecuta efectos. Alta y
// envío son idempotentes por `clientId`. Estados: `queued` → `sending`
// (escrito) → `cliQueued` (en la cola nativa de la CLI) → `absorbed` (a
// mitad de turno) o `delivered` (mensaje del transcript emparejado); un fallo
// de escritura deja el elemento en `failed` con su error, nunca se pierde.
// El drenaje lo pide la máquina (`Efecto::Drenar`) y escribe **un** elemento
// por turno. La escritura real va por un `Escritor` inyectable (la instala
// el integrador sobre `gestor::send`); los comandos con puente v2 van por el
// buzón. Vive en memoria; los `queued` y `failed` (y los `sending` y
// `cliQueued`, como `queued` con aviso) se guardan con la sesión en `abiertas.json` y se
// reponen al arrancar (`persistencia.rs`, hallazgo #35).
//
// Propiedad: WP-ESTADO.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};

use super::maquina::{iso, Ms, ResumenTickets};
use super::senales::normalizar_envio;
use super::types::{
    QueueItem, QueueItemInput, QueueItemKind, QueueItemPatch, QueueOrigin, QueueState, ScreenState,
    SendDisposition, SendMode, SendOutcome, SessionStatus,
};

#[path = "cola_despacho.rs"]
mod despacho;
#[path = "cola_emparejar.rs"]
mod emparejar;
#[path = "cola_prioridad.rs"]
mod prioridad;

use despacho::despachar;
pub use despacho::{tipo_de_texto, tipo_efectivo};

/// Los `delivered` salen de la instantánea pasados 30 s.
const RETENCION_ENTREGADOS: Ms = 30_000;
const SIN_ESCRITOR: &str = "escritor del PTY no instalado (pendiente de integración)";

/// Envío listo para el PTY (texto ya con la delegación aplicada).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envio {
    pub client_id: String,
    pub kind: QueueItemKind,
    pub texto: String,
    pub adjuntos: Vec<String>,
}

/// Escritura en el PTY de la sesión. Devuelve el error real de la escritura.
pub trait Escritor: Send + Sync {
    fn escribir(&self, id: &str, envio: &Envio) -> Result<(), String>;
}

/// Lo que la cola necesita saber de la sesión para decidir.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Contexto {
    pub status: SessionStatus,
    pub screen: ScreenState,
    pub protocolo: u8,
    /// Terminal en superposición adjunta: drenaje en pausa.
    pub terminal: bool,
    /// Claude en el límite de uso: ni drena ni un envío automático sale; lo
    /// nuevo entra en la cola. «Enviar ahora» sigue escribiendo.
    pub limite: bool,
}

impl Contexto {
    /// Idle y con el prompt a la vista (o sin clasificar con puente).
    fn libre(&self) -> bool {
        let pantalla = self.screen == ScreenState::Prompt
            || (self.screen == ScreenState::Unknown && self.protocolo >= 1);
        self.status == SessionStatus::Idle && pantalla && !self.terminal && !self.limite
    }
}

#[derive(Debug, Clone)]
struct Elemento {
    item: QueueItem,
    /// Texto normalizado de lo que se escribe (`normalizar_envio`).
    norm: String,
    entregado: Option<Ms>,
    /// Última vez que se escribió en el PTY (para emparejar por orden).
    enviado: Option<Ms>,
    /// Un `popAll` de la CLI lo devolvió a la caja de la TUI y aún no se ha
    /// recuperado ni vuelto a escribir: solo estos (con los `cliQueued` y
    /// `sending`) pueden explicar el texto que `recuperar` lee de la caja.
    devuelto: bool,
}

/// Prompts del transcript que no emparejaron con nada guardados por sesión.
const MAX_SIN_PAREJA: usize = 8;
/// Prefijo común mínimo (en caracteres) para tomar un prompt sin pareja por
/// el mismo envío con el final transformado.
const PREFIJO_PARECIDO: usize = 32;
/// Se añade al motivo de un `sending` cuyo único indicio es un prompt sin
/// pareja que empieza igual: no basta para darlo por entregado (pudo ser uno
/// escrito a mano en la TUI), pero el Reintentar tiene que avisar.
pub const AVISO_TRANSFORMADO: &str = "pudo llegar transformado (un prompt del transcript      empieza igual): revisa el chat antes de reintentar";

/// Prompt del transcript que no emparejó con ningún envío.
#[derive(Debug, Clone)]
struct PromptSinPareja {
    uuid: String,
    /// Texto normalizado (`normalizar_envio`), para exigir parecido.
    norm: String,
    visto: Ms,
}

/// Colas de todas las sesiones.
#[derive(Default)]
pub struct Colas {
    mapa: Mutex<HashMap<String, Vec<Elemento>>>,
    /// Prompts del transcript sin pareja: evidencia de que la CLI recibió un
    /// envío cuyo texto transformó, si el texto se le parece.
    sin_pareja: Mutex<HashMap<String, Vec<PromptSinPareja>>>,
}

/// Texto que recibe Claude para delegar el mensaje en un subagente (el mismo
/// de `queue.ts`).
pub fn texto_delegado(text: &str) -> String {
    [
        "Delega esta tarea en un subagente en segundo plano (herramienta Agent con run_in_background y el",
        "especialista que mejor encaje) y sigue con lo tuyo; avísame con el resultado cuando termine:",
        "",
        text,
    ]
    .join("\n")
}

fn texto_envio(item: &QueueItem) -> String {
    if item.delegate {
        texto_delegado(&item.text)
    } else {
        item.text.clone()
    }
}

fn nuevo(input: QueueItemInput, origin: QueueOrigin, ahora: Ms) -> Elemento {
    // H5: un `command` con adjuntos, delegado o mal formado es un prompt. Se
    // calcula antes del literal porque este mueve `text` y `attachments`.
    let kind = tipo_efectivo(
        input.kind,
        &input.text,
        !input.attachments.is_empty() || input.delegate,
    );
    let item = QueueItem {
        client_id: input.client_id,
        text: input.text,
        attachments: input.attachments,
        delegate: input.delegate,
        kind,
        origin,
        state: QueueState::Queued,
        created_at: iso(ahora),
        sent_at: None,
        error: None,
        message_uuid: None,
    };
    Elemento {
        norm: normalizar_envio(&texto_envio(&item)),
        item,
        entregado: None,
        enviado: None,
        devuelto: false,
    }
}

impl Colas {
    fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, Vec<Elemento>>>, String> {
        self.mapa
            .lock()
            .map_err(|_| "cola de envíos envenenada".to_string())
    }

    /// Instantánea de la sesión (sin los entregados de hace más de 30 s).
    pub fn lista(&self, id: &str, ahora: Ms) -> Vec<QueueItem> {
        let Ok(mut m) = self.lock() else {
            return Vec::new();
        };
        instantanea(m.entry(id.to_string()).or_default(), ahora)
    }

    /// Como `lista`, pero una cola envenenada es un error (para persistir: una
    /// cola vacía por error no puede sustituir la guardada).
    pub fn lista_o_error(&self, id: &str, ahora: Ms) -> Result<Vec<QueueItem>, String> {
        let mut m = self.lock()?;
        Ok(instantanea(m.entry(id.to_string()).or_default(), ahora))
    }

    /// Envío desde el composer (§5.2). Idempotente por `clientId`.
    pub fn enviar(
        &self,
        id: &str,
        input: QueueItemInput,
        mode: SendMode,
        ctx: Contexto,
        w: &dyn Escritor,
        ahora: Ms,
    ) -> Result<SendOutcome, String> {
        if ctx.status == SessionStatus::Exited {
            return Err("la sesión terminó".to_string());
        }
        let client_id = input.client_id.clone();
        let escribir_ya = {
            let mut m = self.lock()?;
            let v = m.entry(id.to_string()).or_default();
            if let Some(e) = v.iter().find(|e| e.item.client_id == client_id) {
                return Ok(outcome(&e.item));
            }
            let ya = match mode {
                SendMode::Now => {
                    let dialogo = matches!(ctx.screen, ScreenState::Dialog | ScreenState::Trust);
                    if dialogo || ctx.status == SessionStatus::Waiting {
                        return Err("La TUI tiene un diálogo abierto: no se escribe".into());
                    }
                    true
                }
                SendMode::Auto => {
                    let delante = v
                        .iter()
                        .any(|e| matches!(e.item.state, QueueState::Queued | QueueState::Sending));
                    ctx.libre() && !delante
                }
            };
            v.push(nuevo(input, QueueOrigin::Ultron, ahora));
            ya
        };
        if escribir_ya {
            self.escribir(id, &client_id, ctx.protocolo, w, ahora)?;
        }
        let item = self.buscar(id, &client_id)?;
        Ok(outcome(&item))
    }

    fn buscar(&self, id: &str, client_id: &str) -> Result<QueueItem, String> {
        self.lock()?
            .get(id)
            .and_then(|v| v.iter().find(|e| e.item.client_id == client_id))
            .map(|e| e.item.clone())
            .ok_or_else(|| format!("no existe el elemento '{client_id}' en la cola"))
    }

    /// Escribe un elemento: `sending` antes de la E/S (fuera del lock) y
    /// `failed` con el error si falla. La transición `queued` → `sending` es
    /// atómica bajo el lock: si otro hilo (el drenaje frente a `enviar` o
    /// `enviar_ya`) ya lo tomó, no se despacha otra vez.
    fn escribir(
        &self,
        id: &str,
        client_id: &str,
        protocolo: u8,
        w: &dyn Escritor,
        ahora: Ms,
    ) -> Result<(), String> {
        let envio = {
            let mut m = self.lock()?;
            let e = m
                .get_mut(id)
                .and_then(|v| v.iter_mut().find(|e| e.item.client_id == client_id))
                .ok_or_else(|| format!("no existe el elemento '{client_id}' en la cola"))?;
            if e.item.state != QueueState::Queued {
                tracing::debug!(
                    sesion = id,
                    client_id,
                    estado = ?e.item.state,
                    "otro hilo ya escribió el elemento: no se despacha de nuevo"
                );
                return Ok(());
            }
            e.item.state = QueueState::Sending;
            e.item.error = None;
            e.item.sent_at = Some(iso(ahora));
            e.enviado = Some(ahora);
            e.devuelto = false;
            Envio {
                client_id: client_id.to_string(),
                kind: e.item.kind,
                texto: texto_envio(&e.item),
                adjuntos: e.item.attachments.clone(),
            }
        };
        let r = despachar(id, &envio, protocolo, w);
        if let Err(err) = &r {
            self.marcar(id, client_id, |e| {
                e.item.state = QueueState::Failed;
                e.item.error = Some(err.clone());
            })?;
        }
        r
    }

    fn marcar(
        &self,
        id: &str,
        client_id: &str,
        f: impl FnOnce(&mut Elemento),
    ) -> Result<(), String> {
        let mut m = self.lock()?;
        let e = m
            .get_mut(id)
            .and_then(|v| v.iter_mut().find(|e| e.item.client_id == client_id))
            .ok_or_else(|| format!("no existe el elemento '{client_id}' en la cola"))?;
        f(e);
        Ok(())
    }

    /// Alta sin escribir (`sesiones_queue_enqueue`); idempotente.
    pub fn encolar(
        &self,
        id: &str,
        input: QueueItemInput,
        ahora: Ms,
    ) -> Result<Vec<QueueItem>, String> {
        let mut m = self.lock()?;
        let v = m.entry(id.to_string()).or_default();
        if !v.iter().any(|e| e.item.client_id == input.client_id) {
            v.push(nuevo(input, QueueOrigin::Ultron, ahora));
        }
        Ok(instantanea(v, ahora))
    }

    /// Edita texto, adjuntos o delegar de un elemento en cola o fallido.
    pub fn editar(
        &self,
        id: &str,
        client_id: &str,
        patch: QueueItemPatch,
        ahora: Ms,
    ) -> Result<Vec<QueueItem>, String> {
        let mut m = self.lock()?;
        let v = m.entry(id.to_string()).or_default();
        let e = v
            .iter_mut()
            .find(|e| e.item.client_id == client_id)
            .ok_or_else(|| format!("no existe el elemento '{client_id}' en la cola"))?;
        let editable = e.item.origin == QueueOrigin::Ultron
            && matches!(e.item.state, QueueState::Queued | QueueState::Failed);
        if !editable {
            return Err("solo se editan los mensajes de ULTRON aún no enviados".into());
        }
        let text = patch.text.unwrap_or_else(|| e.item.text.clone());
        let attachments = patch
            .attachments
            .unwrap_or_else(|| e.item.attachments.clone());
        if text.trim().is_empty() && attachments.is_empty() {
            return Err("el mensaje se queda vacío: bórralo en su lugar".into());
        }
        e.item.text = text;
        e.item.attachments = attachments;
        e.item.delegate = patch.delegate.unwrap_or(e.item.delegate);
        let con_extras = !e.item.attachments.is_empty() || e.item.delegate;
        e.item.kind = tipo_efectivo(e.item.kind, &e.item.text, con_extras);
        e.norm = normalizar_envio(&texto_envio(&e.item));
        Ok(instantanea(v, ahora))
    }

    pub fn quitar(&self, id: &str, client_id: &str, ahora: Ms) -> Result<Vec<QueueItem>, String> {
        let mut m = self.lock()?;
        let v = m.entry(id.to_string()).or_default();
        v.retain(|e| e.item.client_id != client_id);
        Ok(instantanea(v, ahora))
    }

    pub fn mover(
        &self,
        id: &str,
        client_id: &str,
        to: usize,
        ahora: Ms,
    ) -> Result<Vec<QueueItem>, String> {
        let mut m = self.lock()?;
        let v = m.entry(id.to_string()).or_default();
        let i = v
            .iter()
            .position(|e| e.item.client_id == client_id)
            .ok_or_else(|| format!("no existe el elemento '{client_id}' en la cola"))?;
        let e = v.remove(i);
        v.insert(to.min(v.len()), e);
        Ok(instantanea(v, ahora))
    }

    /// Reintenta un `failed`: vuelve a `queued` al principio.
    pub fn reintentar(
        &self,
        id: &str,
        client_id: &str,
        ahora: Ms,
    ) -> Result<Vec<QueueItem>, String> {
        let mut m = self.lock()?;
        let v = m.entry(id.to_string()).or_default();
        let i = v
            .iter()
            .position(|e| e.item.client_id == client_id && e.item.state == QueueState::Failed)
            .ok_or_else(|| format!("'{client_id}' no está fallido"))?;
        let mut e = v.remove(i);
        e.item.state = QueueState::Queued;
        e.item.error = None;
        v.insert(0, e);
        Ok(instantanea(v, ahora))
    }

    /// «Enviar ya»: uno o todos los `queued`, seguidos, a la cola nativa.
    pub fn enviar_ya(
        &self,
        id: &str,
        client_id: Option<&str>,
        ctx: Contexto,
        w: &dyn Escritor,
        ahora: Ms,
    ) -> Result<Vec<QueueItem>, String> {
        if matches!(ctx.screen, ScreenState::Dialog | ScreenState::Trust)
            || matches!(ctx.status, SessionStatus::Exited | SessionStatus::Waiting)
        {
            return Err("La sesión no admite escritura ahora (diálogo abierto o terminada)".into());
        }
        let ids: Vec<String> = self
            .lista(id, ahora)
            .into_iter()
            .filter(|i| i.state == QueueState::Queued)
            .filter(|i| client_id.is_none_or(|c| c == i.client_id))
            .map(|i| i.client_id)
            .collect();
        for c in ids {
            self.escribir(id, &c, ctx.protocolo, w, ahora)?;
        }
        Ok(self.lista(id, ahora))
    }

    /// Drenaje (§5.2): con la sesión libre, escribe el **primer** `queued`.
    /// Devuelve el `clientId` escrito, o el error si la escritura falló (el
    /// drenaje se para: el siguiente no sale hasta otro `Drenar`).
    pub fn drenar(
        &self,
        id: &str,
        ctx: Contexto,
        w: &dyn Escritor,
        ahora: Ms,
    ) -> Result<Option<String>, String> {
        if !ctx.libre() {
            return Ok(None);
        }
        let primero = {
            let m = self.lock()?;
            let v = m.get(id).map(Vec::as_slice).unwrap_or_default();
            if v.iter().any(|e| e.item.state == QueueState::Sending) {
                return Ok(None);
            }
            v.iter()
                .find(|e| e.item.state == QueueState::Queued)
                .map(|e| e.item.client_id.clone())
        };
        let Some(c) = primero else {
            return Ok(None);
        };
        self.escribir(id, &c, ctx.protocolo, w, ahora)?;
        Ok(Some(c))
    }

    /// true si la sesión tiene algún elemento `queued` esperando turno.
    pub fn hay_en_cola(&self, id: &str) -> bool {
        self.lock().is_ok_and(|m| {
            m.get(id)
                .is_some_and(|v| v.iter().any(|e| e.item.state == QueueState::Queued))
        })
    }

    /// Envíos escritos sin evidencia, elementos en la cola nativa y en la de ULTRON.
    pub fn resumen(&self, id: &str) -> ResumenTickets {
        let Ok(m) = self.lock() else {
            return ResumenTickets::default();
        };
        let v = m.get(id).map(Vec::as_slice).unwrap_or_default();
        let cuenta = |s: QueueState| v.iter().filter(|e| e.item.state == s).count();
        ResumenTickets {
            sin_evidencia: cuenta(QueueState::Sending),
            en_cola_cli: cuenta(QueueState::CliQueued),
            en_cola_ultron: cuenta(QueueState::Queued),
        }
    }

    /// La sesión terminó: `sending` y `cliQueued` (la cola nativa vivía en
    /// la memoria del proceso muerto) → `failed` con el motivo; `queued` se
    /// conservan (Reiniciar los envía).
    pub fn fallar_envios(&self, id: &str, motivo: &str) {
        self.fallar_estados(id, motivo, &[QueueState::Sending, QueueState::CliQueued]);
    }

    /// Reinicio: el proceso viejo se mata y su cola nativa se pierde, así que
    /// los `cliQueued` pasan a `failed` con el motivo (con Reintentar). Los
    /// `sending` siguen esperando evidencia (`resolver_huerfanos`).
    pub fn fallar_cola_cli(&self, id: &str, motivo: &str) {
        self.fallar_estados(id, motivo, &[QueueState::CliQueued]);
    }

    fn fallar_estados(&self, id: &str, motivo: &str, estados: &[QueueState]) {
        let Ok(mut m) = self.lock() else {
            tracing::error!(
                sesion = id,
                "cola envenenada: no se marcan los envíos perdidos"
            );
            return;
        };
        for e in m.entry(id.to_string()).or_default() {
            if estados.contains(&e.item.state) {
                e.item.state = QueueState::Failed;
                e.item.error = Some(motivo.to_string());
            }
        }
    }

    /// La TUI está libre en el prompt: su cola nativa está vacía. `cliQueued`
    /// pasa a `delivered` (la CLI lo consumió sin que se emparejara). Cada
    /// `sending` se resuelve con los prompts del transcript sin pareja
    /// (`resolver_sending`).
    pub fn resolver_huerfanos(&self, id: &str, motivo: &str, ahora: Ms) {
        let mut sin_pareja = self.tomar_sin_pareja(id);
        let Ok(mut m) = self.lock() else { return };
        for e in m.entry(id.to_string()).or_default() {
            match e.item.state {
                QueueState::CliQueued => {
                    e.item.state = QueueState::Delivered;
                    e.entregado = Some(ahora);
                }
                QueueState::Sending => resolver_sending(id, e, &mut sin_pareja, motivo, ahora),
                _ => {}
            }
        }
    }

    /// Prompt del transcript que no emparejó con ningún envío.
    fn anotar_sin_pareja(&self, id: &str, uuid: &str, norm: &str, ahora: Ms) {
        let Ok(mut m) = self.sin_pareja.lock() else {
            return;
        };
        let v = m.entry(id.to_string()).or_default();
        v.push(PromptSinPareja {
            uuid: uuid.to_string(),
            norm: norm.to_string(),
            visto: ahora,
        });
        let sobra = v.len().saturating_sub(MAX_SIN_PAREJA);
        v.drain(..sobra);
    }

    fn tomar_sin_pareja(&self, id: &str) -> Vec<PromptSinPareja> {
        self.sin_pareja
            .lock()
            .ok()
            .and_then(|mut m| m.remove(id))
            .unwrap_or_default()
    }

    /// Repone los elementos guardados de una sesión restaurada (solo `queued`
    /// y `failed`, en su orden, detrás de lo que ya hubiera). Un `clientId`
    /// ya presente no se duplica. Devuelve cuántos entraron.
    pub fn reponer(&self, id: &str, items: Vec<QueueItem>) -> Result<usize, String> {
        let mut m = self.lock()?;
        let v = m.entry(id.to_string()).or_default();
        let mut vistos: std::collections::HashSet<String> =
            v.iter().map(|e| e.item.client_id.clone()).collect();
        let nuevos: Vec<Elemento> = items
            .into_iter()
            .filter(|i| matches!(i.state, QueueState::Queued | QueueState::Failed))
            .filter(|i| vistos.insert(i.client_id.clone()))
            .map(|item| Elemento {
                norm: normalizar_envio(&texto_envio(&item)),
                item,
                entregado: None,
                enviado: None,
                devuelto: false,
            })
            .collect();
        let n = nuevos.len();
        v.extend(nuevos);
        Ok(n)
    }

    /// Envenena el lock de la cola (para probar los caminos de error).
    #[cfg(test)]
    pub fn envenenar(&self) {
        std::thread::scope(|s| {
            let _ = s
                .spawn(|| {
                    let _g = self.mapa.lock();
                    panic!("envenena la cola de prueba");
                })
                .join();
        });
    }

    pub fn olvidar(&self, id: &str) {
        if let Ok(mut m) = self.lock() {
            m.remove(id);
        }
        self.tomar_sin_pareja(id);
    }
}

/// El prompt sin pareja `prompt` puede ser el envío `envio` transformado por
/// la CLI: lo contiene entero o comparten los primeros `PREFIJO_PARECIDO`
/// caracteres. Ambos textos ya están normalizados.
pub(super) fn parecido(prompt: &str, envio: &str) -> bool {
    contiene(prompt, envio) || mismo_principio(prompt, envio)
}

/// `prompt` contiene entero el envío (el envoltorio de un pegado, una marca
/// de imagen añadida): evidencia de entrega.
pub(super) fn contiene(prompt: &str, envio: &str) -> bool {
    !envio.is_empty() && prompt.contains(envio)
}

/// Solo comparten los primeros `PREFIJO_PARECIDO` caracteres: puede ser el
/// envío con el final transformado o un prompt escrito a mano que empieza
/// igual (una plantilla).
fn mismo_principio(prompt: &str, envio: &str) -> bool {
    let comun = prompt
        .chars()
        .zip(envio.chars())
        .take_while(|(a, b)| a == b)
        .count();
    comun >= PREFIJO_PARECIDO
}

/// `sending` sin pareja al resolver los huérfanos. Un prompt sin pareja visto
/// después de escribirlo que lo contiene entero lo entrega con ese mensaje,
/// en orden: la CLI lo recibió con el texto transformado y reenviarlo lo
/// duplicaría. Uno que solo empieza igual no basta (pudo escribirse a mano en
/// la TUI): `failed` con `AVISO_TRANSFORMADO` en el motivo, para que el
/// Reintentar pida confirmación. Sin indicio, `failed` con el motivo.
fn resolver_sending(
    id: &str,
    e: &mut Elemento,
    sin_pareja: &mut Vec<PromptSinPareja>,
    motivo: &str,
    ahora: Ms,
) {
    let enviado = e.enviado.unwrap_or(0);
    let buscar = |f: fn(&str, &str) -> bool| {
        sin_pareja
            .iter()
            .position(|p| p.visto >= enviado && f(&p.norm, &e.norm))
    };
    if let Some(i) = buscar(contiene) {
        let p = sin_pareja.remove(i);
        return entregar_por_orden(id, e, p.uuid, ahora);
    }
    match buscar(mismo_principio) {
        Some(i) => {
            sin_pareja.remove(i);
            fallar_huerfano(id, e, &format!("{motivo}: {AVISO_TRANSFORMADO}"));
        }
        None => fallar_huerfano(id, e, motivo),
    }
}

fn entregar_por_orden(id: &str, e: &mut Elemento, uuid: String, ahora: Ms) {
    tracing::info!(
        sesion = id,
        client_id = %e.item.client_id,
        message_uuid = %uuid,
        "envío sin pareja por texto: entregado por orden con un prompt del transcript"
    );
    e.item.state = QueueState::Delivered;
    e.item.message_uuid = Some(uuid);
    e.entregado = Some(ahora);
}

/// `sending` sin evidencia: `failed`. El log lleva la longitud y un resumen
/// del texto normalizado para reconocer la próxima transformación de la CLI
/// sin volcar el texto.
fn fallar_huerfano(id: &str, e: &mut Elemento, motivo: &str) {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    e.norm.hash(&mut h);
    tracing::warn!(
        sesion = id,
        client_id = %e.item.client_id,
        largo = e.norm.chars().count(),
        resumen = format!("{:016x}", h.finish()),
        "envío sin confirmar de la CLI: pasa a failed"
    );
    e.item.state = QueueState::Failed;
    e.item.error = Some(motivo.to_string());
}

fn outcome(item: &QueueItem) -> SendOutcome {
    SendOutcome {
        client_id: item.client_id.clone(),
        disposition: if item.state == QueueState::Queued {
            SendDisposition::Queued
        } else {
            SendDisposition::Written
        },
    }
}

fn instantanea(v: &mut Vec<Elemento>, ahora: Ms) -> Vec<QueueItem> {
    v.retain(|e| {
        e.entregado
            .is_none_or(|t| ahora.saturating_sub(t) < RETENCION_ENTREGADOS)
    });
    v.iter().map(|e| e.item.clone()).collect()
}

// ---------------------------------------------------------------------------
// Instancia global, escritor inyectable y eventos
// ---------------------------------------------------------------------------

pub fn global() -> &'static Colas {
    static C: OnceLock<Colas> = OnceLock::new();
    C.get_or_init(Colas::default)
}

fn ranura() -> &'static RwLock<Option<Arc<dyn Escritor>>> {
    static E: OnceLock<RwLock<Option<Arc<dyn Escritor>>>> = OnceLock::new();
    E.get_or_init(|| RwLock::new(None))
}

/// Instala el escritor real (ESTADO-B: sobre `gestor::send`).
pub fn instalar_escritor(w: Arc<dyn Escritor>) {
    match ranura().write() {
        Ok(mut g) => *g = Some(w),
        Err(_) => tracing::error!("ranura del escritor envenenada"),
    }
}

struct SinEscritor;

impl Escritor for SinEscritor {
    fn escribir(&self, id: &str, _envio: &Envio) -> Result<(), String> {
        tracing::error!(sesion = id, "{SIN_ESCRITOR}");
        Err(SIN_ESCRITOR.to_string())
    }
}

/// Escritor instalado o uno que falla de forma explícita.
pub fn escritor() -> Arc<dyn Escritor> {
    ranura()
        .read()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| Arc::new(SinEscritor))
}

/// Emite `sesiones://queue` con la instantánea de la sesión y marca
/// `abiertas.json` para reescribirse (`persistencia.rs`).
pub fn emitir(id: &str, items: &[QueueItem]) {
    super::registro::emit(
        super::types::ev::QUEUE,
        serde_json::json!({ "id": id, "items": items }),
    );
    super::persistencia::marcar();
}

pub fn emitir_actual(id: &str) {
    let items = global().lista(id, super::buzon::ahora_ms());
    emitir(id, &items);
}

/// Texto que estaba en la entrada de la TUI y que se recupera como elemento
/// de la cola: lo previo al prompt en el arranque (`entrada.rs`) o la caja no
/// vacía que bloquea un envío (G3 en `gestor::send`). Si empareja con un
/// elemento pendiente, ese vuelve a `queued` al principio; si no, entra uno
/// nuevo `origin:"cli"` en `failed`, que no se drena solo
/// (`emparejar::AVISO_RECUPERADO`). Firma congelada en la fase 0a.
#[allow(
    dead_code,
    reason = "firma congelada: la llaman entrada.rs y gestor::send de WP-PTY"
)]
pub fn recuperar_entrada(id: &str, texto: String) {
    global().recuperar(id, &texto, None, super::buzon::ahora_ms());
    emitir_actual(id);
}

/// Como `recuperar_entrada`, pero durante la escritura del envío
/// `en_vuelo` (G3 en `gestor::escribir_pegado`): ese envío no se reencola,
/// porque el pegado se reescribe justo después y el drenaje lo duplicaría.
pub fn recuperar_entrada_excepto(id: &str, texto: String, en_vuelo: &str) {
    global().recuperar(id, &texto, Some(en_vuelo), super::buzon::ahora_ms());
    emitir_actual(id);
}

#[cfg(test)]
#[path = "tests_cola.rs"]
mod tests;

#[cfg(test)]
#[path = "tests_cola_emparejar.rs"]
mod tests_emparejar;
