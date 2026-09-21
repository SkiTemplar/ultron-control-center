// ULTRON Control Center — Ollama: comandos Tauri de la seccion "Modelo
// local" en AI Router.
//
// Capa fina de red: valida, adquiere el guard de concurrencia compartido
// con la bandeja (`toggle::try_acquire_busy`, ver `toggle.rs`), delega en
// `toggle.rs`/`api.rs`/`benchmark.rs`/`config.rs` y traduce a los tipos
// que consume el frontend (`api::OllamaStatus`, etc).
//
// Todas las mutaciones (activar/desactivar/cambiar modelo/pull/delete/
// benchmark) toman el guard y devuelven un error explicito si ya hay una
// accion en curso, en vez de encolar o ignorar en silencio (mandamiento
// 11). `ollama_status` es la excepcion deliberada: es una lectura corta
// y el frontend la sondea cada pocos segundos, así que guardarla
// bloquearia el panel entero mientras dura, por ejemplo, una carga en
// frio de 45 s.
//
// Todas menos `ollama_status` son `async fn` que delegan el trabajo
// bloqueante a `spawn_blocking` (mismo patron que
// `commands/system_ops/settings.rs`), para no ocupar el hilo async
// durante una carga en frio o una descarga larga.

use std::io::{BufRead, BufReader};
use std::time::Instant;

use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::api::{self, BenchmarkResult, OllamaStatus, PullProgressEvent};
use super::benchmark;
use super::config;
use super::editor::{self, EditorEngineStatus};
use super::toggle::{self, OllamaState};

const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";
const BUSY_ERROR: &str = "hay otra accion de Ollama en curso — espera a que termine";

fn version_url() -> String {
    format!("{OLLAMA_BASE_URL}/api/version")
}
fn tags_url() -> String {
    format!("{OLLAMA_BASE_URL}/api/tags")
}
fn ps_url() -> String {
    format!("{OLLAMA_BASE_URL}/api/ps")
}
fn pull_url() -> String {
    format!("{OLLAMA_BASE_URL}/api/pull")
}
fn delete_url() -> String {
    format!("{OLLAMA_BASE_URL}/api/delete")
}
fn generate_url() -> String {
    format!("{OLLAMA_BASE_URL}/api/generate")
}

/// Snapshot de estado — logica compartida entre el comando `ollama_status`
/// y el final de `ollama_set_model` (que devuelve el estado ya
/// actualizado en la misma llamada para que el frontend no tenga que
/// encadenar un segundo `invoke`). Nunca falla por Ollama ausente/parado
/// — eso es un estado valido, no un error de comando.
fn compute_status() -> OllamaStatus {
    let configured_model = toggle::model_name();
    let configured_model_source = toggle::model_name_source();
    let installed = toggle::is_installed();

    let down_status = || OllamaStatus {
        installed,
        server_up: false,
        version: None,
        configured_model: configured_model.clone(),
        configured_model_source,
        loaded_models: Vec::new(),
        downloaded_models: Vec::new(),
    };

    let Ok(client) = crate::ai_router::health::http_client() else {
        return down_status();
    };

    let Some(ps_body) = client.get(ps_url()).send().ok().and_then(|r| r.text().ok()) else {
        return down_status();
    };

    let loaded_models = api::parse_loaded_models(&ps_body).unwrap_or_default();
    let version = client
        .get(version_url())
        .send()
        .ok()
        .and_then(|r| r.text().ok())
        .and_then(|b| api::parse_version(&b));
    let downloaded_models = client
        .get(tags_url())
        .send()
        .ok()
        .and_then(|r| r.text().ok())
        .and_then(|b| api::parse_downloaded_models(&b).ok())
        .unwrap_or_default();

    OllamaStatus {
        installed,
        server_up: true,
        version,
        configured_model,
        configured_model_source,
        loaded_models,
        downloaded_models,
    }
}

/// Estado completo: instalado, servidor arriba, version, modelo
/// configurado (+ de donde sale), modelos cargados (con VRAM y
/// expiracion) y descargados.
#[tauri::command]
pub fn ollama_status() -> Result<OllamaStatus, String> {
    Ok(compute_status())
}

/// Activa el autocompletado con `model` (o el configurado si se omite).
#[tauri::command]
pub async fn ollama_activate(model: Option<String>) -> Result<(), String> {
    let Some(guard) = toggle::try_acquire_busy() else {
        return Err(BUSY_ERROR.to_string());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let target = model.unwrap_or_else(toggle::model_name);
        toggle::activate(&target)
    })
    .await
    .map_err(|e| format!("fallo interno al activar Ollama: {e}"))?
}

