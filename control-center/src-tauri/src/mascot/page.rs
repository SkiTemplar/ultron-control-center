// Mascota — no enseñar la ventana hasta que la página está cargada.
//
// La ventana «mascot» cubre el área de trabajo entera. Mientras la webview
// navega, el documento aún lleva el fondo negro del CSS global de la app;
// si la ventana está visible en ese momento, el monitor entero parpadea en
// negro (al arrancar, al reactivar Pupus en Settings o si WebView2 recarga).
// Por eso la ventana se esconde al empezar cada navegación y solo se
// muestra cuando termina (la clase transparente se pone al evaluar el
// módulo, antes de que acabe la carga: mascotDocument.ts).
//
// Ojo: NO usar `background_color` en el builder. tao pinta WM_ERASEBKGND con
// `CreateSolidBrush(RGB(r, g, b))`, que ignora el alfa: Color(0, 0, 0, 0)
// pintaría el fondo de negro, justo lo contrario de lo que se busca.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, WebviewWindow};

use super::{screens, LABEL};

/// La página de la mascota ha terminado de cargar (y no ha vuelto a navegar).
static PAGE_READY: AtomicBool = AtomicBool::new(false);

/// Tiempo tras el que, si la página no ha cargado, se avisa en el log.
const LOAD_WARN_AFTER: Duration = Duration::from_secs(15);

/// ¿Se puede enseñar la ventana? Solo con la página cargada y sin que nadie
/// (Ctrl+Alt+P, pantalla completa) la haya escondido.
pub fn may_show(page_ready: bool, hidden: bool) -> bool {
    page_ready && !hidden
}

pub fn is_page_ready() -> bool {
    PAGE_READY.load(Ordering::SeqCst)
}

/// La ventana se ha creado de cero: su página aún no ha cargado.
pub fn mark_created(app: &AppHandle) {
    PAGE_READY.store(false, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(LOAD_WARN_AFTER);
        if !is_page_ready() && app.get_webview_window(LABEL).is_some() {
            tracing::warn!("mascota: la página no ha terminado de cargar; la ventana sigue oculta");
        }
    });
}

/// Muestra la ventana si procede; si no, no hace nada. Nunca le quita el foco
/// a lo que estés usando: tao solo enseña sin activar la primera vez
/// (`MARKER_DONT_FOCUS`, de un solo uso) y luego hace `ShowWindow(SW_SHOW)`, que
/// activa una ventana oculta. Pupus se esconde y reaparece solo (pantalla
/// completa, captura del MCP), así que antes se enseña sin activar; el `show`
/// de después solo pone al día el estado de tao, porque `SW_SHOW` sobre una
/// ventana ya visible no hace nada. Sin él, el `hide` siguiente de tao no
/// vería cambio y la ventana no se escondería.
pub fn show_if_allowed(window: &WebviewWindow) -> Result<(), String> {
    if may_show(is_page_ready(), screens::is_hidden()) {
        super::win::show_no_activate(super::hwnd_of(window));
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Manejador de `on_page_load` del builder de la ventana.
pub fn on_page_load(window: WebviewWindow, payload: PageLoadPayload<'_>) {
    match payload.event() {
        PageLoadEvent::Started => {
            PAGE_READY.store(false, Ordering::SeqCst);
            let _ = window.hide();
        }
        PageLoadEvent::Finished => {
            PAGE_READY.store(true, Ordering::SeqCst);
            if let Err(e) = show_if_allowed(&window) {
                tracing::warn!(error = %e, "mascota: no se pudo mostrar la ventana");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solo_se_ensena_con_la_pagina_cargada_y_sin_esconder() {
        assert!(may_show(true, false));
        assert!(!may_show(false, false), "página a medias: fondo negro");
        assert!(
            !may_show(true, true),
            "escondida a mano o por pantalla completa"
        );
        assert!(!may_show(false, true));
    }
}
