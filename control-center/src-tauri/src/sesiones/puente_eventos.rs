// sesiones/puente_eventos.rs — Lógica de las rutas del puente (contrato de
// estabilidad, §6.1-§6.4).
//
// `hello` (protocolo 2: generación por hello aceptado, buzón habilitado y
// `launchPermissionMode` en la respuesta; sin `protocol`, protocolo 1),
// lotes de `PuenteEvent` con `seq` por generación (duplicados descartados,
// huecos al log, tipos desconocidos tolerados; un lote de una generación
// anterior se responde `stale` con la vigente y el mod lo reenvía
// renumerado), asks asíncronos con sondeo
// multiplexado, buzón (`inbox`/`result`) y `fill`. Los eventos se traducen a
// señales de la máquina (`senales::emitir`) y a eventos de la ventana; el
// texto en vivo se empareja con el transcript en `puente_stream.rs`.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use super::buzon;
use super::preguntas::{resultado_json, Broker, ASKS_LLENOS};
use super::puente::{sesion_id, PuenteHandler, RouteError};
use super::registro::{self, Sink};
use super::senales::{self, Senal};
use super::types::{ev, AskCancelReason, OpResult, Usage};

#[path = "puente_aplicar.rs"]
mod aplicar;
#[path = "puente_stream.rs"]
pub mod stream;

/// Instancias vetadas que se recuerdan por sesión: cada `hello` rechazado
/// con un `instanceId` nuevo añadía una entrada sin límite.
const MAX_VETADAS: usize = 64;

/// Espera máxima de los sondeos largos (`ask/wait`, `inbox`).
pub const SONDEO_LARGO: Duration = Duration::from_secs(20);

pub struct SesionesPuente {
    pub sink: Arc<dyn Sink>,
    pub broker: Arc<Broker>,
    /// Espera de los sondeos largos (20 s; menos en los tests).
    pub espera: Duration,
}

impl SesionesPuente {
    pub fn new(sink: Arc<dyn Sink>, broker: Arc<Broker>) -> Self {
        Self {
            sink,
            broker,
            espera: SONDEO_LARGO,
        }
    }
}

/// Uso acumulado del turno principal abierto (base de `sesiones://turn`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AcumTurno {
    pub turn_id: String,
    pub usage: Option<Usage>,
    pub subagentes: Vec<Usage>,
}

#[derive(Default)]
struct EstadoPuente {
    protocolo: u8,
    generacion: u32,
    ultimo_seq: u64,
    turno: AcumTurno,
    /// Último `hello` aceptado con sid: la TUI dueña.
    dueno: Option<Dueno>,
    /// `instanceId` de los procesos rechazados por arranque ajeno: ningún
    /// `hello` suyo vuelve a entrar. Es la identidad del proceso, no la de
    /// la conversación: el dueño puede hacer `/resume` del sid de un hijo.
    /// Acotada a `MAX_VETADAS` (se olvida la más antigua).
    vetadas: VecDeque<String>,
}

/// Dueño de la sesión: PTY, conversación y proceso del mod que la anunció.
#[derive(Debug, Clone)]
struct Dueno {
    pty: String,
    sid: String,
    /// `instanceId` del mod: estable entre `/clear` y `/resume`, distinto en
    /// cada proceso. `None` con un mod anterior.
    instancia: Option<String>,
    /// `helloSeq` del anuncio aceptado (monótono por proceso).
    anuncio: Option<u64>,
}

/// Lo que dice un `hello` de quién es y en qué orden lo anunció.
struct Anuncio<'a> {
    pty: &'a str,
    sid: Option<&'a str>,
    instancia: Option<&'a str>,
    seq: Option<u64>,
}

