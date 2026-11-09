// sesiones/puente.rs — Servidor HTTP/1.1 loopback del mod `ultron-puente`
// (contrato de estabilidad, §6.1-§6.2).
//
// Escucha en 127.0.0.1 con puerto dinámico. Cada sesión tiene su token
// (`token_sesion`): sin `Authorization: Bearer <token>` válido, 401; con el
// token de una sesión y el `sesionId` de otra, 403. Cupos: 32 peticiones de
// control concurrentes, 64 de `/v1/events` y 128 sondeos largos aparte, y
// 4 sondeos largos (`/v1/ask/wait`, `/v1/inbox`) por sesión; el
// exceso recibe 503. El token, el método y el cupo se comprueban en el hilo
// aceptador (solo cabeceras): un 401, 405 o 503 no crea ningún hilo, pero
// tampoco se responde ni se suelta allí, porque las dos cosas pueden
// bloquear (`Rechazo`); lo atiende un grupo fijo de respondedores y, con su
// cola llena, un hilo desechable con tope (`puente_desecho.rs`). Cada
// petición admitida se atiende en su hilo bajo `catch_unwind`: un pánico es
// un 500, nunca la caída del aceptador. La lógica de cada ruta vive tras
// `PuenteHandler` (`puente_eventos.rs`). Cada conexión tiene plazo de
// lectura y de escritura (`Plazos`) y cada ruta su tope de cuerpo
// (`max_cuerpo`). Lo que `tiny_http` 0.12 no permite es limitar las
// conexiones simultáneas: acepta y crea el hilo de cada una por su cuenta;
// los plazos acotan cuánto vive cada una, no cuántas hay.

use std::collections::HashMap;
use std::io::Read;
use std::net::TcpListener;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

use super::puente_eventos::SONDEO_LARGO;

/// Topes del cuerpo por ruta. Antes había uno solo de 4 MiB: los 128 sondeos
/// largos, que mandan unos pocos campos, podían retener 512 MiB entre todos
/// (auditoría del 2026-10-15). Lotes: `events` (hasta 2000 eventos por lote
/// del mod) y `result` (un `prompt.read` devuelve el composer entero, que el
/// motor admite hasta 4 MiB).
const MAX_CUERPO_LOTE: u64 = 4 * 1024 * 1024;
/// `ask` (lleva el texto del plan de `ExitPlanMode`) y `fill`.
const MAX_CUERPO_ASK: u64 = 1024 * 1024;
/// `hello`, `ask/wait`, `ask/cancel`, `inbox` y rutas desconocidas.
pub(super) const MAX_CUERPO_CORTO: u64 = 64 * 1024;
const CUPO_CONTROL: usize = 32;
const CUPO_EVENTOS: usize = 64;
/// Sondeos largos de todas las sesiones, aparte del control: cada sesión
/// mantiene siempre uno abierto y, compartiendo cupo, con unas 30 sesiones
/// dejaban sin plaza a `hello`, `ask` y `result` (auditoría del 2026-10-15).
const CUPO_SONDEOS: usize = 128;
const CUPO_SONDEOS_SESION: usize = 4;
/// Hilos que responden los rechazos del aceptador y hueco de su cola.
const RESPONDEDORES: usize = 4;
const COLA_RECHAZOS: usize = 256;

#[path = "puente_desecho.rs"]
pub(super) mod desecho;

#[cfg(test)]
#[path = "tests_puente_limites.rs"]
mod tests_limites;

/// Plazo de cada lectura de una conexión: cabeceras, cuerpo y espera entre
/// peticiones de una conexión persistente. Sin él, un cliente que abría la
/// conexión y no mandaba nada retenía para siempre un hilo de `tiny_http` y,
/// con el token válido y el cuerpo a medias, una plaza de su cupo (auditoría
/// del 2026-10-15). Mientras dura un sondeo largo la conexión está callada,
/// así que el plazo tiene que superarlo con holgura.
const PLAZO_LECTURA: Duration = Duration::from_secs(60);
/// Plazo de cada escritura: un cliente que no lee su respuesta no retiene el
/// hilo que la escribe.
const PLAZO_ESCRITURA: Duration = Duration::from_secs(30);
const _: () = assert!(PLAZO_LECTURA.as_secs() >= 2 * SONDEO_LARGO.as_secs());

