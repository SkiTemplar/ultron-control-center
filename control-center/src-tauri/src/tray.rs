// ULTRON Control Center — System Tray
//
// Builds the tray icon with a quick-actions menu and wires up the
// left-click toggle. Window close-to-tray is handled here too so all
// tray behaviour lives in one place.
//
// Menu items (right-click):
//   - Open ULTRON        -> show + focus main window
//   - New Claude session -> emits "tray-action" {action:"new_claude"}
//   - New Codex session  -> emits "tray-action" {action:"new_codex"}
//   - Open Plans         -> emits "tray-action" {action:"open_plans"}
//   - Open Memory        -> emits "tray-action" {action:"open_memory"}
//   - separator
//   - Ollama (autocompletado) -> check item, ver abajo
//   - separator
//   - Quit               -> app.exit(0)
//
// The session/route items emit events instead of invoking commands
// directly because the frontend already has UI state and command
// wiring (provider pickers, default prompts, route history). Letting
// React handle the dispatch keeps a single source of truth and means
// the user sees the same UX whether they used the tray or the in-app
// button.
//
// El item "Ollama (autocompletado)" es un CheckMenuItem cuyo texto y
// marca reflejan el estado real del modelo local (consultado via
// `GET /api/ps`, ver `ollama::toggle`). Toda la logica de red vive en ese
// modulo; aqui solo se cablea: clic -> hilo de fondo -> refrescar el
// item. Nunca se bloquea el hilo del menu con la llamada de red (la carga
// en frio del modelo puede tardar decenas de segundos).
//
// El guard de concurrencia (`ollama::toggle::try_acquire_busy`) es el
// MISMO que usan los comandos Tauri de la seccion "Modelo local" en AI
// Router (`ollama::commands`): un clic en la bandeja y una accion desde
// la UI nunca corren a la vez.

use serde_json::json;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

/// Show + focus + unminimize the main window. Mirrors the helper in
/// `lib.rs` (kept private there) so the tray module is self-contained.
pub(crate) fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Toggle visibility of the main window. Hidden -> show+focus.
/// Visible -> hide (back to tray).
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    }
}

/// Initialise the system tray with the quick-actions menu and wire up
/// the close-to-tray behaviour on the main window.
///
/// Call from `tauri::Builder::default().setup(|app| { ... })` AFTER
/// the main window has been created (which happens during default
/// startup — by the time `setup` runs, `get_webview_window("main")`
/// resolves).
/// Pone en el menu el estado real del modelo local.
///
/// Se llama al construir la bandeja y cada vez que se libera. El texto dice lo
/// que hay, no lo que deberia haber: si el modelo esta cargado, cuanto ocupa.
fn refrescar_vram(item: &MenuItem<tauri::Wry>) {
    let e = crate::maria_local::estado();
    let (texto, activo) = if !e.installed {
        ("Modelo local: Ollama no instalado".to_string(), false)
    } else if !e.server_up {
        ("Modelo local: servidor caído".to_string(), false)
    } else if e.model_loaded {
        (format!("Liberar VRAM ({} cargado)", e.model), true)
    } else {
        ("VRAM libre".to_string(), false)
    };
    let _ = item.set_text(texto);
    let _ = item.set_enabled(activo);
}