/// Qué hacer con un `hello`.
#[derive(Debug, PartialEq, Eq)]
enum Veredicto {
    Aceptar,
    /// Otro `claude` en el mismo PTY: 409 terminal.
    Rechazar,
    /// Cambio de sid de un mod sin `instanceId`: 409 con aviso de actualizar.
    ModAntiguo,
    /// Reintento del anuncio ya aceptado (se perdió la respuesta): misma
    /// generación, sin volver a aplicarlo.
    Repetido,
    /// Reintento de un anuncio que otro posterior del mismo proceso ya
    /// sustituyó: se responde sin aplicar y sin rechazo.
    Sustituido,
}

/// Por qué no se admite un lote de `/v1/events`.
enum Rechazo {
    /// Generación anterior: `stale` con la vigente, el mod lo reenvía.
    Viejo(u32),
    /// Generación 0 con un dueño ya aceptado: es de un `claude` cuyo `hello`
    /// nunca se aceptó (el hijo rechazado con 409).
    SinHello,
}

fn puentes() -> &'static Mutex<HashMap<String, EstadoPuente>> {
    static P: OnceLock<Mutex<HashMap<String, EstadoPuente>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Estado del puente de la sesión. Un lock envenenado (pánico de un handler
/// bajo `catch_unwind` con el lock tomado) no se trata como ausente: los
/// datos siguen siendo válidos, y el veto de procesos hijos, la generación y
/// el `seq` no pueden fallar en abierto.
fn con_puente<T>(id: &str, f: impl FnOnce(&mut EstadoPuente) -> T) -> T {
    let mut m = bloquear_puentes();
    f(m.entry(id.to_string()).or_default())
}

fn bloquear_puentes() -> std::sync::MutexGuard<'static, HashMap<String, EstadoPuente>> {
    static AVISADO: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    puentes().lock().unwrap_or_else(|e| {
        if !AVISADO.swap(true, std::sync::atomic::Ordering::Relaxed) {
            tracing::error!("estado del puente envenenado: se recupera el último dato válido");
        }
        e.into_inner()
    })
}

/// Envenena el lock del estado del puente (para probar que no falla en
/// abierto).
#[cfg(test)]
pub(super) fn envenenar_puentes() {
    let _ = std::thread::spawn(|| {
        let _g = puentes().lock();
        panic!("envenena el estado del puente de prueba");
    })
    .join();
}

/// Uso acumulado del turno `turn_id` de la sesión, si es el último visto.
pub fn acumulado_turno(id: &str, turn_id: &str) -> Option<AcumTurno> {
    con_puente(id, |p| {
        (p.turno.turn_id == turn_id).then(|| p.turno.clone())
    })
}

/// Cerrojo de los `hello` de una sesión. Cada petición HTTP corre en su hilo:
/// sin él, un anuncio con veredicto aceptado podía aplicarse después de otro
/// posterior (reinstalando su transcript) y un duplicado respondía la
/// generación anterior a la aplicación del original.
fn cerrojos_hello() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Mutex<()>>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    C.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn cerrojo_hello(id: &str) -> Arc<Mutex<()>> {
    cerrojos_hello().entry(id.to_string()).or_default().clone()
}

/// Instancias vetadas de la sesión (tope de `vetadas`).
#[cfg(test)]
pub(super) fn vetadas(id: &str) -> usize {
    con_puente(id, |p| p.vetadas.len())
}

/// Olvida el estado del puente de una sesión cerrada.
pub fn olvidar(id: &str) {
    bloquear_puentes().remove(id);
    cerrojos_hello().remove(id);
    stream::olvidar(id);
}