/// Plazos de lectura y escritura de las conexiones de un servidor.
#[derive(Clone, Copy, Debug)]
pub(super) struct Plazos {
    pub lectura: Duration,
    pub escritura: Duration,
}

impl Plazos {
    const PRODUCCION: Self = Self {
        lectura: PLAZO_LECTURA,
        escritura: PLAZO_ESCRITURA,
    };
}

/// Errores de una ruta: código HTTP y mensaje.
pub struct RouteError {
    pub status: u16,
    pub message: String,
}

impl RouteError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self {
            status: 400,
            message: msg.into(),
        }
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self {
            status: 404,
            message: msg.into(),
        }
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self {
            status: 409,
            message: msg.into(),
        }
    }
    pub fn too_many(msg: impl Into<String>) -> Self {
        Self {
            status: 429,
            message: msg.into(),
        }
    }
}

pub trait PuenteHandler: Send + Sync + 'static {
    fn hello(&self, body: Value) -> Result<Value, RouteError>;
    fn events(&self, body: Value) -> Result<Value, RouteError>;
    fn ask(&self, body: Value) -> Result<Value, RouteError>;
    fn ask_wait(&self, body: Value) -> Result<Value, RouteError>;
    fn ask_cancel(&self, body: Value) -> Result<Value, RouteError>;
    fn inbox(&self, body: Value) -> Result<Value, RouteError>;
    fn result(&self, body: Value) -> Result<Value, RouteError>;
    fn fill(&self, body: Value) -> Result<Value, RouteError>;
}

/// Dirección del servidor en marcha. No hay token del proceso: cada sesión
/// usa el suyo (`token_sesion`).
#[derive(Clone, Debug)]
pub struct PuenteInfo {
    pub url: String,
}

static GLOBAL: OnceLock<PuenteInfo> = OnceLock::new();

/// Datos del puente de la app, si arrancó.
pub fn info() -> Option<PuenteInfo> {
    GLOBAL.get().cloned()
}

/// Arranca el puente de la app (una vez por proceso).
pub fn start_global(handler: Arc<dyn PuenteHandler>) -> Result<PuenteInfo, String> {
    if let Some(i) = GLOBAL.get() {
        return Ok(i.clone());
    }
    let i = start(handler)?;
    Ok(GLOBAL.get_or_init(|| i).clone())
}

fn tokens() -> &'static Mutex<HashMap<String, String>> {
    static T: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Token con el que la sesión `id` se autentica ante el puente (lo crea la
/// primera vez; `gestor` lo rota en cada lanzamiento). `None` solo si el registro de
/// tokens está envenenado (`seguridad-robustez:F13`).
pub fn token_sesion(id: &str) -> Option<String> {
    let mut t = match tokens().lock() {
        Ok(t) => t,
        Err(_) => {
            tracing::error!(sesion = id, "registro de tokens del puente envenenado");
            return None;
        }
    };
    if let Some((tok, _)) = t.iter().find(|(_, s)| s.as_str() == id) {
        return Some(tok.clone());
    }
    let tok = new_token();
    t.insert(tok.clone(), id.to_string());
    Some(tok)
}

/// Revoca el token de una sesión cerrada.
pub fn revocar_token(id: &str) {
    if let Ok(mut t) = tokens().lock() {
        t.retain(|_, s| s != id);
    }
}

/// Sesión dueña de un token en tiempo constante por candidato.
fn sesion_del_token(token: &str) -> Option<String> {
    let t = tokens().lock().ok()?;
    t.iter()
        .find(|(tok, _)| ct_eq(tok.as_bytes(), token.as_bytes()))
        .map(|(_, s)| s.clone())
}

/// Token aleatorio de 256 bits en hexadecimal.
pub fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Cupos de concurrencia de un servidor.
#[derive(Default)]
struct Cupos {
    control: AtomicUsize,
    eventos: AtomicUsize,
    largos: AtomicUsize,
    sondeos: Mutex<HashMap<String, usize>>,
}

/// Cupo al que va una petición.
#[derive(Clone, Copy)]
enum Cola {
    Control,
    Eventos,
    Sondeos,
}

impl Cupos {
    fn de(&self, cola: Cola) -> (&AtomicUsize, usize) {
        match cola {
            Cola::Control => (&self.control, CUPO_CONTROL),
            Cola::Eventos => (&self.eventos, CUPO_EVENTOS),
            Cola::Sondeos => (&self.largos, CUPO_SONDEOS),
        }
    }
}

/// Plaza ocupada en un cupo; se libera al soltarla. Es dueña de los cupos
/// porque se ocupa en el aceptador y se suelta en el hilo de la petición.
struct Plaza {
    cupos: Arc<Cupos>,
    cola: Cola,
}

impl Drop for Plaza {
    fn drop(&mut self) {
        self.cupos.de(self.cola).0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn ocupar(cupos: &Arc<Cupos>, cola: Cola) -> Option<Plaza> {
    let (c, max) = cupos.de(cola);
    let previo = c.fetch_add(1, Ordering::SeqCst);
    if previo >= max {
        c.fetch_sub(1, Ordering::SeqCst);
        return None;
    }
    Some(Plaza {
        cupos: cupos.clone(),
        cola,
    })
}

/// Plaza de sondeo largo de una sesión.
struct PlazaSondeo<'a> {
    cupos: &'a Cupos,
    sesion: String,
}

impl Drop for PlazaSondeo<'_> {
    fn drop(&mut self) {
        if let Ok(mut m) = self.cupos.sondeos.lock() {
            if let Some(n) = m.get_mut(&self.sesion) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    m.remove(&self.sesion);
                }
            }
        }
    }
}