/// Desactiva (descarga de memoria) `model` (o el configurado si se omite).
#[tauri::command]
pub async fn ollama_deactivate(model: Option<String>) -> Result<(), String> {
    let Some(guard) = toggle::try_acquire_busy() else {
        return Err(BUSY_ERROR.to_string());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let target = model.unwrap_or_else(toggle::model_name);
        toggle::deactivate(&target)
    })
    .await
    .map_err(|e| format!("fallo interno al desactivar Ollama: {e}"))?
}

/// Cambia el modelo elegido: lo persiste (`config::write_configured_model`)
/// y, si el modelo anterior estaba cargado, lo descarga y carga el nuevo
/// para que el cambio tenga efecto inmediato. Si no habia nada cargado,
/// solo persiste — no fuerza una carga que el usuario no ha pedido.
/// Devuelve el estado ya actualizado.
#[tauri::command]
pub async fn ollama_set_model(name: String) -> Result<OllamaStatus, String> {
    if !api::is_valid_model_name(&name) {
        return Err(format!("nombre de modelo invalido: '{name}'"));
    }
    let Some(guard) = toggle::try_acquire_busy() else {
        return Err(BUSY_ERROR.to_string());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let previous = toggle::model_name();
        if previous != name && toggle::query_state(&previous) == OllamaState::Loaded {
            toggle::deactivate(&previous)?;
            toggle::activate(&name)?;
        }
        config::write_configured_model(&name)?;
        Ok::<OllamaStatus, String>(compute_status())
    })
    .await
    .map_err(|e| format!("fallo interno al cambiar de modelo: {e}"))?
}

/// N peticiones FIM en caliente y mediana/maximo. Exige que `model` (o el
/// configurado) este ya cargado — no lo carga en silencio, eso alteraria
/// la medicion y ocultaria una latencia real de carga en frio.
#[tauri::command]
pub async fn ollama_benchmark(model: Option<String>) -> Result<BenchmarkResult, String> {
    let Some(guard) = toggle::try_acquire_busy() else {
        return Err(BUSY_ERROR.to_string());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let target = model.unwrap_or_else(toggle::model_name);
        if toggle::query_state(&target) != OllamaState::Loaded {
            return Err(format!(
                "el modelo '{target}' no esta cargado — actívalo antes de medir latencia"
            ));
        }
        run_benchmark(&target)
    })
    .await
    .map_err(|e| format!("fallo interno al medir latencia: {e}"))?
}

