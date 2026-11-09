// Mascota — descarga del calendario de la uni, caché y URL en ~/.ultron/.env.
//
// La URL (ULTRON_CALENDAR_ICS_URL) es una URL de capacidad privada: quien
// la tiene lee el calendario. Reglas:
//   * se lee SOLO del fichero .env en cada descarga (no se guarda en memoria
//     ni en caché). El arranque la borra del entorno del proceso
//     (`scrub_process_env`) y los PTY y CLIs hijos la quitan de su entorno:
//     un `env` dentro de una sesión la escribiría en el transcript;
//   * NUNCA se registra ni se devuelve: todo error pasa por `redact`, que
//     quita la URL, el host, la ruta y la consulta (reqwest::Error la lleva
//     en su texto, de ahí también `without_url`) y cualquier otra URL
//     http(s) del texto; las redirecciones solo se siguen al mismo host;
//   * la caché (.tmp/mascot-calendar.json, ignorada por git) solo guarda lo
//     derivado: entregas próximas, ETag y fechas.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
use serde::{Deserialize, Serialize};

pub const ENV_KEY: &str = "ULTRON_CALENDAR_ICS_URL";
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BODY: u64 = 5 * 1024 * 1024;
const MAX_URL: usize = 2048;
const MAX_REDIRECTS: usize = 5;
const WHAT: &str = "la URL del calendario";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedItem {
    pub uid: String,
    pub subject: String,
    pub title: String,
    pub due: DateTime<Utc>,
    pub all_day: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Cache {
    pub fetched_at_ms: Option<i64>,
    pub error_at_ms: Option<i64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub last_error: Option<String>,
    pub items: Vec<CachedItem>,
}

pub enum Download {
    NotModified,
    Body {
        text: String,
        etag: Option<String>,
        last_modified: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// URL: validación, .env y redacción
// ---------------------------------------------------------------------------

/// Normaliza y valida la URL (https:// o webcal://). Los errores no la citan.
pub fn validate_url(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    let url = match t.get(..9) {
        Some(p) if p.eq_ignore_ascii_case("webcal://") => format!("https://{}", &t[9..]),
        _ => t.to_string(),
    };
    if !url
        .get(..8)
        .is_some_and(|p| p.eq_ignore_ascii_case("https://"))
    {
        return Err("La URL del calendario tiene que empezar por https:// o webcal://.".into());
    }
    if url.len() > MAX_URL {
        return Err("La URL del calendario es demasiado larga.".into());
    }
    if url
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\'')
    {
        return Err(
            "La URL del calendario no puede llevar espacios, saltos de línea ni comillas.".into(),
        );
    }
    reqwest::Url::parse(&url).map_err(|_| "La URL del calendario no es válida.".to_string())?;
    Ok(url)
}

fn is_key_line(line: &str, key: &str) -> bool {
    let t = line.trim_start();
    let t = t.strip_prefix("export ").unwrap_or(t);
    t.strip_prefix(key)
        .is_some_and(|r| r.trim_start().starts_with('='))
}

/// Pone, sustituye o (con `value` vacío) quita `KEY=valor` conservando el
/// resto de líneas y su fin de línea.
pub fn upsert_env_line(content: &str, key: &str, value: &str) -> Result<String, String> {
    if value.contains(['\n', '\r']) {
        return Err("El valor no puede llevar saltos de línea.".into());
    }
    let eol = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let quoted = if value.contains('#') {
        format!("'{value}'")
    } else {
        value.to_string()
    };
    let new_line = format!("{key}={quoted}");
    let mut out: Vec<String> = Vec::new();
    let mut done = false;
    for line in content.lines() {
        if !is_key_line(line, key) {
            out.push(line.to_string());
            continue;
        }
        if !done && !value.is_empty() {
            out.push(new_line.clone());
        }
        done = true;
    }
    if !done && !value.is_empty() {
        out.push(new_line);
    }
    let mut s = out.join(eol);
    if !s.is_empty() {
        s.push_str(eol);
    }
    Ok(s)
}

/// Quita del mensaje la URL, su host, su ruta y su consulta.
pub fn redact(msg: &str, url: &str) -> String {
    let mut secrets = vec![url.to_string()];
    if let Ok(u) = reqwest::Url::parse(url) {
        secrets.extend(u.host_str().map(str::to_string));
        secrets.extend(u.query().map(str::to_string));
        secrets.extend(
            u.path_segments()
                .into_iter()
                .flatten()
                .filter(|s| s.len() >= 6)
                .map(str::to_string),
        );
        if u.path().len() > 1 {
            secrets.push(u.path().to_string());
        }
    }
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    let out = secrets
        .iter()
        .filter(|s| !s.is_empty())
        .fold(msg.to_string(), |m, s| {
            m.replace(s.as_str(), "[calendario]")
        });
    scrub_urls(&out)
}

/// Cambia cualquier URL http(s) del texto por «[calendario]»: una
/// redirección puede llevar el token en otra URL que `redact` no conoce.
pub fn scrub_urls(msg: &str) -> String {
    static ANY_URL: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)https?://\S+").expect("regex fija"));
    ANY_URL.replace_all(msg, "[calendario]").into_owned()
}

/// Política de redirección: solo al mismo host, por https y como mucho
/// MAX_REDIRECTS saltos. Pura, para los tests.
pub fn redirect_allowed(first: &reqwest::Url, next: &reqwest::Url, hops: usize) -> bool {
    hops <= MAX_REDIRECTS
        && next.scheme() == "https"
        && next.host_str().is_some()
        && next.host_str() == first.host_str()
}

fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let allowed = attempt
            .previous()
            .first()
            .is_some_and(|first| redirect_allowed(first, attempt.url(), attempt.previous().len()));
        // `stop` devuelve la respuesta 3xx tal cual: acaba en «respondió 30x»,
        // un error sin URL.
        if allowed {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

/// Texto del error con su cadena de causas, redactado. Solo se redacta el
/// detalle: el prefijo fijo no lleva nada de la URL.
fn describe(e: reqwest::Error, url: &str) -> String {
    let e = e.without_url();
    let mut detail = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        detail.push_str(&format!(": {s}"));
        src = s.source();
    }
    format!("{WHAT}: {}", redact(&detail, url))
}

pub fn env_path() -> Option<PathBuf> {
    crate::ultron_root().ok().map(|r| r.join(".env"))
}

/// Quita la URL del entorno del proceso. Se llama justo después de cargar los
/// .env con dotenvy y antes de lanzar hilos: así ningún hijo (PTY, `claude -p`,
/// hooks) la hereda.
pub fn scrub_process_env() {
    std::env::remove_var(ENV_KEY);
}

/// URL configurada, leída del .env en cada llamada. Sin respaldo en el
/// entorno del proceso: allí no debe estar (ver `scrub_process_env`).
pub fn read_url() -> Option<String> {
    read_url_at(&env_path()?)
}

fn read_url_at(path: &std::path::Path) -> Option<String> {
    let iter = dotenvy::from_path_iter(path).ok()?;
    let (_, v) = iter.flatten().find(|(k, _)| k == ENV_KEY)?;
    Some(v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Guarda (o con "" quita) la URL en ~/.ultron/.env, de forma atómica.
pub fn write_url(value: &str) -> Result<(), String> {
    let path = env_path().ok_or("no encuentro la carpeta de ULTRON")?;
    let current = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("leer .env: {e}")),
    };
    let next = upsert_env_line(&current, ENV_KEY, value)?;
    let tmp = path.with_extension("env.tmp");
    std::fs::write(&tmp, next).map_err(|e| format!("escribir .env: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("guardar .env: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Descarga y caché
// ---------------------------------------------------------------------------

fn header(resp: &reqwest::blocking::Response, name: reqwest::header::HeaderName) -> Option<String> {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// GET condicional (ETag / Last-Modified), 20 s y 5 MB como máximo.
pub fn download(url: &str, cache: &Cache) -> Result<Download, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .redirect(redirect_policy())
        .build()
        .map_err(|e| describe(e, url))?;
    let mut req = client.get(url);
    if let Some(v) = &cache.etag {
        req = req.header(IF_NONE_MATCH, v);
    }
    if let Some(v) = &cache.last_modified {
        req = req.header(IF_MODIFIED_SINCE, v);
    }
    let resp = req.send().map_err(|e| describe(e, url))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(Download::NotModified);
    }
    if !status.is_success() {
        return Err(format!("{WHAT} respondió {}", status.as_u16()));
    }
    let (etag, last_modified) = (header(&resp, ETAG), header(&resp, LAST_MODIFIED));
    let mut buf = Vec::new();
    resp.take(MAX_BODY + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("{WHAT}: {}", redact(&e.to_string(), url)))?;
    if buf.len() as u64 > MAX_BODY {
        return Err("el calendario pasa de 5 MB".into());
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    Ok(Download::Body {
        text,
        etag,
        last_modified,
    })
}

fn cache_path() -> Option<PathBuf> {
    crate::ultron_root()
        .ok()
        .map(|r| r.join(".tmp").join("mascot-calendar.json"))
}

pub fn load_cache() -> Cache {
    cache_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_cache(c: &Cache) -> Result<(), String> {
    let path = cache_path().ok_or("no encuentro la carpeta de ULTRON")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("crear .tmp: {e}"))?;
    }
    let body = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("escribir caché: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("guardar caché: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valida_la_url_y_reescribe_webcal() {
        assert_eq!(
            validate_url(" webcal://a.example/x.ics ").unwrap(),
            "https://a.example/x.ics"
        );
        assert!(validate_url("https://a.example/x.ics").is_ok());
        // Casos negativos: http, salto de línea, comillas, larga.
        assert!(validate_url("http://a.example/x.ics").is_err());
        assert!(validate_url("https://a.example/x\ny.ics").is_err());
        assert!(validate_url("https://a.example/'x").is_err());
        assert!(validate_url(&format!("https://a.example/{}", "x".repeat(2100))).is_err());
    }

    #[test]
    fn los_errores_de_validacion_no_citan_la_url() {
        let e = validate_url("http://a.example/SECRETO-123").unwrap_err();
        assert!(!e.contains("SECRETO"));
    }

    #[test]
    fn edita_el_env_conservando_el_resto() {
        let env = "A=1\r\nULTRON_CALENDAR_ICS_URL=https://viejo\r\n# nota\r\n";
        let out = upsert_env_line(env, ENV_KEY, "https://nuevo/x").unwrap();
        assert_eq!(
            out,
            "A=1\r\nULTRON_CALENDAR_ICS_URL=https://nuevo/x\r\n# nota\r\n"
        );
        let added = upsert_env_line("A=1\n", ENV_KEY, "https://n/#a").unwrap();
        assert_eq!(added, "A=1\nULTRON_CALENDAR_ICS_URL='https://n/#a'\n");
        let removed = upsert_env_line(env, ENV_KEY, "").unwrap();
        assert_eq!(removed, "A=1\r\n# nota\r\n");
        // Caso negativo: una clave que solo empieza igual no se toca.
        let other = upsert_env_line("ULTRON_CALENDAR_ICS_URL_X=1\n", ENV_KEY, "").unwrap();
        assert_eq!(other, "ULTRON_CALENDAR_ICS_URL_X=1\n");
        assert!(upsert_env_line("", ENV_KEY, "https://a\nB=2").is_err());
    }

    #[test]
    fn la_url_sale_solo_del_fichero_env_y_no_del_proceso() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".env");
        std::fs::write(
            &path,
            format!(
                "A=1
{ENV_KEY}=https://a.example/x.ics
"
            ),
        )
        .unwrap();
        assert_eq!(
            read_url_at(&path).as_deref(),
            Some("https://a.example/x.ics")
        );
        // Casos negativos: clave vacía, clave ausente y fichero inexistente
        // dan None; `read_url_at` no consulta el entorno del proceso (el test
        // del PTY cubre que la variable no llega a los hijos).
        std::fs::write(
            &path,
            format!(
                "{ENV_KEY}=  
"
            ),
        )
        .unwrap();
        assert_eq!(read_url_at(&path), None);
        std::fs::write(
            &path, "A=1
",
        )
        .unwrap();
        assert_eq!(read_url_at(&path), None);
        assert_eq!(read_url_at(&dir.path().join("no-existe.env")), None);
    }

    #[test]
    fn un_error_de_descarga_no_contiene_la_url() {
        let url = "http://127.0.0.1:9/SECRETO-123/cal.ics?token=SECRETO-456";
        let Err(e) = download(url, &Cache::default()) else {
            panic!("el puerto 9 no debería responder");
        };
        assert!(!e.contains("SECRETO"), "{e}");
        assert!(!e.contains("127.0.0.1"), "{e}");
        assert!(e.starts_with(WHAT), "el prefijo fijo queda intacto: {e}");
    }

    #[test]
    fn un_error_con_la_url_de_una_redireccion_no_la_cita() {
        // Texto inventado con la forma de reqwest: la URL es de otro host.
        let url = "https://cal.example.invalid/feed.ics";
        let msg =
            "error following redirect for url (https://otro.example.invalid/f?t=SECRETO-9): closed";
        let out = redact(msg, url);
        assert!(
            !out.contains("SECRETO") && !out.contains("otro.example"),
            "{out}"
        );
        assert_eq!(out, "error following redirect for url ([calendario] closed");
        // Caso negativo: un texto sin URL no cambia.
        assert_eq!(scrub_urls("tiempo agotado"), "tiempo agotado");
    }

    #[test]
    fn solo_se_siguen_redirecciones_al_mismo_host_por_https() {
        let u = |s: &str| reqwest::Url::parse(s).unwrap();
        let first = u("https://cal.example.invalid/a.ics");
        assert!(redirect_allowed(
            &first,
            &u("https://cal.example.invalid/b.ics"),
            1
        ));
        // Casos negativos: otro host, http y demasiados saltos.
        assert!(!redirect_allowed(
            &first,
            &u("https://otro.example.invalid/a.ics"),
            1
        ));
        assert!(!redirect_allowed(
            &first,
            &u("http://cal.example.invalid/a.ics"),
            1
        ));
        assert!(!redirect_allowed(
            &first,
            &u("https://cal.example.invalid/c.ics"),
            MAX_REDIRECTS + 1
        ));
    }

    #[test]
    fn la_redaccion_quita_host_ruta_y_consulta() {
        let url = "https://cal.example.invalid/feed/SECRETO-123?k=SECRETO-456";
        let msg = format!("fallo en {url} con cal.example.invalid y /feed/SECRETO-123");
        let out = redact(&msg, url);
        assert!(
            !out.contains("SECRETO") && !out.contains("example.invalid"),
            "{out}"
        );
    }
}
