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

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde::Serialize;

/// Intentos de levantar el servidor al arrancar, con espera creciente.
const ESPERAS: &[u64] = &[0, 10, 30, 60];

/// Cada cuanto mira el vigilante si hay VRAM ocupada de balde.
const RONDA_VIGILANTE: Duration = Duration::from_secs(20);

/// Turnos que estan usando el modelo AHORA MISMO.
///
/// El usuario fue tajante (2026-09-19): "nunca debe estar en memoria (vram)
/// todo el rato, solo el momento que se use". Este contador es lo que
/// distingue "lo esta usando alguien" de "se quedo cargado". Es un contador y
/// no un booleano porque la voz y el chat pueden pedir a la vez.
static TURNOS_ACTIVOS: AtomicUsize = AtomicUsize::new(0);

/// Marca que hay un turno usando el modelo. Al soltarse (Drop), lo descarga si
/// era el ultimo.
///
/// Se hace con Drop a proposito: un `return` temprano, un `?` o un panico
/// dejaban antes el modelo cargado, y eso es justo lo que paso — 8,65 GB
/// ocupados con la aplicacion ya cerrada.
pub struct EnUso;

impl EnUso {
    #[must_use]
    pub fn nuevo() -> Self {
        TURNOS_ACTIVOS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for EnUso {
    fn drop(&mut self) {
        if TURNOS_ACTIVOS.fetch_sub(1, Ordering::SeqCst) == 1 {
            descargar();
        }
    }
}

/// ¿Hay algun turno usando el modelo?
#[must_use]
pub fn en_uso() -> bool {
    TURNOS_ACTIVOS.load(Ordering::SeqCst) > 0
}

/// Suelta el modelo de la VRAM. Silencioso: si Ollama no esta, no hay nada que
/// soltar.
pub fn descargar() {
    let modelo = crate::ollama::toggle::model_name();
    if modelo.is_empty() {
        return;
    }
    if let Err(e) = crate::ollama::toggle::deactivate(&modelo) {
        tracing::debug!(error = %e, "maria-local: no pude descargar el modelo");
    }
}

/// Vigilante de la VRAM: cada 20 s, si NADIE esta usando el modelo y sigue
/// cargado, lo descarga.
///
/// Por que hace falta ademas del Drop: el Drop solo corre si el proceso sigue
/// vivo. Un cierre a mitad de turno, un `taskkill` o una llamada hecha desde
/// fuera de mar.ia dejaban el modelo cargado hasta que expirara su keep_alive
/// (2 minutos). Medido el 2026-09-19: 8.926 MiB de VRAM con la aplicacion
/// cerrada. Este hilo es la red que no depende de terminar bien.
pub fn vigilar_vram() {
    loop {
        std::thread::sleep(RONDA_VIGILANTE);
        if en_uso() {
            continue;
        }
        let e = estado();
        if e.model_loaded {
            tracing::info!(modelo = %e.model, "maria-local: VRAM ocupada sin turno — descargando");
            descargar();
        }
    }
}

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

#[cfg(test)]
mod tests_vram {
    use super::*;

    #[test]
    fn el_contador_sube_y_baja_con_el_turno() {
        let base = TURNOS_ACTIVOS.load(Ordering::SeqCst);
        {
            let _t = EnUso::nuevo();
            assert_eq!(TURNOS_ACTIVOS.load(Ordering::SeqCst), base + 1);
            assert!(en_uso());
        }
        assert_eq!(TURNOS_ACTIVOS.load(Ordering::SeqCst), base);
    }

    #[test]
    fn dos_turnos_a_la_vez_no_se_pisan() {
        // Caso negativo: con un booleano, el primero en terminar descargaba el
        // modelo mientras el otro seguia usandolo.
        let base = TURNOS_ACTIVOS.load(Ordering::SeqCst);
        let a = EnUso::nuevo();
        let b = EnUso::nuevo();
        assert_eq!(TURNOS_ACTIVOS.load(Ordering::SeqCst), base + 2);
        drop(a);
        assert!(en_uso(), "al soltar uno de dos, sigue en uso");
        drop(b);
        assert_eq!(TURNOS_ACTIVOS.load(Ordering::SeqCst), base);
    }

    #[test]
    fn la_ronda_del_vigilante_es_corta_pero_no_absurda() {
        // Muy larga deja la VRAM pillada; muy corta machaca /api/ps sin motivo.
        assert!(RONDA_VIGILANTE.as_secs() >= 5 && RONDA_VIGILANTE.as_secs() <= 60);
    }
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