fn run_benchmark(model: &str) -> Result<BenchmarkResult, String> {
    let client = crate::ai_router::health::http_client()?;
    let body = benchmark::benchmark_request_body(model);
    let mut samples_ms = Vec::with_capacity(benchmark::SAMPLE_COUNT);
    let mut last_response = String::new();

    for _ in 0..benchmark::SAMPLE_COUNT {
        let start = Instant::now();
        let resp = client
            .post(generate_url())
            .json(&body)
            .send()
            .map_err(|e| format!("fallo al medir latencia de '{model}': {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().unwrap_or_default();
            return Err(format!(
                "ollama devolvio {status} al medir latencia de '{model}': {text}"
            ));
        }
        let text = resp
            .text()
            .map_err(|e| format!("respuesta invalida al medir latencia: {e}"))?;
        samples_ms.push(start.elapsed().as_millis() as u64);
        last_response = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("response")
                    .and_then(|r| r.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default();
    }

    let suggested_line = last_response.lines().next().unwrap_or("").to_string();

    Ok(BenchmarkResult {
        model: model.to_string(),
        median_ms: benchmark::median_ms(&samples_ms),
        max_ms: benchmark::max_ms(&samples_ms),
        samples_ms,
        suggested_line,
    })
}

/// Descarga (`pull`) `name` desde el registro de Ollama. Emite progreso
/// incremental como evento `ollama_pull_progress` (payload
/// `api::PullProgressEvent`) leyendo el stream NDJSON de
/// `POST /api/pull`. Sin timeout total: una descarga legitima puede
/// tardar minutos.
#[tauri::command]
pub async fn ollama_pull(app: AppHandle, name: String) -> Result<(), String> {
    if !api::is_valid_model_name(&name) {
        return Err(format!("nombre de modelo invalido: '{name}'"));
    }
    let Some(guard) = toggle::try_acquire_busy() else {
        return Err(BUSY_ERROR.to_string());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        run_pull(&app, &name)
    })
    .await
    .map_err(|e| format!("fallo interno al descargar el modelo: {e}"))?
}

fn run_pull(app: &AppHandle, name: &str) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .build()
        .map_err(|e| format!("no se pudo construir el cliente HTTP: {e}"))?;

    let resp = client
        .post(pull_url())
        .json(&json!({ "model": name, "stream": true }))
        .send()
        .map_err(|e| format!("fallo al iniciar la descarga de '{name}': {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!(
            "ollama devolvio {status} al descargar '{name}': {text}"
        ));
    }

    let reader = BufReader::new(resp);
    for line in reader.lines() {
        let line = line.map_err(|e| format!("fallo leyendo el progreso de la descarga: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let event: PullProgressEvent = api::parse_pull_progress_line(name, &line)?;
        let error_message = event.error.clone();
        let _ = app.emit("ollama_pull_progress", &event);
        if let Some(message) = error_message {
            return Err(message);
        }
    }

    Ok(())
}

/// Borra `name` de disco. Exige que no este cargado en memoria —
/// descargarlo primero evita borrar bajo los pies de una sesion activa.
#[tauri::command]
pub async fn ollama_delete(name: String) -> Result<(), String> {
    if !api::is_valid_model_name(&name) {
        return Err(format!("nombre de modelo invalido: '{name}'"));
    }
    let Some(guard) = toggle::try_acquire_busy() else {
        return Err(BUSY_ERROR.to_string());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        if toggle::query_state(&name) == OllamaState::Loaded {
            return Err(format!(
                "'{name}' esta cargado en memoria — descargalo antes de borrarlo"
            ));
        }
        let client = crate::ai_router::health::http_client()?;
        let resp = client
            .delete(delete_url())
            .json(&json!({ "model": name }))
            .send()
            .map_err(|e| format!("fallo al borrar '{name}': {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().unwrap_or_default();
            return Err(format!(
                "ollama devolvio {status} al borrar '{name}': {text}"
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("fallo interno al borrar el modelo: {e}"))?
}

// ---------------------------------------------------------------------------
// Pruebas de humo — REALES, contra un Ollama vivo en localhost:11434.
//
// No corren en `cargo test` normal (dependen de red + del binario
// instalado): se ejecutan a mano con
//   cargo test --features finance --lib ollama::commands::smoke_tests -- --ignored --nocapture
//
// Llaman directamente a la logica interna (`compute_status`,
// `run_benchmark`) en vez de a los wrappers `#[tauri::command]` async
// porque `tauri::async_runtime::spawn_blocking` fuera de una app Tauri
// arrancada no tiene runtime al que enganchar.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Motor de autocompletado del editor (extension `ollama-tab` de VS Code).
// ---------------------------------------------------------------------------

/// Motor activo segun el `settings.json` de VS Code, con los tres modelos
/// locales configurados. `available: false` = no se encontro el fichero.
#[tauri::command]
pub fn editor_engine_status() -> Result<EditorEngineStatus, String> {
    Ok(editor::status())
}

/// Cambia el motor del editor: lo escribe en `settings.json` (Copilot queda en
/// el estado contrario), suelta de VRAM los modelos que ya no tocan y carga el
/// del motor elegido. VS Code recoge el cambio en caliente, sin reiniciar.
#[tauri::command]
pub async fn editor_engine_set(engine: String) -> Result<EditorEngineStatus, String> {
    let Some(guard) = toggle::try_acquire_busy() else {
        return Err(BUSY_ERROR.to_string());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let (target, unload) = editor::write_engine(&engine)?;

        // Soltar primero y cargar despues: con 8 GB de VRAM, hacerlo al reves
        // deja los dos modelos dentro a la vez.
        for model in unload {
            if toggle::query_state(&model) == OllamaState::Loaded {
                toggle::deactivate(&model)?;
            }
        }
        if let Some(model) = target {
            toggle::activate(&model)?;
        }
        Ok::<EditorEngineStatus, String>(editor::status())
    })
    .await
    .map_err(|e| format!("fallo interno al cambiar el motor del editor: {e}"))?
}

#[cfg(test)]
mod smoke_tests {
    use super::*;

    #[test]
    #[ignore]
    fn status_contra_ollama_vivo() {
        let status = compute_status();
        println!("{status:#?}");
        assert!(
            status.installed,
            "ollama.exe no se encontro — instala Ollama antes de correr esta prueba"
        );
    }

    #[test]
    #[ignore]
    fn benchmark_contra_ollama_vivo() {
        let model = toggle::model_name();
        toggle::activate(&model).expect("activar el modelo antes de medir la latencia");
        let result = run_benchmark(&model).expect("el benchmark deberia completar sin error");
        println!("{result:#?}");
        assert_eq!(result.samples_ms.len(), benchmark::SAMPLE_COUNT);
        assert!(
            result.median_ms > 0,
            "la mediana no puede ser cero con el modelo cargado"
        );
    }
}