fn ok() -> Value {
    json!({ "ok": true })
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

fn require_session(id: &str) -> Result<(), RouteError> {
    if registro::exists(id) {
        Ok(())
    } else {
        Err(RouteError::not_found(format!("sesión desconocida: {id}")))
    }
}

/// `transcriptPath` solo se acepta si es un `.jsonl` bajo `~/.claude/projects`.
fn valid_transcript(p: &str) -> Option<PathBuf> {
    let base = registro::claude_projects_dir()?;
    let path = PathBuf::from(p);
    bajo_base(&base, &path).then_some(path)
}

/// `.jsonl` bajo `base` sin componentes `..` y, si ya existe en disco,
/// también bajo `base` una vez resuelto (`resuelve_bajo_base`).
pub(super) fn bajo_base(base: &Path, path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("jsonl")
        && !path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        && path.starts_with(base)
        && resuelve_bajo_base(base, path)
}

/// Un junction o enlace bajo `projects` pasa la comprobación léxica y apunta
/// fuera: se resuelve el fichero (o su directorio, si el fichero aún no
/// existe) y se compara con la base resuelta. Lo que aún no existe no se
/// puede resolver y se queda con la comprobación léxica.
fn resuelve_bajo_base(base: &Path, path: &Path) -> bool {
    let real = std::fs::canonicalize(path)
        .or_else(|e| path.parent().map_or(Err(e), std::fs::canonicalize));
    match (real, std::fs::canonicalize(base)) {
        (Ok(r), Ok(b)) => r.starts_with(b),
        (Ok(_), Err(_)) => false,
        (Err(_), _) => true,
    }
}

/// `claudeSessionId` con forma de UUID con guiones (la de Claude Code): el
/// sid compone rutas (`<slug>/<sid>.jsonl`, `<slug>/<sid>/subagents`) y uno
/// absoluto, UNC o con `..` las sacaba de `~/.claude/projects`.
fn sid_valido(sid: &str) -> bool {
    sid.len() == 36 && uuid::Uuid::try_parse(sid).is_ok()
}

/// Generación vigente o `stale` si `body.generation` es anterior.
fn es_viejo(id: &str, body: &Value) -> bool {
    let gen = body.get("generation").and_then(Value::as_u64);
    let actual = con_puente(id, |p| p.generacion);
    gen.is_some_and(|g| g < u64::from(actual))
}

/// Lote admitido: sus eventos nuevos en orden, o el motivo del rechazo. Un
/// cliente legítimo solo envía tras un `hello` aceptado (generación ≥ 1), así
/// que la generación 0 con un `hello` ya aceptado es del hijo rechazado. La
/// generación y el `seq` se comprueban bajo el mismo lock, así que un `hello`
/// no se cuela entre ambos.
fn admitir<'a>(id: &str, gen: Option<u64>, events: &'a [Value]) -> Result<Vec<&'a Value>, Rechazo> {
    con_puente(id, |p| {
        // El protocolo 2 siempre manda `generation`: sin ella, como la 0
        // (omitir el campo no esquiva el rechazo). El protocolo 1 no la manda.
        let gen = gen.or((p.protocolo >= 2).then_some(0));
        if gen == Some(0) && p.generacion > 0 {
            return Err(Rechazo::SinHello);
        }
        if gen.is_some_and(|g| g < u64::from(p.generacion)) {
            return Err(Rechazo::Viejo(p.generacion));
        }
        Ok(events.iter().filter(|e| nuevo_seq(id, p, e)).collect())
    })
}

/// `seq` por generación: descarta los repetidos y registra los huecos.
fn nuevo_seq(id: &str, p: &mut EstadoPuente, e: &Value) -> bool {
    let Some(seq) = e.get("seq").and_then(Value::as_u64) else {
        return true;
    };
    if seq <= p.ultimo_seq {
        tracing::debug!(sesion = id, seq, "evento repetido descartado");
        return false;
    }
    if seq > p.ultimo_seq + 1 {
        tracing::debug!(
            sesion = id,
            desde = p.ultimo_seq,
            hasta = seq,
            "hueco de seq"
        );
    }
    p.ultimo_seq = seq;
    true
}