pub fn init_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Menu items. Each gets a stable id so the menu event handler can
    // route by string match. Tauri 2 uses MenuItem::with_id; ids are
    // returned by event.id().as_ref().
    let open_i = MenuItem::with_id(app, "open", "Abrir mar.ia", true, None::<&str>)?;
    let chat_i = MenuItem::with_id(app, "open_chat", "Chat", true, None::<&str>)?;
    let term_i = MenuItem::with_id(app, "open_terminals", "Terminales", true, None::<&str>)?;
    let mosaico_i = MenuItem::with_id(app, "open_mosaic", "Mosaico", true, None::<&str>)?;
    let memory_i = MenuItem::with_id(app, "open_memory", "Memoria", true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "open_settings", "Ajustes", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    // Estado del modelo local. Texto provisional: se resuelve contra el estado
    // real justo despues de construir la bandeja.
    //
    // OJO con lo que ya NO esta: el interruptor "Ollama" CARGABA el modelo y lo
    // dejaba fijo en VRAM (`keep_alive: -1`), que es justo lo contrario de lo
    // que el usuario pidio el 2026-09-19 ("nunca debe estar en memoria todo el
    // rato"). En su sitio hay un boton que solo SUELTA.
    let vram_i = MenuItem::with_id(app, "liberar_vram", "Modelo: comprobando…", false, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    // Clon para el refresco de abajo: el original se mueve dentro del closure
    // de `on_menu_event` (por dentro es un Arc, asi que clonar es barato y los
    // dos apuntan al mismo item real).
    let vram_i_refresco = vram_i.clone();

    let menu = Menu::with_items(
        app,
        &[
            &open_i,
            &chat_i,
            &term_i,
            &mosaico_i,
            &memory_i,
            &settings_i,
            &sep,
            &vram_i,
            &sep2,
            &quit_i,
        ],
    )?;

    // Reuse the bundled window icon for the tray. `default_window_icon`
    // returns the 32x32 icon Tauri auto-picks for the platform. Using
    // it (instead of resolving a separate tray-icon.png from resources)
    // avoids needing additional resource permissions in capabilities
    // and keeps a consistent brand across taskbar and tray.
    let icon = app
        .default_window_icon()
        .ok_or("no default window icon available")?
        .clone();

    let _tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("mar.ia")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id.as_ref();
            match id {
                "open" => focus_main_window(app),
                "quit" => {
                    // El apagado completo ANTES de `exit`: asi se garantiza
                    // que la voz deja de sonar aunque Tauri tarde en bajar.
                    crate::maria_apagado::apagar();
                    app.exit(0);
                }
                "liberar_vram" => {
                    // Solo suelta. Nunca carga: el modelo entra en VRAM cuando
                    // se le pregunta algo, no desde un menu.
                    let item = vram_i.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        crate::maria_local::descargar();
                        refrescar_vram(&item);
                    });
                }
                "open_chat" | "open_terminals" | "open_mosaic" | "open_memory"
                | "open_settings" => {
                    // Surface the window first so the user sees the
                    // response, then emit. Frontend listens on
                    // "tray-action" and routes to the existing flow
                    // (spawn_session for new_*, tab switch for plans
                    // and memory).
                    focus_main_window(app);
                    let action = match id {
                        "open_chat" => "open_chat",
                        "open_terminals" => "open_terminals",
                        "open_mosaic" => "open_mosaic",
                        "open_memory" => "open_memory",
                        "open_settings" => "open_settings",
                        _ => return,
                    };
                    let _ = app.emit("tray-action", json!({ "action": action }));
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left click toggles. Right click is reserved for the menu
            // (which Tauri shows automatically because we did NOT set
            // show_menu_on_left_click(true)).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // Estado del modelo local, en segundo plano para no retrasar el arranque
    // con una llamada de red, y luego cada 15 s: el menu de la bandeja es lo
    // unico que se ve con la ventana minimizada, asi que tiene que decir la
    // verdad sin que nadie lo abra.
    tauri::async_runtime::spawn_blocking(move || loop {
        refrescar_vram(&vram_i_refresco);
        std::thread::sleep(std::time::Duration::from_secs(15));
    });

    // Close-to-tray: intercept the window close request and hide
    // instead. Quit from the tray menu remains the only path to a
    // real exit. Without prevent_close() the window would actually
    // destroy itself and we would lose state.
    if let Some(main) = app.get_webview_window("main") {
        let main_clone = main.clone();
        main.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = main_clone.hide();
                api.prevent_close();
            }
        });
    }

    Ok(())
}