fn ocupar_sondeo<'a>(cupos: &'a Cupos, sesion: &str) -> Option<PlazaSondeo<'a>> {
    let mut m = cupos.sondeos.lock().ok()?;
    let n = m.entry(sesion.to_string()).or_default();
    if *n >= CUPO_SONDEOS_SESION {
        return None;
    }
    *n += 1;
    Some(PlazaSondeo {
        cupos,
        sesion: sesion.to_string(),
    })
}

/// Arranca un servidor en 127.0.0.1 con puerto dinámico.
pub fn start(handler: Arc<dyn PuenteHandler>) -> Result<PuenteInfo, String> {
    start_con_plazos(handler, Plazos::PRODUCCION)
}

/// Socket de escucha en 127.0.0.1 con puerto dinámico y los plazos puestos.
/// `tiny_http` acepta por su cuenta y no deja configurar las conexiones,
/// pero las aceptadas heredan `SO_RCVTIMEO` y `SO_SNDTIMEO` del socket de
/// escucha (lo comprueban los tests de `tests_puente_limites.rs`).
fn escuchar(plazos: Plazos) -> Result<TcpListener, String> {
    let l = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("no se pudo abrir el puerto del puente: {e}"))?;
    let s = socket2::SockRef::from(&l);
    s.set_read_timeout(Some(plazos.lectura))
        .and_then(|()| s.set_write_timeout(Some(plazos.escritura)))
        .map_err(|e| format!("no se pudieron fijar los plazos del puente: {e}"))?;
    Ok(l)
}