/// Decide un `hello` y, si se acepta con sid, lo deja como dueño, todo bajo
/// el mismo lock (dos anuncios concurrentes no se cruzan).
///
/// Un proceso hijo interactivo hereda `ULTRON_PUENTE_*` y `ULTRON_SESION_ID`
/// y su `hello` de arranque vaciaba el chat: un `hello` de otra instancia con
/// otro sid en el PTY del dueño se rechaza, sea cual sea su `source` (un
/// `claude --resume` hijo anuncia `start` y `resume` y el orden de llegada no
/// está garantizado), y la instancia queda vetada.
/// `/clear`, `/resume`, `compact`, `fork` y los `hello` de turno del dueño
/// pasan aunque traigan el sid de un hijo; una recarga del mod (instancia
/// nueva, mismo sid) también; un reinicio trae un PTY nuevo. Un `hello` de
/// otra instancia sin sid también se rechaza: solo el sid del dueño identifica
/// una recarga. Sin `instanceId` (mod anterior) no hay veto posible, así que
/// cualquier `hello` sin el sid del dueño se rechaza (`ModAntiguo`): el mod y
/// la app se publican juntos y el dueño legítimo siempre lo trae.
fn veredicto(p: &mut EstadoPuente, a: &Anuncio) -> Veredicto {
    if a.instancia
        .is_some_and(|i| p.vetadas.iter().any(|v| v == i))
    {
        return Veredicto::Rechazar;
    }
    let v = match p.dueno.as_ref().filter(|d| d.pty == a.pty) {
        None => Veredicto::Aceptar,
        Some(d) if a.instancia.is_some() && a.instancia == d.instancia.as_deref() => {
            match a.seq.zip(d.anuncio).map(|(s, ult)| s.cmp(&ult)) {
                Some(std::cmp::Ordering::Less) => Veredicto::Sustituido,
                Some(std::cmp::Ordering::Equal) => Veredicto::Repetido,
                _ => Veredicto::Aceptar,
            }
        }
        // Recarga del mod del dueño: otra instancia (o ninguna), mismo sid.
        Some(d) if a.sid == Some(d.sid.as_str()) => Veredicto::Aceptar,
        // Otra instancia con otro sid o sin él, sea cual sea el `source`: el
        // hijo anuncia `start` y `resume` por conexiones distintas y el orden
        // de llegada no está garantizado; sin sid, su `transcriptPath` seguía
        // repuntando el transcript y subiendo la generación.
        Some(_) if a.instancia.is_some() => Veredicto::Rechazar,
        Some(_) => Veredicto::ModAntiguo,
    };
    match (&v, a.sid) {
        (Veredicto::Rechazar, _) => vetar(p, a.instancia),
        (Veredicto::Aceptar, Some(sid)) => {
            p.dueno = Some(Dueno {
                pty: a.pty.to_string(),
                sid: sid.to_string(),
                instancia: a.instancia.map(str::to_string),
                anuncio: a.seq,
            });
        }
        _ => {}
    }
    v
}

/// Apunta el veto de una instancia; por encima de `MAX_VETADAS` olvida la
/// más antigua.
fn vetar(p: &mut EstadoPuente, instancia: Option<&str>) {
    let Some(i) = instancia else { return };
    if p.vetadas.iter().any(|v| v == i) {
        return;
    }
    p.vetadas.push_back(i.to_string());
    while p.vetadas.len() > MAX_VETADAS {
        p.vetadas.pop_front();
    }
}

/// `hello` aplicado (generación nueva) o respondido con la vigente sin
/// aplicarlo (`Repetido`, `Sustituido`).
enum Registro {
    Nuevo(u32),
    Repetido(u32),
    Sustituido(u32),
}

