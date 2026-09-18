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
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::ai_router::health::http_client;

use super::config;

/// Modelo por defecto cuando no hay override de entorno ni modelo
/// persistido.
const DEFAULT_MODEL: &str = "qwen2.5-coder:1.5b-base";

/// Host de la API REST de Ollama. Fijo a loopback: es donde escucha por
/// defecto y este interruptor no necesita hablar con una instancia remota.
const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";

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
// Guard de concurrencia — compartido entre la bandeja y los comandos
// ---------------------------------------------------------------------------

/// `true` mientras hay una accion de Ollama (activar/desactivar/cambiar
/// modelo/pull/delete/benchmark) en curso. No se manipula directamente
/// fuera de este modulo — usar `try_acquire_busy`.
static OLLAMA_BUSY: AtomicBool = AtomicBool::new(false);

/// RAII: libera `OLLAMA_BUSY` al salir de scope, incluso si el cierre que
/// lo sostiene entra en panic (p. ej. dentro de `spawn_blocking`). Evita
/// que un fallo a medio camino deje el guard atascado en `true`.
pub struct BusyGuard(());

impl Drop for BusyGuard {
    fn drop(&mut self) {
        OLLAMA_BUSY.store(false, Ordering::SeqCst);
    }
}

/// Intenta tomar el guard de concurrencia de Ollama. `Some(guard)` si se
/// ha tomado — mantener `guard` vivo mientras dure la accion; se libera
/// solo al soltarlo (fin de scope). `None` si ya habia una accion en
/// curso: el llamador debe devolver un error explicito, nunca ignorar el
/// clic/comando en silencio.
pub fn try_acquire_busy() -> Option<BusyGuard> {
    OLLAMA_BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| BusyGuard(()))
}

// ---------------------------------------------------------------------------
// Estado del interruptor
// ---------------------------------------------------------------------------

/// Estado visible del interruptor. `tray.rs` lo traduce a texto + marca de
/// check de la entrada de menu; nunca hay un estado "silencioso" que deje
/// al usuario sin pista de lo que pasa (mandamiento 11: nada de no-op
/// silencioso).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OllamaState {
    /// El modelo esta cargado en memoria segun `/api/ps`.
    Loaded,
    /// La API responde pero el modelo no esta cargado (o el servidor esta
    /// parado y el binario si esta instalado: activarlo lo arrancara).
    Unloaded,
    /// Accion "activar" en curso (arranque de servidor + carga del modelo).
    Loading,
    /// No se encontro `ollama.exe` ni en PATH ni en la ruta por defecto de
    /// instalacion — Ollama no parece instalado.
    NotInstalled,
    /// Fallo al hablar con la API o respuesta invalida/inesperada.
    Error,
}

impl OllamaState {
    /// Texto a mostrar en la entrada de menu para `model`.
    pub fn menu_label(self, model: &str) -> String {
        match self {
            OllamaState::Loaded => format!("Ollama: {model} (activo)"),
            OllamaState::Unloaded => "Ollama (autocompletado)".to_string(),
            OllamaState::Loading => "Ollama: cargando…".to_string(),
            OllamaState::NotInstalled => "Ollama: no instalado".to_string(),
            OllamaState::Error => "Ollama: error".to_string(),
        }
    }

    /// Si la entrada de menu debe mostrarse marcada (modelo activo).
    pub fn is_checked(self) -> bool {
        matches!(self, OllamaState::Loaded)
    }
}

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

/// Accion que toca ante un clic/comando "activar-o-desactivar", decidida
/// a partir de `OllamaState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleAction {
    Activate,
    Deactivate,
}

/// `Loaded` -> desactivar; cualquier otro estado (`Unloaded`,
/// `NotInstalled`, `Error`, `Loading`) -> activar. Match exhaustivo (sin
/// `_`) a proposito: es la decision de negocio central de este modulo.
pub fn action_for_state(state: OllamaState) -> ToggleAction {
    match state {
        OllamaState::Loaded => ToggleAction::Deactivate,
        OllamaState::Unloaded
        | OllamaState::NotInstalled
        | OllamaState::Error
        | OllamaState::Loading => ToggleAction::Activate,
    }
}

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

/// De donde sale el modelo que devuelve `model_name`: `"env"`, `"config"`
/// o `"default"`. Solo para mostrarlo en la UI (AI Router > Modelo local)
/// — no cambia comportamiento.
pub fn model_name_source() -> &'static str {
    resolve_model_name(
        std::env::var("ULTRON_OLLAMA_MODEL").ok(),
        config::read_configured_model(),
    )
    .1
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

