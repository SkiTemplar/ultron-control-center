// mar.ia — la respuesta segun se escribe, y poder pararla.
//
// Hasta el 2026-09-21 el relevo esperaba a que el proveedor TERMINARA para
// enseñar nada: una respuesta de 40 s eran 40 s mirando un "pensando". Aqui
// vive lo minimo para que el chat pinte el texto a medida que llega y para que
// el boton de parar mate de verdad al proceso:
//
//   * `fijar_app` — se llama una vez en el arranque con el AppHandle.
//   * `trozo` — emite `maria://relay-trozo` con el texto nuevo de un hilo.
//   * `cancelar` / `cancelado` — bandera por hilo que consultan los bucles de
//     lectura de `relay.rs`; al verla, matan al hijo o sueltan la conexion.
//
// Sin AppHandle (tests, sidecar, servidor del movil antes del arranque) todo
// esto es un no-op: el relevo funciona igual, solo que sin streaming.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();
static CANCELADOS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub const EVENTO_TROZO: &str = "maria://relay-trozo";

#[derive(Debug, Clone, Serialize)]
pub struct Trozo<'a> {
    pub thread_id: &'a str,
    pub provider: &'a str,
    /// Solo el texto NUEVO; la pantalla lo va sumando.
    pub texto: &'a str,
    /// true al cambiar de proveedor: la pantalla descarta lo acumulado, porque
    /// lo que venia a medias era de uno que al final no contesto.
    pub reinicia: bool,
}

pub fn fijar_app(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn trozo(thread_id: &str, provider: &str, texto: &str, reinicia: bool) {
    if texto.is_empty() && !reinicia {
        return;
    }
    if let Some(app) = APP.get() {
        let _ = app.emit(
            EVENTO_TROZO,
            Trozo {
                thread_id,
                provider,
                texto,
                reinicia,
            },
        );
    }
}

fn con_cancelados<R>(f: impl FnOnce(&mut HashSet<String>) -> R) -> R {
    let mut g = CANCELADOS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashSet::new))
}

/// Pide parar el turno en curso de ese hilo.
pub fn cancelar(thread_id: &str) {
    con_cancelados(|s| {
        s.insert(thread_id.to_string());
    });
}

/// ¿Se ha pedido parar este hilo?
#[must_use]
pub fn cancelado(thread_id: &str) -> bool {
    con_cancelados(|s| s.contains(thread_id))
}

/// Al empezar y al acabar un turno: la bandera no puede sobrevivirle.
pub fn limpiar(thread_id: &str) {
    con_cancelados(|s| {
        s.remove(thread_id);
    });
}

#[tauri::command]
pub async fn maria_relay_cancel(thread_id: String) -> Result<(), String> {
    cancelar(&thread_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_cancelacion_es_por_hilo_y_se_limpia() {
        limpiar("hilo-a");
        limpiar("hilo-b");
        cancelar("hilo-a");
        assert!(cancelado("hilo-a"));
        assert!(!cancelado("hilo-b"), "parar un hilo no para los demas");
        limpiar("hilo-a");
        assert!(!cancelado("hilo-a"));
    }

    #[test]
    fn sin_app_emitir_no_rompe() {
        trozo("hilo-x", "local", "hola", false);
    }
}