impl SesionesPuente {
    fn registrar_hello(
        &self,
        id: &str,
        body: &Value,
        protocolo: u8,
    ) -> Result<Registro, RouteError> {
        let claude_sid = s(body, "claudeSessionId").filter(|x| !x.is_empty());
        if claude_sid.as_deref().is_some_and(|x| !sid_valido(x)) {
            tracing::warn!(
                sesion = id,
                "hello con un claudeSessionId que no es un UUID"
            );
            return Err(RouteError::bad_request("claudeSessionId no es un UUID"));
        }
        let pty = registro::pty_id(id).unwrap_or_default();
        let instancia = s(body, "instanceId").filter(|x| !x.is_empty());
        let anuncio = Anuncio {
            pty: &pty,
            sid: claude_sid.as_deref(),
            instancia: instancia.as_deref(),
            seq: body.get("helloSeq").and_then(Value::as_u64),
        };
        let (v, vigente, vetada_antes) = con_puente(id, |p| {
            let previa = anuncio
                .instancia
                .is_some_and(|i| p.vetadas.iter().any(|x| x == i));
            (veredicto(p, &anuncio), p.generacion, previa)
        });
        if let Some(r) = self.sin_aplicar(id, v, vigente, vetada_antes)? {
            return Ok(r);
        }
        #[cfg(test)]
        pausa_hello::tras_veredicto(
            id,
            body.get("source")
                .and_then(Value::as_str)
                .unwrap_or("start"),
        );
        let model = s(body, "model").filter(|x| !x.is_empty());
        let transcript = s(body, "transcriptPath").and_then(|p| valid_transcript(&p));
        registro::update(id, |se| {
            se.info.bridge_connected = true;
            se.info.bridge_protocol = protocolo;
            if model.is_some() {
                se.info.model = model;
            }
            let cambia = claude_sid.is_some() && se.info.claude_session_id != claude_sid;
            if cambia {
                se.info.claude_session_id = claude_sid.clone();
                se.live_agents.clear();
            }
            let path = transcript.or_else(|| {
                claude_sid
                    .as_ref()
                    .map(|sid| se.slug_dir.join(format!("{sid}.jsonl")))
            });
            if let Some(p) = path {
                // Un transcript que aún no existe queda provisional: el
                // seguidor sigue con el actual hasta que el fichero aparezca
                // (`seguidor::locate`), así que un `hello` ajeno no lo apunta
                // a la nada. El mismo transcript conserva su confirmación.
                let mismo = se.transcript.as_ref() == Some(&p) && se.sid_confirmed;
                se.sid_confirmed = mismo || p.is_file();
                se.transcript = Some(p);
            }
            (true, ())
        })
        .map_err(RouteError::not_found)?;
        let gen = con_puente(id, |p| {
            p.protocolo = protocolo;
            p.generacion += 1;
            p.ultimo_seq = 0;
            p.generacion
        });
        if protocolo >= 2 {
            buzon::global().habilitar(id, gen);
        }
        Ok(Registro::Nuevo(gen))
    }

    /// Respuesta de un `hello` que no se aplica: `None` si se acepta. El
    /// primer rechazo de una instancia avisa en el chat (`ev::NOTICE`): su mod
    /// queda inerte y el usuario veía el chat parado sin saber por qué.
    fn sin_aplicar(
        &self,
        id: &str,
        v: Veredicto,
        vigente: u32,
        vetada_antes: bool,
    ) -> Result<Option<Registro>, RouteError> {
        match v {
            Veredicto::Aceptar => Ok(None),
            Veredicto::Repetido => Ok(Some(Registro::Repetido(vigente))),
            Veredicto::Sustituido => Ok(Some(Registro::Sustituido(vigente))),
            Veredicto::Rechazar => {
                tracing::warn!(
                    sesion = id,
                    "hello de otro claude en el mismo PTY: rechazado"
                );
                if !vetada_antes {
                    self.sink.emit(
                        ev::NOTICE,
                        json!({ "id": id, "level": "warn", "text": AVISO_VETO }),
                    );
                }
                Err(RouteError::conflict(
                    "otro claude ya es dueño de esta sesión: hello rechazado",
                ))
            }
            Veredicto::ModAntiguo => {
                tracing::warn!(sesion = id, "cambio de sid sin instanceId: rechazado");
                Err(RouteError::conflict(
                    "hello sin instanceId que cambia de conversación: actualiza ultron-puente",
                ))
            }
        }
    }
}

/// Nota del chat cuando se rechaza el puente de un `claude` arrancado dentro
/// de la sesión.
pub(super) const AVISO_VETO: &str = "Otro claude se ha arrancado dentro de esta sesión y su \
     puente se ha rechazado: sus turnos no llegan al chat. Ciérralo o abre el menú de la \
     terminal.";