/// `start` con otros plazos de conexión (los tests los acortan).
pub(super) fn start_con_plazos(
    handler: Arc<dyn PuenteHandler>,
    plazos: Plazos,
) -> Result<PuenteInfo, String> {
    let server = Server::from_listener(escuchar(plazos)?, None)
        .map_err(|e| format!("no se pudo arrancar el puente: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "el puente no obtuvo un puerto TCP".to_string())?;
    let info = PuenteInfo {
        url: format!("http://127.0.0.1:{port}"),
    };
    let aceptador = Aceptador {
        handler,
        cupos: Arc::new(Cupos::default()),
        rechazos: arrancar_respondedores()?,
        desechos: Arc::default(),
    };
    std::thread::Builder::new()
        .name("sesiones-puente".into())
        .spawn(move || aceptar(server, &aceptador))
        .map_err(|e| format!("no se pudo arrancar el hilo del puente: {e}"))?;
    Ok(info)
}

/// Petición que el aceptador rechaza. En HTTP/1.1 las respuestas de una
/// conexión salen en orden y `tiny_http` entrega las encadenadas antes de
/// responder la anterior: escribir el 401 de una que va detrás de un sondeo
/// espera a que este termine. Soltarla sin responder escribe un 500 y lee el
/// resto de su cuerpo declarado, que puede no llegar nunca. Ninguna de las
/// dos cosas se hace en el aceptador.
struct Rechazo {
    req: Request,
    status: u16,
    msg: &'static str,
}

/// Estado del hilo aceptador.
struct Aceptador {
    handler: Arc<dyn PuenteHandler>,
    cupos: Arc<Cupos>,
    rechazos: SyncSender<Rechazo>,
    desechos: Arc<desecho::Desechos>,
}

impl Aceptador {
    /// Encola el rechazo sin esperar. Con la cola llena (todos los
    /// respondedores bloqueados por sus conexiones) lo responde un hilo
    /// desechable con tope; por encima, la petición se abandona sin soltarla
    /// y se cuenta (`desecho`). El puente de las demás sesiones sigue en
    /// marcha en todos los casos.
    fn rechazar(&self, req: Request, status: u16, msg: &'static str) {
        let r = Rechazo { req, status, msg };
        match self.rechazos.try_send(r) {
            Ok(()) => {}
            Err(TrySendError::Full(r) | TrySendError::Disconnected(r)) => {
                tracing::warn!(
                    status,
                    "puente: cola de rechazos llena, va a un hilo desechable"
                );
                desecho::desechar(&self.desechos, r);
            }
        }
    }
}

fn arrancar_respondedores() -> Result<SyncSender<Rechazo>, String> {
    let (tx, rx) = mpsc::sync_channel(COLA_RECHAZOS);
    let rx = Arc::new(Mutex::new(rx));
    for n in 0..RESPONDEDORES {
        let rx = rx.clone();
        std::thread::Builder::new()
            .name(format!("sesiones-puente-rechazo-{n}"))
            .spawn(move || responder_rechazos(&rx))
            .map_err(|e| format!("no se pudo arrancar un respondedor del puente: {e}"))?;
    }
    Ok(tx)
}

/// Bucle de un respondedor; termina cuando el aceptador suelta la cola.
fn responder_rechazos(rx: &Mutex<Receiver<Rechazo>>) {
    loop {
        let siguiente = rx.lock().unwrap_or_else(PoisonError::into_inner).recv();
        let Ok(r) = siguiente else { return };
        let respuesta = catch_unwind(AssertUnwindSafe(|| error(r.req, r.status, r.msg)));
        if respuesta.is_err() {
            tracing::error!("puente: pánico respondiendo un rechazo");
        }
    }
}

fn aceptar(server: Server, a: &Aceptador) {
    for req in server.incoming_requests() {
        atender(req, a);
    }
    tracing::error!("puente: el aceptador terminó");
}

/// Admisión en el hilo aceptador: sin token válido, con otro método o con el
/// cupo lleno, la petición va a los respondedores; antes cada petición creaba
/// su hilo antes de autenticarse, sin tope.
fn atender(req: Request, a: &Aceptador) {
    let Some(sesion) = autenticar(&req) else {
        return a.rechazar(req, 401, "no autorizado");
    };
    if *req.method() != Method::Post {
        return a.rechazar(req, 405, "solo se admite POST");
    }
    let route = req.url().split('?').next().unwrap_or_default().to_string();
    let cola = match route.as_str() {
        "/v1/events" => Cola::Eventos,
        "/v1/ask/wait" | "/v1/inbox" => Cola::Sondeos,
        _ => Cola::Control,
    };
    let Some(plaza) = ocupar(&a.cupos, cola) else {
        return a.rechazar(req, 503, "puente saturado: reintenta");
    };
    // Si el hilo no arranca, `spawn` suelta el cierre en este hilo: la
    // petición va en una celda para recuperarla y rechazarla sin soltarla aquí.
    let celda = Arc::new(Mutex::new(Some(req)));
    let (h, c, dentro) = (a.handler.clone(), a.cupos.clone(), celda.clone());
    let spawned = std::thread::Builder::new()
        .name("sesiones-puente-req".into())
        .spawn(move || {
            let _plaza = plaza;
            let Some(req) = tomar(&dentro) else { return };
            let r = catch_unwind(AssertUnwindSafe(|| handle(req, &sesion, &route, &*h, &c)));
            if r.is_err() {
                tracing::error!("puente: pánico atendiendo una petición");
            }
        });
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "puente: no se pudo atender la petición");
        if let Some(req) = tomar(&celda) {
            a.rechazar(req, 503, "puente saturado: reintenta");
        }
    }
}

