// mar.ia — servidor de la webapp movil.
//
// El usuario pidio poder hablar con mar.ia desde el movil y recibir avisos
// ("webapp para las llamadas al movil y notificaciones"). Esto es la mitad
// servidor: un HTTP minimo que sirve la webapp (carpeta `webapp/`, embebida en
// el binario) y una API con lo justo — estado, conversaciones, preguntar,
// hablar y avisos.
//
// LIMITE DECLARADO (mandamiento 13): esto NO es un servicio publico.
//   * Va apagado por defecto; se enciende desde Ajustes o `maria_web_set`.
//   * Escucha en la IP que se le diga (por defecto 127.0.0.1) y toda la API
//     exige un token que se genera solo en el primer arranque.
//   * NO lleva TLS. Para usarlo fuera del PC la via prevista es Tailscale
//     (red privada cifrada); exponerlo a internet a pelo seria regalar el
//     control del ordenador.
//   * Los avisos push de verdad (con la pantalla apagada) NO salen de aqui:
//     un service worker necesita HTTPS. Para eso esta la integracion con
//     ntfy (`notificar`), que si llega al movil sin montar certificados.
//
// Las llamadas de voz desde el movil se resuelven con el mismo cerebro que la
// voz local: el movil graba, manda el texto (o el audio transcrito) y mar.ia
// contesta. Ver `/api/preguntar` y `/api/decir`.

use std::io::Read;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tiny_http::{Header, Request, Response, Server};

/// Puerto por defecto. Alto y poco usado, para no chocar con nada.
const PUERTO_DEFECTO: u16 = 8790;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebConfig {
    /// Apagado por defecto: encender un servidor sin pedirlo seria abrir una
    /// puerta que el usuario no sabe que tiene.
    pub enabled: bool,
    pub port: u16,
    /// Direccion de escucha. "127.0.0.1" = solo este PC. Para el movil por
    /// Tailscale se pone "0.0.0.0" y se entra por la IP de la tailnet.
    pub bind: String,
    /// Tema de ntfy para los avisos al movil. Vacio = sin avisos.
    #[serde(default)]
    pub ntfy_topic: String,
    #[serde(default = "ntfy_por_defecto")]
    pub ntfy_server: String,
}

fn ntfy_por_defecto() -> String {
    "https://ntfy.sh".into()
}

impl Default for WebConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: PUERTO_DEFECTO,
            bind: "127.0.0.1".into(),
            ntfy_topic: String::new(),
            ntfy_server: ntfy_por_defecto(),
        }
    }
}

/// Estado del servidor para la interfaz.
#[derive(Debug, Clone, Serialize)]
pub struct WebStatus {
    pub running: bool,
    pub config: WebConfig,
    pub token: String,
    /// URLs por las que se puede entrar, ya con el token puesto.
    pub urls: Vec<String>,
}

/// Servidor vivo. `Server` no se puede clonar, asi que se guarda para poder
/// apagarlo (`unblock` corta el `recv` del hilo).
static SERVIDOR: Lazy<Mutex<Option<std::sync::Arc<Server>>>> = Lazy::new(|| Mutex::new(None));

fn maria_dir() -> Result<std::path::PathBuf, String> {
    let dir = dirs::home_dir()
        .ok_or("no encuentro HOME")?
        .join(".ultron")
        .join("cockpit")
        .join("maria");
    std::fs::create_dir_all(&dir).map_err(|e| format!("crear carpeta: {e}"))?;
    Ok(dir)
}

fn config_path() -> Result<std::path::PathBuf, String> {
    Ok(maria_dir()?.join("web.json"))
}