impl PuenteHandler for SesionesPuente {
    fn hello(&self, body: Value) -> Result<Value, RouteError> {
        let id = sesion_id(&body)?;
        require_session(&id)?;
        let protocolo = body
            .get("protocol")
            .and_then(Value::as_u64)
            .map_or(1, |p| p.clamp(1, 2) as u8);
        // Veredicto, registro, generación, buzón y señal, enteros y en orden:
        // un duplicado espera al resultado ya aplicado del original.
        let cerrojo = cerrojo_hello(&id);
        let _en_orden = cerrojo
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let gen = match self.registrar_hello(&id, &body, protocolo)? {
            Registro::Nuevo(gen) => gen,
            Registro::Repetido(gen) => return Ok(respuesta_hello(&id, gen)),
            Registro::Sustituido(gen) => {
                return Ok(json!({ "ok": true, "superseded": true, "generation": gen }));
            }
        };
        senales::emitir(
            &id,
            Senal::PuenteHello {
                protocolo,
                claude_session_id: s(&body, "claudeSessionId").filter(|x| !x.is_empty()),
                generacion: gen,
                transcript_path: s(&body, "transcriptPath"),
                origen: s(&body, "source").unwrap_or_else(|| "start".into()),
            },
        );
        Ok(respuesta_hello(&id, gen))
    }

    fn events(&self, body: Value) -> Result<Value, RouteError> {
        let id = sesion_id(&body)?;
        require_session(&id)?;
        let events = body
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(|| RouteError::bad_request("falta events[]"))?;
        let gen = body.get("generation").and_then(Value::as_u64);
        match admitir(&id, gen, events) {
            Ok(nuevos) => {
                for e in nuevos {
                    self.apply(&id, e);
                }
                Ok(ok())
            }
            Err(Rechazo::Viejo(vigente)) => {
                // El mod reenvía el lote renumerado en la generación vigente:
                // un `hello` a mitad de turno (`/compact`) no pierde eventos.
                tracing::debug!(sesion = %id, vigente, "lote de una generación anterior: stale");
                Ok(json!({ "stale": true, "generation": vigente }))
            }
            Err(Rechazo::SinHello) => {
                // `stale` haría que el mod lo renumerara y lo colara en los
                // turnos del dueño; 409 lo cierra para siempre.
                tracing::warn!(sesion = %id, "lote sin hello aceptado: rechazado");
                Err(RouteError::conflict(
                    "lote de un claude sin hello aceptado en esta sesión",
                ))
            }
        }
    }

    fn ask(&self, body: Value) -> Result<Value, RouteError> {
        let id = sesion_id(&body)?;
        require_session(&id)?;
        let ask = body
            .get("ask")
            .ok_or_else(|| RouteError::bad_request("falta ask"))?;
        if body.get("async").and_then(Value::as_bool) == Some(true) {
            let p = self
                .broker
                .abrir(&*self.sink, &id, ask, s(&body, "turnId"))
                .map_err(error_de_ask)?;
            return Ok(json!({ "askId": p.ask_id }));
        }
        let answer = self
            .broker
            .ask(&*self.sink, &id, ask)
            .map_err(error_de_ask)?;
        Ok(json!({ "answer": answer }))
    }

    fn ask_wait(&self, body: Value) -> Result<Value, RouteError> {
        let id = sesion_id(&body)?;
        if es_viejo(&id, &body) {
            return Ok(json!({ "stale": true }));
        }
        let ids: Vec<String> = body
            .get("askIds")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let r = self.broker.esperar_de(&id, &ids, self.espera);
        let results: Vec<Value> = r.iter().map(resultado_json).collect();
        Ok(json!({ "results": results }))
    }

