// ULTRON Control Center — Ollama: interruptor del modelo local.
//
// Gestiona el ciclo de vida del modelo local usado como autocompletado de
// codigo (Ollama): localizar/arrancar el servidor si hace falta, cargar o
// descargar el modelo en memoria y consultar el estado real via
// `GET /api/ps`. Modulo puro en I/O + parseo — sin dependencia de Tauri —
// para que sea testeable sin red y para que `tray.rs` se limite a cablear
// la entrada de menu contra estas funciones.
//
// Precedencia del modelo configurado (ver `model_name`/`resolve_model_name`):
//   1. Variable de entorno `ULTRON_OLLAMA_MODEL` (override manual/CI).
//   2. Modelo persistido por la UI (`config::read_configured_model`, ver
//      `../config.rs` — `cockpit/ollama/config.json`).
//   3. `DEFAULT_MODEL`.
//
// `OLLAMA_BUSY` (mas abajo) es el guard de concurrencia COMPARTIDO entre
// el clic de la bandeja (`tray.rs`) y los comandos Tauri de la seccion
// "Modelo local" en AI Router (`commands.rs`): solo puede haber una
// accion de red en curso a la vez, para no lanzar dos `ollama serve` o
// pisar una carga con una descarga a medio camino.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::config;

/// Modelo por defecto cuando no hay override de entorno ni modelo
/// persistido.
const DEFAULT_MODEL: &str = "qwen2.5-coder:1.5b-base";

/// Host de la API REST de Ollama. Fijo a loopback: es donde escucha por
/// defecto y este interruptor no necesita hablar con una instancia remota.
const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";

/// Cliente HTTP para los sondeos cortos del servidor de Ollama.
fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build http client: {e}"))
}

/// Tiempo maximo de espera a que `ollama serve`, lanzado en segundo plano,
/// empiece a responder en `/api/ps`.
const SERVE_START_TIMEOUT: Duration = Duration::from_secs(15);

/// Intervalo de sondeo mientras se espera a que el servidor arranque.
const SERVE_POLL_INTERVAL: Duration = Duration::from_millis(300);

/// Timeout de la peticion que carga o descarga el modelo. La carga en frio
/// puede tardar decenas de segundos (medido: ~44 s para
/// `qwen2.5-coder:1.5b-base`), muy por encima del timeout corto que usa el
/// resto del AI Router para sondeos de salud — por eso usa su propio
/// cliente HTTP en vez de `ai_router::health::http_client()`.
const LOAD_TIMEOUT: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------
// Decision de accion activar/desactivar — SIEMPRE a partir del estado
// real, nunca de la marca visual de un CheckMenuItem.
//
// En Windows, `muda` invierte `item.checked` dentro de `menu_selected`
// ANTES de despachar el clic a `on_menu_event` (crate `muda` 0.19.1,
// `src/platform_impl/windows/mod.rs:1195-1199`:
// `MenuItemType::Check => { let checked = !item.checked; item.set_checked(checked); }`,
// fichero real en este equipo:
// `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/muda-0.19.1/src/platform_impl/windows/mod.rs`).
// Eso significa que `item.is_checked()`, leido DESPUES desde
// `on_menu_event` (tray.rs), ya viene invertido respecto al estado que
// tenia el item antes del clic — decidir activar/desactivar a partir de
// esa lectura manda sistematicamente la accion contraria (p. ej. activar
// un modelo que ya estaba cargado, que no hace nada visible y deja al
// usuario pensando que el clic no desactivo nada). La fuente de verdad es
// siempre `query_state` contra `/api/ps`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Configuracion
// ---------------------------------------------------------------------------

/// Precedencia pura del modelo configurado: entorno > persistido > por
/// defecto. Separada de `model_name`/`model_name_source` para poder
/// testearla sin tocar el sistema de archivos ni variables de entorno
/// reales (ver tests). Ambos argumentos ya vienen recortados o `None`.
fn resolve_model_name(
    env_value: Option<String>,
    persisted: Option<String>,
) -> (String, &'static str) {
    if let Some(v) = env_value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        return (v, "env");
    }
    if let Some(v) = persisted
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        return (v, "config");
    }
    (DEFAULT_MODEL.to_string(), "default")
}

/// Nombre del modelo a usar. Ver la precedencia documentada al inicio del
/// fichero.
pub fn model_name() -> String {
    resolve_model_name(
        std::env::var("ULTRON_OLLAMA_MODEL").ok(),
        config::read_configured_model(),
    )
    .0
}

fn ps_url() -> String {
    format!("{OLLAMA_BASE_URL}/api/ps")
}

fn generate_url() -> String {
    format!("{OLLAMA_BASE_URL}/api/generate")
}

// ---------------------------------------------------------------------------
// Parseo de /api/ps y construccion de cuerpos de peticion (puro, testeable)
// ---------------------------------------------------------------------------

/// Cuerpo de `POST /api/generate` para descargar `model` de memoria de
/// forma inmediata (`keep_alive: 0`).
fn unload_body(model: &str) -> Value {
    json!({
        "model": model,
        "keep_alive": 0,
    })
}