fn tomar(celda: &Mutex<Option<Request>>) -> Option<Request> {
    celda.lock().unwrap_or_else(PoisonError::into_inner).take()
}

/// Comparación en tiempo constante (longitud aparte).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Sesión autenticada por la cabecera `Authorization: Bearer <token>`.
fn autenticar(req: &Request) -> Option<String> {
    let h = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))?;
    let token = h.value.as_str().strip_prefix("Bearer ")?;
    sesion_del_token(token)
}

fn respond(req: Request, status: u16, body: &Value) {
    let mut resp = Response::from_string(body.to_string()).with_status_code(status);
    if let Ok(h) = Header::from_bytes("Content-Type", "application/json; charset=utf-8") {
        resp = resp.with_header(h);
    }
    if let Err(e) = req.respond(resp) {
        tracing::debug!(error = %e, "puente: el cliente cerró antes de la respuesta");
    }
}

fn error(req: Request, status: u16, msg: &str) {
    respond(req, status, &json!({ "ok": false, "error": msg }));
}

/// Tope del cuerpo de `route`.
fn max_cuerpo(route: &str) -> u64 {
    match route {
        "/v1/events" | "/v1/result" => MAX_CUERPO_LOTE,
        "/v1/ask" | "/v1/fill" => MAX_CUERPO_ASK,
        _ => MAX_CUERPO_CORTO,
    }
}

fn leer_cuerpo(req: &mut Request, max: u64) -> Result<Value, (u16, String)> {
    let mut raw = Vec::new();
    if let Err(e) = req.as_reader().take(max + 1).read_to_end(&mut raw) {
        return Err((400, format!("cuerpo ilegible: {e}")));
    }
    if raw.len() as u64 > max {
        return Err((413, format!("cuerpo demasiado grande (máximo {max} bytes)")));
    }
    serde_json::from_slice(&raw).map_err(|e| (400, format!("JSON no válido: {e}")))
}

/// Petición ya admitida (`atender`): cuerpo, sesión del cuerpo, sondeos y
/// despacho.
fn handle(mut req: Request, sesion: &str, route: &str, h: &dyn PuenteHandler, cupos: &Cupos) {
    let body = match leer_cuerpo(&mut req, max_cuerpo(route)) {
        Ok(b) => b,
        Err((code, msg)) => return error(req, code, &msg),
    };
    let ajena = body
        .get("sesionId")
        .and_then(Value::as_str)
        .is_some_and(|s| s != sesion);
    if ajena {
        return error(req, 403, "el token no corresponde a esa sesión");
    }
    let largo = matches!(route, "/v1/ask/wait" | "/v1/inbox");
    let _sondeo = if largo {
        match ocupar_sondeo(cupos, sesion) {
            Some(p) => Some(p),
            None => return error(req, 503, "demasiados sondeos de esta sesión"),
        }
    } else {
        None
    };
    match despachar(h, route, body) {
        Ok(v) => respond(req, 200, &v),
        Err(e) => error(req, e.status, &e.message),
    }
}

fn despachar(h: &dyn PuenteHandler, route: &str, body: Value) -> Result<Value, RouteError> {
    match route {
        "/v1/hello" => h.hello(body),
        "/v1/events" => h.events(body),
        "/v1/ask" => h.ask(body),
        "/v1/ask/wait" => h.ask_wait(body),
        "/v1/ask/cancel" => h.ask_cancel(body),
        "/v1/inbox" => h.inbox(body),
        "/v1/result" => h.result(body),
        "/v1/fill" => h.fill(body),
        _ => Err(RouteError::not_found(format!("ruta desconocida: {route}"))),
    }
}

/// `sesionId` obligatorio del cuerpo.
pub fn sesion_id(body: &Value) -> Result<String, RouteError> {
    body.get("sesionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| RouteError::bad_request("falta sesionId"))
}