    fn ask_cancel(&self, body: Value) -> Result<Value, RouteError> {
        let id = sesion_id(&body)?;
        let ask_id = s(&body, "askId").ok_or_else(|| RouteError::bad_request("falta askId"))?;
        match self.broker.sesion_de(&ask_id) {
            Some(dueña) if dueña != id => {
                return Err(RouteError::not_found("el ask no es de esta sesión"));
            }
            _ => {}
        }
        self.broker
            .cancelar(&*self.sink, &ask_id, AskCancelReason::ModAborted);
        Ok(ok())
    }

    fn inbox(&self, body: Value) -> Result<Value, RouteError> {
        let id = sesion_id(&body)?;
        let gen = body
            .get("generation")
            .and_then(Value::as_u64)
            .and_then(|g| u32::try_from(g).ok())
            .unwrap_or_default();
        match buzon::global().esperar_pendientes(&id, gen, self.espera) {
            None => Ok(json!({ "stale": true })),
            Some(ops) => Ok(json!({ "ops": ops })),
        }
    }

    fn result(&self, body: Value) -> Result<Value, RouteError> {
        let id = sesion_id(&body)?;
        let op_id = s(&body, "opId").ok_or_else(|| RouteError::bad_request("falta opId"))?;
        let value = body.get("value").cloned().filter(|v| !v.is_null());
        let r = OpResult {
            ok: body.get("ok").and_then(Value::as_bool).unwrap_or(false),
            text: value.as_ref().and_then(texto_de_valor),
            value,
            error: s(&body, "error"),
            ..OpResult::default()
        };
        buzon::resolver(&id, &op_id, r);
        Ok(ok())
    }

    fn fill(&self, body: Value) -> Result<Value, RouteError> {
        let id = sesion_id(&body)?;
        require_session(&id)?;
        self.composer_fill(&id, &body);
        Ok(ok())
    }
}

/// Error de `Broker::abrir`: 429 si la sesión ya tiene el tope de asks
/// pendientes; 400 si el ask está mal formado.
fn error_de_ask(e: String) -> RouteError {
    if e == ASKS_LLENOS {
        RouteError::too_many(e)
    } else {
        RouteError::bad_request(e)
    }
}

/// Respuesta de un `hello` aceptado (o de su reintento) en la generación `gen`.
fn respuesta_hello(id: &str, gen: u32) -> Value {
    let launch = registro::read(id, |se| se.info.launch_permission_mode).ok();
    json!({
        "ok": true,
        "protocol": 2,
        "generation": gen,
        "launchPermissionMode": launch,
    })
}

/// Texto de un resultado: cadena o `{ text }`.
fn texto_de_valor(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::to_string)
        .or_else(|| v.get("text").and_then(Value::as_str).map(str::to_string))
}

impl SesionesPuente {
    fn composer_fill(&self, id: &str, e: &Value) {
        self.sink.emit(
            ev::COMPOSER_FILL,
            json!({
                "id": id,
                "text": e.get("text").and_then(Value::as_str).unwrap_or_default(),
                "mode": e.get("mode").and_then(Value::as_str).unwrap_or("replace"),
                "from": e.get("from").and_then(Value::as_str).unwrap_or_default(),
            }),
        );
    }
}

/// Gancho de los tests para detener un `hello` justo tras su veredicto y
/// solapar otro con él.
#[cfg(test)]
pub(super) mod pausa_hello {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};

    type Gancho = Arc<dyn Fn(&str) + Send + Sync>;

    fn ganchos() -> &'static Mutex<HashMap<String, Gancho>> {
        static G: OnceLock<Mutex<HashMap<String, Gancho>>> = OnceLock::new();
        G.get_or_init(Default::default)
    }

    pub fn poner(id: &str, g: Gancho) {
        if let Ok(mut m) = ganchos().lock() {
            m.insert(id.to_string(), g);
        }
    }

    pub fn quitar(id: &str) {
        if let Ok(mut m) = ganchos().lock() {
            m.remove(id);
        }
    }

    pub(super) fn tras_veredicto(id: &str, source: &str) {
        let g = ganchos().lock().ok().and_then(|m| m.get(id).cloned());
        if let Some(g) = g {
            g(source);
        }
    }
}
