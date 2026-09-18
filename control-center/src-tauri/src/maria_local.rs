// mar.ia — el modelo local, siempre disponible y nunca ocupando VRAM de balde.
//
// Lo que pidio el usuario (2026-09-18 y repetido el 2026-09-19): "que maria en
// el pc inicie siempre la ia local (pero no la cargue) para cuando vaya a
// usarla este disponible".
//
// Son dos cosas distintas y conviene no confundirlas:
//   * el SERVIDOR (`ollama serve`) — proceso de ~30 MB de RAM, 0 de VRAM. Se
//     levanta al arrancar mar.ia y se queda.
//   * el MODELO (qwen3.5:9b, 6,6 GB) — se carga al preguntar y se descarga al
//     contestar (`keep_alive` 0 en el sidecar de voz, descarga explicita en el
//     relevo).
//
// Con el servidor ya arriba, la primera pregunta solo paga la carga del modelo
// (3 s en caliente, hasta 36 s en frio) y no ademas el arranque del servicio.
//
// El arranque REINTENTA: mar.ia se abre con Windows y a veces llega antes de
// que el servicio de Ollama este listo. Un unico intento fallido dejaba la IA
// local caida toda la sesion sin decir nada.

use std::time::Duration;

use serde::Serialize;

/// Intentos de levantar el servidor al arrancar, con espera creciente.
const ESPERAS: &[u64] = &[0, 10, 30, 60];

#[derive(Debug, Clone, Serialize, Default)]
pub struct EstadoLocal {
    /// `ollama serve` responde.
    pub server_up: bool,
    /// Modelo configurado.
    pub model: String,
    /// El modelo esta cargado en memoria AHORA mismo.
    pub model_loaded: bool,
    /// Ollama esta instalado en la maquina.
    pub installed: bool,
}

/// Mira el estado real, sin tocar nada.
#[must_use]
pub fn estado() -> EstadoLocal {
    let model = crate::ollama::toggle::model_name();
    let installed = crate::ollama::toggle::is_installed();
    let ps = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .ok()
        .and_then(|c| c.get("http://127.0.0.1:11434/api/ps").send().ok())
        .and_then(|r| r.text().ok());
    let server_up = ps.is_some();
    let model_loaded = ps
        .as_deref()
        .map(|body| body.contains(&model) && !model.is_empty())
        .unwrap_or(false);
    EstadoLocal {
        server_up,
        model,
        model_loaded,
        installed,
    }
}

/// Levanta `ollama serve` al arrancar, reintentando. Bloqueante: el llamante
/// lo lanza en su propio hilo.
///
/// NO carga el modelo a proposito: dejarlo cargado reservaria 6,6 GB de VRAM
/// desde el arranque del PC, que es justo lo que el usuario no quiere.
pub fn asegurar_al_arranque() {
    if !crate::ollama::toggle::is_installed() {
        tracing::warn!("maria-local: ollama no esta instalado — la IA local no estara disponible");
        return;
    }
    for (intento, espera) in ESPERAS.iter().enumerate() {
        if *espera > 0 {
            std::thread::sleep(Duration::from_secs(*espera));
        }
        match crate::ollama::toggle::ensure_server_running() {
            Ok(()) => {
                let e = estado();
                tracing::info!(
                    intento = intento + 1,
                    modelo = %e.model,
                    cargado = e.model_loaded,
                    "maria-local: servidor disponible"
                );
                return;
            }
            Err(err) => tracing::warn!(
                intento = intento + 1,
                error = %err,
                "maria-local: no pude levantar ollama, reintento"
            ),
        }
    }
    tracing::error!("maria-local: ollama no arranco tras {} intentos", ESPERAS.len());
}

/// Estado del modelo local para la interfaz.
#[tauri::command]
pub async fn maria_local_status() -> Result<EstadoLocal, String> {
    tauri::async_runtime::spawn_blocking(estado)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}

/// Descarga el modelo de la VRAM ahora mismo (boton "liberar" de la interfaz).
#[tauri::command]
pub async fn maria_local_unload() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let modelo = crate::ollama::toggle::model_name();
        crate::ollama::toggle::deactivate(&modelo)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hay_reintentos_y_empiezan_sin_espera() {
        // El primer intento tiene que ser inmediato: si el servidor ya esta
        // arriba, arrancar la app no puede costar 10 segundos de espera.
        assert_eq!(ESPERAS.first(), Some(&0));
        assert!(ESPERAS.len() >= 3, "un solo intento deja la IA caida toda la sesion");
        // Y las esperas tienen que crecer, no repetirse.
        for par in ESPERAS.windows(2) {
            assert!(par[1] > par[0], "esperas no crecientes: {ESPERAS:?}");
        }
    }

    #[test]
    fn el_estado_no_inventa_un_modelo_cargado() {
        // Caso negativo: sin servidor, `model_loaded` tiene que ser false.
        // Un true aqui haria creer a la interfaz que hay 6,6 GB ocupados.
        let e = estado();
        if !e.server_up {
            assert!(!e.model_loaded, "sin servidor no puede haber modelo cargado");
        }
    }
}