// ---------------------------------------------------------------------------
// Localizacion del binario
// ---------------------------------------------------------------------------

/// Busca `ollama.exe` en PATH y, si no aparece, en la ruta de instalacion
/// por defecto de Windows (`%LOCALAPPDATA%\Programs\Ollama\ollama.exe`).
fn locate_ollama_binary() -> Option<PathBuf> {
    if let Ok(path) = which::which("ollama") {
        return Some(path);
    }
    let local_appdata = std::env::var_os("LOCALAPPDATA")?;
    let candidate = PathBuf::from(local_appdata)
        .join("Programs")
        .join("Ollama")
        .join("ollama.exe");
    candidate.exists().then_some(candidate)
}

/// `true` si `ollama.exe` se encuentra en PATH o en la ruta de instalacion
/// por defecto. Expuesto para el comando `ollama_status` (AI Router).
pub fn is_installed() -> bool {
    locate_ollama_binary().is_some()
}

// ---------------------------------------------------------------------------
// Cliente HTTP dedicado a cargas largas
// ---------------------------------------------------------------------------

fn load_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(LOAD_TIMEOUT)
        .build()
        .map_err(|e| format!("no se pudo construir el cliente HTTP: {e}"))
}

// ---------------------------------------------------------------------------
// Consulta de estado (bloqueante — llamar desde un hilo de fondo)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Arranque del servidor
// ---------------------------------------------------------------------------

/// Arranca `ollama serve` oculto en segundo plano si la API no responde, y
/// espera (con timeout acotado) a que empiece a contestar. No hace nada si
/// la API ya esta arriba.
/// Levanta `ollama serve` si no responde. NO carga ningun modelo: el
/// servidor en reposo ocupa ~30 MB de RAM y 0 de VRAM, y es lo que permite
/// que la primera pregunta solo pague la carga del modelo y no ademas el
/// arranque del servicio. mar.ia lo llama al arrancar (ver `lib.rs`).
pub fn ensure_server_running() -> Result<(), String> {
    let client = http_client()?;
    if client.get(ps_url()).send().is_ok() {
        return Ok(()); // ya esta arriba
    }

    let binary = locate_ollama_binary().ok_or_else(|| {
        "ollama.exe no encontrado en PATH ni en %LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe \
         — Ollama no parece instalado"
            .to_string()
    })?;

    let mut cmd = crate::proc::oculto(&binary);
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn()
        .map_err(|e| format!("no se pudo lanzar 'ollama serve': {e}"))?;

    let deadline = Instant::now() + SERVE_START_TIMEOUT;
    while Instant::now() < deadline {
        if client.get(ps_url()).send().is_ok() {
            return Ok(());
        }
        std::thread::sleep(SERVE_POLL_INTERVAL);
    }
    Err(format!(
        "'ollama serve' no respondio en {} s",
        SERVE_START_TIMEOUT.as_secs()
    ))
}

// ---------------------------------------------------------------------------
// Activar / desactivar (bloqueantes — llamar desde un hilo de fondo)
// ---------------------------------------------------------------------------

/// Desactiva el autocompletado: descarga `model` de memoria
/// (`keep_alive: 0`). No detiene el proceso `ollama serve`.
pub fn deactivate(model: &str) -> Result<(), String> {
    let client = load_client()?;
    let resp = client
        .post(generate_url())
        .json(&unload_body(model))
        .send()
        .map_err(|e| format!("fallo al descargar el modelo '{model}': {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!(
            "ollama devolvio {status} al descargar '{model}': {text}"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unload_body_fija_keep_alive_cero() {
        let body = unload_body("qwen2.5-coder:1.5b-base");
        assert_eq!(body["model"], "qwen2.5-coder:1.5b-base");
        assert_eq!(body["keep_alive"], 0);
        // La peticion de descarga no debe llevar prompt: no se pide
        // inferencia, solo liberar memoria.
        assert!(body.get("prompt").is_none());
    }

    // -- resolve_model_name: precedencia pura, sin tocar entorno ni disco --

    #[test]
    fn resolve_model_name_prioriza_el_entorno_sobre_lo_persistido() {
        let (model, source) = resolve_model_name(
            Some("del-entorno:latest".to_string()),
            Some("persistido:latest".to_string()),
        );
        assert_eq!(model, "del-entorno:latest");
        assert_eq!(source, "env");
    }

    #[test]
    fn resolve_model_name_usa_lo_persistido_sin_entorno() {
        let (model, source) = resolve_model_name(None, Some("persistido:latest".to_string()));
        assert_eq!(model, "persistido:latest");
        assert_eq!(source, "config");
    }

    #[test]
    fn resolve_model_name_recorta_espacios_en_ambas_fuentes() {
        let (model, source) = resolve_model_name(
            Some("   ".to_string()),
            Some("  persistido:latest  ".to_string()),
        );
        assert_eq!(model, "persistido:latest");
        assert_eq!(source, "config");
    }

    #[test]
    fn resolve_model_name_cae_al_valor_por_defecto_sin_ninguna_fuente() {
        let (model, source) = resolve_model_name(None, None);
        assert_eq!(model, DEFAULT_MODEL);
        assert_eq!(source, "default");
    }
}
