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
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

use crate::ollama::toggle::{self, OllamaState};

/// Aplica `state` a la entrada de menu de Ollama: texto, marca de check y
/// si se puede pulsar (deshabilitada mientras `Loading` para no lanzar dos
/// acciones a la vez). `set_text`/`set_checked`/`set_enabled` son seguros
/// desde cualquier hilo — Tauri los reenvia internamente al hilo principal.
fn apply_ollama_state(item: &CheckMenuItem<tauri::Wry>, state: OllamaState, model: &str) {
    let _ = item.set_text(state.menu_label(model));
    let _ = item.set_checked(state.is_checked());
    let _ = item.set_enabled(!matches!(state, OllamaState::Loading));
}

/// Maneja el clic sobre la entrada de Ollama. Corre en un hilo de fondo
/// (ver `on_menu_event`): decide activar o desactivar segun el ESTADO
/// REAL (`toggle::query_state` contra `/api/ps`), NUNCA segun
/// `item.is_checked()` — en Windows, `muda` invierte la marca del
/// `CheckMenuItem` en su propio manejador ANTES de despachar el clic a
/// `on_menu_event` (ver el porque en el doc de
/// `toggle::action_for_state`), así que leerla aqui daria sistematicamente
/// la accion contraria. Muestra "cargando…" mientras dura, y al terminar
/// (con exito o no) refresca el item contra el estado real. Si la accion
/// falla, se avisa al usuario via toast en vez de callar el error
/// (mandamiento 11).
fn handle_ollama_click(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let model = toggle::model_name();
    let action = toggle::action_for_state(toggle::query_state(&model));

    apply_ollama_state(item, OllamaState::Loading, &model);

    let result = match action {
        toggle::ToggleAction::Deactivate => toggle::deactivate(&model),
        toggle::ToggleAction::Activate => toggle::activate(&model),
    };

    if let Err(e) = result {
        crate::toast_emit::record_alert_and_maybe_toast(app, "ollama_toggle", "warn", &e);
    }

    let state = toggle::query_state(&model);
    apply_ollama_state(item, state, &model);
}

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
pub fn init_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Menu items. Each gets a stable id so the menu event handler can
    // route by string match. Tauri 2 uses MenuItem::with_id; ids are
    // returned by event.id().as_ref().
    let open_i = MenuItem::with_id(app, "open", "Abrir mar.ia", true, None::<&str>)?;
    // mar.ia: el orbe es la cara del asistente y tiene que poder invocarse
    // sin abrir la aplicacion entera.
    let orb_i = MenuItem::with_id(app, "maria_orb", "mar.ia — orbe", true, None::<&str>)?;
    let new_claude_i =
        MenuItem::with_id(app, "new_claude", "New Claude session", true, None::<&str>)?;
    let new_codex_i = MenuItem::with_id(app, "new_codex", "New Codex session", true, None::<&str>)?;
    let plans_i = MenuItem::with_id(app, "open_plans", "Open Plans", true, None::<&str>)?;
    let memory_i = MenuItem::with_id(app, "open_memory", "Open Memory", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    // Texto/marca provisionales: se resuelven contra el estado real justo
    // debajo, tras construir la bandeja (ver refresh en segundo plano).
    // Deshabilitado hasta el primer sondeo para no lanzar una accion sobre
    // un estado que todavia no se conoce.
    let ollama_i = CheckMenuItem::with_id(
        app,
        "ollama_toggle",
        "Ollama: comprobando…",
        false,
        false,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    // Clon para el sondeo inicial de abajo: el original se mueve dentro
    // del closure de `on_menu_event` (los CheckMenuItem son un Arc por
    // dentro, así que clonar es barato y ambos apuntan al mismo item real).
    let ollama_i_initial = ollama_i.clone();

    let menu = Menu::with_items(
        app,
        &[
            &open_i,
            &orb_i,
            &new_claude_i,
            &new_codex_i,
            &plans_i,
            &memory_i,
            &sep,
            &ollama_i,
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
                    crate::pty::kill_all_inner();
                    app.exit(0);
                }
                "ollama_toggle" => {
                    // Serializa los clics contra el MISMO guard que usan los
                    // comandos de AI Router > Modelo local: un doble clic
                    // rápido, o un clic mientras la UI ya está activando el
                    // modelo, no lanza una segunda acción en paralelo.
                    let Some(guard) = toggle::try_acquire_busy() else {
                        return;
                    };
                    let item = ollama_i.clone();
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let _guard = guard; // liberado al terminar el cierre (Drop)
                        handle_ollama_click(&app_handle, &item);
                    });
                }
                "maria_orb" => {
                    if let Err(e) = crate::maria::open_orb_inner(app) {
                        crate::toast_emit::record_alert_and_maybe_toast(
                            app, "maria_orb", "warn", &e,
                        );
                    }
                }
                "new_claude" | "new_codex" | "open_plans" | "open_memory" => {
                    // Surface the window first so the user sees the
                    // response, then emit. Frontend listens on
                    // "tray-action" and routes to the existing flow
                    // (spawn_session for new_*, tab switch for plans
                    // and memory).
                    focus_main_window(app);
                    let action = match id {
                        "new_claude" => "new_claude",
                        "new_codex" => "new_codex",
                        "open_plans" => "open_plans",
                        "open_memory" => "open_memory",
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

    // Sondeo inicial del estado de Ollama, en segundo plano para no
    // retrasar el arranque de la app con una llamada de red. El item
    // arranca deshabilitado ("comprobando…") y este hilo lo deja listo
    // para usarse en cuanto `/api/ps` responde (o revela que Ollama no
    // esta disponible).
    tauri::async_runtime::spawn_blocking(move || {
        let model = toggle::model_name();
        let state = toggle::query_state(&model);
        // query_state nunca devuelve `Loading`: apply_ollama_state ya deja
        // el item habilitado.
        apply_ollama_state(&ollama_i_initial, state, &model);
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