pub fn load_config() -> WebConfig {
    config_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_config(c: &WebConfig) -> Result<(), String> {
    let path = config_path()?;
    let text = serde_json::to_string_pretty(c).map_err(|e| format!("serializar: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("guardar web.json: {e}"))
}

/// Token de acceso. Se genera solo la primera vez y se reutiliza: cambiarlo en
/// cada arranque obligaria a reconfigurar el movil cada dia.
pub fn token() -> String {
    let Ok(path) = maria_dir().map(|d| d.join("web-token.txt")) else {
        return String::new();
    };
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    let nuevo = uuid::Uuid::new_v4().simple().to_string();
    let _ = std::fs::write(&path, &nuevo);
    nuevo
}

/// Compara el token en tiempo constante. Con `==` a secas, el tiempo de
/// respuesta filtra cuantos caracteres se han acertado.
#[must_use]
pub fn token_valido(esperado: &str, recibido: &str) -> bool {
    if esperado.is_empty() || esperado.len() != recibido.len() {
        return false;
    }
    let mut dif = 0u8;
    for (a, b) in esperado.bytes().zip(recibido.bytes()) {
        dif |= a ^ b;
    }
    dif == 0
}

/// Saca el valor de un parametro de la query. Pura: se testea sin red.
#[must_use]
pub fn query_param(url: &str, clave: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for par in query.split('&') {
        let (k, v) = par.split_once('=')?;
        if k == clave {
            return Some(percent_decode(v));
        }
    }
    None
}

/// Decodifica %XX y '+' de una query. Pura.
#[must_use]
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Ruta sin query. Pura.
#[must_use]
pub fn ruta_de(url: &str) -> &str {
    url.split('?').next().unwrap_or("/")
}

// ---------------------------------------------------------------------------
// Ficheros de la webapp (embebidos: el .exe tiene que funcionar solo)
// ---------------------------------------------------------------------------

const INDEX_HTML: &str = include_str!("../webapp/index.html");
const APP_JS: &str = include_str!("../webapp/app.js");
const APP_CSS: &str = include_str!("../webapp/app.css");
const MANIFEST: &str = include_str!("../webapp/manifest.webmanifest");

/// Fichero estatico de una ruta, con su tipo. Pura: se testea sin servidor.
#[must_use]
pub fn estatico(ruta: &str) -> Option<(&'static str, &'static str)> {
    match ruta {
        "/" | "/index.html" => Some((INDEX_HTML, "text/html; charset=utf-8")),
        "/app.js" => Some((APP_JS, "application/javascript; charset=utf-8")),
        "/app.css" => Some((APP_CSS, "text/css; charset=utf-8")),
        "/manifest.webmanifest" => Some((MANIFEST, "application/manifest+json; charset=utf-8")),
        _ => None,
    }
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("cabecera valida")
}

fn responder_json(req: Request, codigo: u16, cuerpo: &serde_json::Value) {
    let texto = cuerpo.to_string();
    let resp = Response::from_string(texto)
        .with_status_code(codigo)
        .with_header(header("content-type", "application/json; charset=utf-8"))
        .with_header(header("cache-control", "no-store"));
    let _ = req.respond(resp);
}

fn error_json(req: Request, codigo: u16, msg: &str) {
    responder_json(req, codigo, &serde_json::json!({ "error": msg }));
}

fn leer_cuerpo(req: &mut Request) -> serde_json::Value {
    let mut texto = String::new();
    // Tope de 64 KiB: un cuerpo gigante solo puede ser un error o un abuso.
    let _ = req.as_reader().take(64 * 1024).read_to_string(&mut texto);
    serde_json::from_str(&texto).unwrap_or(serde_json::Value::Null)
}

/// Avisos recientes de `~/.ultron/alerts.jsonl`, los ultimos `max`.
fn avisos(max: usize) -> Vec<serde_json::Value> {
    let Some(path) = dirs::home_dir().map(|h| h.join(".ultron").join("alerts.jsonl")) else {
        return Vec::new();
    };
    let Ok(texto) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut v: Vec<serde_json::Value> = texto
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    if v.len() > max {
        v.drain(0..v.len() - max);
    }
    v.reverse(); // lo mas nuevo primero
    v
}

fn atender(mut req: Request) {
    let url = req.url().to_string();
    let ruta = ruta_de(&url).to_string();
    let metodo = req.method().as_str().to_string();

    // Estaticos: no llevan datos, asi que no exigen token. Si lo exigieran,
    // el navegador no podria ni cargar la pagina donde se escribe el token.
    if metodo == "GET" {
        if let Some((cuerpo, tipo)) = estatico(&ruta) {
            let resp = Response::from_string(cuerpo)
                .with_header(header("content-type", tipo))
                .with_header(header("cache-control", "no-store"));
            let _ = req.respond(resp);
            return;
        }
    }

    if !ruta.starts_with("/api/") {
        let _ = req.respond(Response::from_string("no existe").with_status_code(404));
        return;
    }

    // Token: en la query (primer enlace) o en la cabecera (lo que manda el JS).
    let esperado = token();
    let recibido = query_param(&url, "t").unwrap_or_else(|| {
        req.headers()
            .iter()
            .find(|h| h.field.equiv("x-maria-token"))
            .map(|h| h.value.as_str().to_string())
            .unwrap_or_default()
    });
    if !token_valido(&esperado, &recibido) {
        error_json(req, 401, "token invalido");
        return;
    }

    match (metodo.as_str(), ruta.as_str()) {
        ("GET", "/api/estado") => {
            let tel = crate::maria_sysinfo::telemetry();
            let cuerpo = serde_json::json!({
                "telemetria": tel,
                "proveedores": crate::maria_relay::load_state(),
                "relevo": crate::maria_relay::load_config(),
                "cuota_claude": crate::maria_quota::claude_window(),
            });
            responder_json(req, 200, &cuerpo);
        }
        ("GET", "/api/hilos") => {
            let hilos = crate::maria_threads::list();
            responder_json(req, 200, &serde_json::json!({ "hilos": hilos }));
        }
        ("GET", "/api/hilo") => {
            let id = query_param(&url, "id").unwrap_or_default();
            match crate::maria_relay::read_thread(&id) {
                Ok(turnos) => responder_json(req, 200, &serde_json::json!({ "turnos": turnos })),
                Err(e) => error_json(req, 400, &e),
            }
        }
        ("GET", "/api/avisos") => {
            responder_json(req, 200, &serde_json::json!({ "avisos": avisos(50) }));
        }
        ("POST", "/api/preguntar") => {
            let cuerpo = leer_cuerpo(&mut req);
            let prompt = cuerpo
                .get("prompt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if prompt.trim().is_empty() {
                error_json(req, 400, "falta el mensaje");
                return;
            }
            let hilo = cuerpo
                .get("thread_id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let forzado = cuerpo
                .get("provider")
                .and_then(|v| v.as_str())
                .filter(|p| !p.trim().is_empty())
                .map(|p| crate::maria_models::Eleccion {
                    model: cuerpo
                        .get("model")
                        .and_then(|v| v.as_str())
                        .filter(|m| !m.trim().is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| crate::maria_models::modelo_por_defecto(p)),
                    effort: crate::maria_models::normaliza_esfuerzo(
                        cuerpo.get("effort").and_then(|v| v.as_str()).unwrap_or(""),
                    ),
                    provider: p.to_string(),
                });
            // Sin hilo, se abre uno: el movil no deberia tener que crear nada.
            let hilo = match hilo.filter(|h| !h.trim().is_empty()) {
                Some(h) => h,
                None => match crate::maria_threads::create(Some("móvil".into())) {
                    Ok(m) => m.id,
                    Err(e) => {
                        error_json(req, 500, &e);
                        return;
                    }
                },
            };
            match crate::maria_relay::ask(&hilo, &prompt, forzado.as_ref()) {
                Ok(r) => responder_json(
                    req,
                    200,
                    &serde_json::json!({
                        "thread_id": r.thread_id,
                        "provider": r.provider,
                        "model": r.model,
                        "effort": r.effort,
                        "decided_by": r.decided_by,
                        "text": r.text,
                        "chosen_by_local": r.chosen_by_local,
                    }),
                ),
                Err(e) => error_json(req, 502, &e),
            }
        }
        ("POST", "/api/decir") => {
            // Que el PC lo diga en voz alta. Util para dejar un recado en casa.
            let cuerpo = leer_cuerpo(&mut req);
            let texto = cuerpo.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if texto.trim().is_empty() {
                error_json(req, 400, "falta el texto");
                return;
            }
            let payload = serde_json::json!({ "cmd": "say", "text": texto });
            match crate::maria_voice::send_line(&payload.to_string()) {
                Ok(()) => responder_json(req, 200, &serde_json::json!({ "ok": true })),
                Err(e) => error_json(req, 503, &e),
            }
        }
        ("POST", "/api/avisar") => {
            let cuerpo = leer_cuerpo(&mut req);
            let texto = cuerpo.get("text").and_then(|v| v.as_str()).unwrap_or("");
            notificar("mar.ia", texto);
            responder_json(req, 200, &serde_json::json!({ "ok": true }));
        }
        _ => error_json(req, 404, "no existe"),
    }
}

/// Direcciones IPv4 de este PC, para enseñar por donde entrar desde el movil.
fn direcciones_locales() -> Vec<String> {
    let mut out = vec!["127.0.0.1".to_string()];
    let mut cmd = std::process::Command::new("ipconfig");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    if let Ok(salida) = cmd.output() {
        let texto = String::from_utf8_lossy(&salida.stdout);
        for linea in texto.lines() {
            // "   Direccion IPv4. . . : 100.x.y.z" (es) / "IPv4 Address" (en)
            if !linea.to_lowercase().contains("ipv4") {
                continue;
            }
            if let Some((_, valor)) = linea.rsplit_once(':') {
                let ip = valor.trim().to_string();
                if ip.parse::<std::net::Ipv4Addr>().is_ok() && ip != "127.0.0.1" {
                    out.push(ip);
                }
            }
        }
    }
    out
}

fn urls(cfg: &WebConfig, tok: &str) -> Vec<String> {
    if cfg.bind == "127.0.0.1" {
        return vec![format!("http://127.0.0.1:{}/?t={}", cfg.port, tok)];
    }
    direcciones_locales()
        .into_iter()
        .map(|ip| format!("http://{}:{}/?t={}", ip, cfg.port, tok))
        .collect()
}

/// Arranca el servidor. Idempotente: si ya corre, no hace nada.
pub fn start(cfg: &WebConfig) -> Result<(), String> {
    let mut guard = SERVIDOR.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return Ok(());
    }
    let addr = format!("{}:{}", cfg.bind, cfg.port);
    let server = Server::http(&addr).map_err(|e| format!("no pude escuchar en {addr}: {e}"))?;
    let server = std::sync::Arc::new(server);
    *guard = Some(server.clone());
    drop(guard);

    std::thread::spawn(move || {
        tracing::info!("maria-web: escuchando");
        for req in server.incoming_requests() {
            // Una peticion puede tardar minutos (el relevo llama a una CLI),
            // asi que cada una va en su hilo: si no, el movil bloquearia hasta
            // la consulta de estado mas tonta.
            std::thread::spawn(move || atender(req));
        }
        tracing::info!("maria-web: servidor parado");
    });
    Ok(())
}

/// Para el servidor. `unblock` corta el `incoming_requests` del hilo.
pub fn stop() {
    let mut guard = SERVIDOR.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = guard.take() {
        s.unblock();
    }
}

pub fn running() -> bool {
    SERVIDOR
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
}

/// Manda un aviso al movil por ntfy.
///
/// Se elige ntfy porque funciona SIN montar HTTPS ni certificados: el movil
/// instala la app de ntfy, se suscribe a un tema y ya recibe con la pantalla
/// apagada. Web Push desde aqui exigiria servir la webapp por HTTPS, que en
/// una red privada significa pelearse con certificados.
///
/// Sin tema configurado no hace nada (y no es un error: es la opcion por
/// defecto).
pub fn notificar(titulo: &str, mensaje: &str) {
    let cfg = load_config();
    if cfg.ntfy_topic.trim().is_empty() || mensaje.trim().is_empty() {
        return;
    }
    let url = format!(
        "{}/{}",
        cfg.ntfy_server.trim_end_matches('/'),
        cfg.ntfy_topic.trim()
    );
    let cuerpo = mensaje.to_string();
    let titulo = titulo.to_string();
    // En segundo plano: un aviso no puede retrasar lo que estaba pasando.
    std::thread::spawn(move || {
        let Ok(c) = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
        else {
            return;
        };
        let _ = c
            .post(&url)
            .header("Title", titulo)
            .header("Tags", "robot")
            .body(cuerpo)
            .send();
    });
}

// ---------------------------------------------------------------------------
// Comandos Tauri
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn maria_web_status() -> Result<WebStatus, String> {
    let cfg = load_config();
    let tok = token();
    Ok(WebStatus {
        running: running(),
        urls: urls(&cfg, &tok),
        token: tok,
        config: cfg,
    })
}

/// Guarda la configuracion y aplica el cambio (arranca o para el servidor).
#[tauri::command]
pub async fn maria_web_set(config: WebConfig) -> Result<WebStatus, String> {
    save_config(&config)?;
    stop();
    if config.enabled {
        start(&config)?;
    }
    let tok = token();
    Ok(WebStatus {
        running: running(),
        urls: urls(&config, &tok),
        token: tok,
        config,
    })
}

/// Manda un aviso de prueba al movil.
#[tauri::command]
pub async fn maria_web_test_notify() -> Result<(), String> {
    let cfg = load_config();
    if cfg.ntfy_topic.trim().is_empty() {
        return Err("no hay tema de ntfy configurado".into());
    }
    notificar("mar.ia", "Aviso de prueba: la línea con el móvil funciona.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_token_se_compara_entero() {
        assert!(token_valido("abc123", "abc123"));
    }

    #[test]
    fn rechaza_tokens_que_no_son_el_exacto() {
        // Caso negativo: un token vacio o parcial abriria la API entera.
        assert!(!token_valido("abc123", "abc12"));
        assert!(!token_valido("abc123", ""));
        assert!(!token_valido("", ""));
        assert!(!token_valido("", "loquesea"));
        assert!(!token_valido("abc123", "abc124"));
    }

    #[test]
    fn saca_parametros_de_la_query() {
        assert_eq!(query_param("/api/hilo?id=hilo-1", "id").as_deref(), Some("hilo-1"));
        assert_eq!(query_param("/?t=abc&x=1", "t").as_deref(), Some("abc"));
        assert_eq!(query_param("/api/estado", "t"), None);
        assert_eq!(query_param("/api/estado?t=", "t").as_deref(), Some(""));
    }

    #[test]
    fn descodifica_la_query() {
        assert_eq!(percent_decode("hola+mundo"), "hola mundo");
        assert_eq!(percent_decode("m%C3%B3vil"), "móvil");
        // Un porcentaje suelto no puede tirar el parseo.
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn la_ruta_ignora_la_query() {
        assert_eq!(ruta_de("/api/hilo?id=x"), "/api/hilo");
        assert_eq!(ruta_de("/"), "/");
    }

    #[test]
    fn sirve_los_estaticos_que_existen() {
        for r in ["/", "/index.html", "/app.js", "/app.css", "/manifest.webmanifest"] {
            let (cuerpo, tipo) = estatico(r).unwrap_or_else(|| panic!("falta {r}"));
            assert!(!cuerpo.is_empty(), "{r} vacio");
            assert!(tipo.contains("charset"), "{r} sin charset");
        }
    }

    #[test]
    fn no_sirve_rutas_inventadas() {
        // Caso negativo: si `estatico` devolviera algo para cualquier ruta,
        // la API quedaria accesible sin token por la puerta de los estaticos.
        for r in ["/api/estado", "/../secreto", "/app.js.map", ""] {
            assert!(estatico(r).is_none(), "no deberia servir {r}");
        }
    }

    #[test]
    fn la_configuracion_por_defecto_esta_apagada_y_es_local() {
        let c = WebConfig::default();
        assert!(!c.enabled, "no puede venir encendido de fabrica");
        assert_eq!(c.bind, "127.0.0.1", "no puede escuchar fuera por defecto");
        assert!(c.ntfy_topic.is_empty());
    }
}