/// Comprueba si `model` aparece entre los modelos cargados que devuelve
/// `GET /api/ps`. Ollama expone el nombre en el campo `name` (y, en
/// versiones recientes, tambien en `model`); se comprueban ambos para no
/// depender de una version concreta del daemon. Si el JSON es invalido se
/// devuelve `Err`; si es valido pero no trae `models` (o esta vacio), se
/// interpreta como "ningun modelo cargado" (`Ok(false)`).
fn model_loaded_in_ps(body: &str, model: &str) -> Result<bool, String> {
    let parsed: Value =
        serde_json::from_str(body).map_err(|e| format!("JSON de /api/ps invalido: {e}"))?;
    let empty = Vec::new();
    let models = parsed
        .get("models")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let found = models.iter().any(|m| {
        m.get("name").and_then(Value::as_str) == Some(model)
            || m.get("model").and_then(Value::as_str) == Some(model)
    });
    Ok(found)
}

/// Cuerpo de `POST /api/generate` para cargar `model` en memoria y
/// fijarlo ahi (`keep_alive: -1` = no descargar nunca hasta que se pida
/// explicitamente).
fn load_body(model: &str) -> Value {
    json!({
        "model": model,
        "prompt": "",
        "keep_alive": -1,
    })
}

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

/// Consulta `/api/ps` y determina el estado actual del interruptor para
/// `model`. Nunca falla de forma silenciosa: si la API no responde,
/// distingue entre "no instalado" (binario no encontrado) y "error"
/// (instalado pero algo fue mal), para que el menu no se quede en un
/// estado ambiguo.
pub fn query_state(model: &str) -> OllamaState {
    let client = match http_client() {
        Ok(c) => c,
        Err(_) => return OllamaState::Error,
    };
    match client.get(ps_url()).send() {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.text().unwrap_or_default();
            match model_loaded_in_ps(&body, model) {
                Ok(true) => OllamaState::Loaded,
                Ok(false) => OllamaState::Unloaded,
                Err(_) => OllamaState::Error,
            }
        }
        _ => {
            if is_installed() {
                // Instalado pero el servidor esta parado: activar lo
                // arrancara, así que se trata igual que "descargado".
                OllamaState::Unloaded
            } else {
                OllamaState::NotInstalled
            }
        }
    }
}

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

/// Activa el autocompletado: arranca el servidor si hace falta y carga
/// `model` en memoria de forma fija (`keep_alive: -1`). Bloqueante — la
/// carga en frio puede tardar decenas de segundos, así que el llamador
/// debe ejecutar esto en un hilo de fondo (p. ej.
/// `tauri::async_runtime::spawn_blocking`) para no congelar el hilo del
/// menu.
pub fn activate(model: &str) -> Result<(), String> {
    ensure_server_running()?;
    let client = load_client()?;
    let resp = client
        .post(generate_url())
        .json(&load_body(model))
        .send()
        .map_err(|e| format!("fallo al cargar el modelo '{model}': {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!(
            "ollama devolvio {status} al cargar '{model}': {text}"
        ));
    }
    Ok(())
}

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
    fn model_loaded_in_ps_detecta_modelo_presente_por_name() {
        let body = r#"{"models":[{"name":"qwen2.5-coder:1.5b-base","size":123}]}"#;
        assert_eq!(
            model_loaded_in_ps(body, "qwen2.5-coder:1.5b-base"),
            Ok(true)
        );
    }

    #[test]
    fn model_loaded_in_ps_detecta_modelo_presente_por_model() {
        let body = r#"{"models":[{"model":"qwen2.5-coder:1.5b-base"}]}"#;
        assert_eq!(
            model_loaded_in_ps(body, "qwen2.5-coder:1.5b-base"),
            Ok(true)
        );
    }

    #[test]
    fn model_loaded_in_ps_devuelve_false_cuando_el_modelo_no_esta() {
        let body = r#"{"models":[{"name":"otro-modelo:latest"}]}"#;
        assert_eq!(
            model_loaded_in_ps(body, "qwen2.5-coder:1.5b-base"),
            Ok(false)
        );
    }

    #[test]
    fn model_loaded_in_ps_devuelve_false_con_lista_vacia() {
        let body = r#"{"models":[]}"#;
        assert_eq!(
            model_loaded_in_ps(body, "qwen2.5-coder:1.5b-base"),
            Ok(false)
        );
    }

    #[test]
    fn model_loaded_in_ps_devuelve_false_sin_campo_models() {
        let body = r#"{}"#;
        assert_eq!(
            model_loaded_in_ps(body, "qwen2.5-coder:1.5b-base"),
            Ok(false)
        );
    }

    /// Caso negativo: JSON malformado debe propagar un error, no un falso
    /// "no cargado" silencioso.
    #[test]
    fn model_loaded_in_ps_falla_con_json_invalido() {
        let body = "esto no es JSON";
        let result = model_loaded_in_ps(body, "qwen2.5-coder:1.5b-base");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalido"));
    }

    #[test]
    fn load_body_fija_keep_alive_indefinido() {
        let body = load_body("qwen2.5-coder:1.5b-base");
        assert_eq!(body["model"], "qwen2.5-coder:1.5b-base");
        assert_eq!(body["prompt"], "");
        assert_eq!(body["keep_alive"], -1);
    }

    #[test]
    fn unload_body_fija_keep_alive_cero() {
        let body = unload_body("qwen2.5-coder:1.5b-base");
        assert_eq!(body["model"], "qwen2.5-coder:1.5b-base");
        assert_eq!(body["keep_alive"], 0);
        // La peticion de descarga no debe llevar prompt: no se pide
        // inferencia, solo liberar memoria.
        assert!(body.get("prompt").is_none());
    }

    /// Las variantes de `ULTRON_OLLAMA_MODEL` que resuelve `model_name`
    /// cuando esta definida (unico caso que no depende del fichero de
    /// config persistido, así que es seguro probarlo contra el entorno
    /// real sin tocar disco). `std::env::set_var` es estado de proceso
    /// compartido y `cargo test` corre los tests en paralelo, así que se
    /// agrupan en un unico test para no correr una carrera de datos sobre
    /// la misma variable.
    #[test]
    fn model_name_respeta_la_variable_de_entorno_cuando_esta_definida() {
        std::env::set_var("ULTRON_OLLAMA_MODEL", "otro-modelo:latest");
        assert_eq!(model_name(), "otro-modelo:latest");
        assert_eq!(model_name_source(), "env");

        std::env::remove_var("ULTRON_OLLAMA_MODEL");
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

    #[test]
    fn ollama_state_menu_label_refleja_cada_estado() {
        let model = "qwen2.5-coder:1.5b-base";
        assert_eq!(
            OllamaState::Loaded.menu_label(model),
            "Ollama: qwen2.5-coder:1.5b-base (activo)"
        );
        assert_eq!(
            OllamaState::Unloaded.menu_label(model),
            "Ollama (autocompletado)"
        );
        assert_eq!(OllamaState::Loading.menu_label(model), "Ollama: cargando…");
        assert_eq!(
            OllamaState::NotInstalled.menu_label(model),
            "Ollama: no instalado"
        );
        assert_eq!(OllamaState::Error.menu_label(model), "Ollama: error");
    }

    #[test]
    fn action_for_state_desactiva_cuando_esta_cargado() {
        assert_eq!(
            action_for_state(OllamaState::Loaded),
            ToggleAction::Deactivate
        );
    }

    /// Caso negativo: NINGUN otro estado debe pedir desactivar — todos
    /// piden activar. Si esto fallara, un clic con el modelo ya
    /// descargado (o Ollama sin instalar) intentaria desactivar de nuevo,
    /// un no-op que oculta el problema real al usuario.
    #[test]
    fn action_for_state_activa_en_cualquier_otro_estado() {
        for state in [
            OllamaState::Unloaded,
            OllamaState::NotInstalled,
            OllamaState::Error,
            OllamaState::Loading,
        ] {
            assert_eq!(
                action_for_state(state),
                ToggleAction::Activate,
                "{state:?} deberia pedir Activate, no Deactivate"
            );
        }
    }

    #[test]
    fn solo_loaded_se_muestra_marcado() {
        assert!(OllamaState::Loaded.is_checked());
        assert!(!OllamaState::Unloaded.is_checked());
        assert!(!OllamaState::Loading.is_checked());
        assert!(!OllamaState::NotInstalled.is_checked());
        assert!(!OllamaState::Error.is_checked());
    }

    /// El guard de concurrencia solo deja pasar una accion a la vez, y se
    /// libera solo al soltar el guard (no antes, no automaticamente por
    /// otra razon).
    #[test]
    fn busy_guard_serializa_acciones() {
        let first = try_acquire_busy();
        assert!(first.is_some(), "el primer intento debe tomar el guard");

        let second = try_acquire_busy();
        assert!(
            second.is_none(),
            "un segundo intento mientras el primero sigue vivo debe fallar"
        );

        drop(first);

        let third = try_acquire_busy();
        assert!(
            third.is_some(),
            "tras soltar el guard, un nuevo intento debe poder tomarlo"
        );
        drop(third);
    }
}
