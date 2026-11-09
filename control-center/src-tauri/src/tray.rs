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
//   - separator
//   - Autocompletado: <motor> -> check item, ver abajo
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
// El item de autocompletado es un CheckMenuItem que refleja el motor del
// editor (`ollamaTab.engine`, ver `ollama::editor`): "Autocompletado: 3b
// local", "Autocompletado: Copilot" o "Autocompletado: apagado", marcado
// solo si el motor es local y su modelo esta cargado (`GET /api/ps`). Clic:
// motor local -> Copilot; Copilot o apagado -> ultimo motor local (por
// defecto mid). La decision y el texto son funciones puras de
// `ollama::engine` (`tray_next_engine`, `tray_view`), y el cambio usa la
// MISMA funcion que el comando `editor_engine_set` de AI Router
// (`engine::set_engine_blocking`, con el guard de concurrencia dentro): un
// clic en la bandeja y una accion desde la UI nunca corren a la vez, y si
// chocan el clic avisa con un toast en vez de perderse. Nunca se bloquea el
// hilo del menu con la llamada de red (la carga en frio puede tardar
// decenas de segundos).
//
// La decision sale SIEMPRE del estado real (settings.json + `/api/ps`),
// nunca de `item.is_checked()`: en Windows, `muda` invierte la marca del
// `CheckMenuItem` en su propio manejador ANTES de despachar el clic a
// `on_menu_event` (crate `muda` 0.19.1,
// `src/platform_impl/windows/mod.rs`, rama `MenuItemType::Check`), así que
// leerla aqui daria la accion contraria.

use serde_json::json;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

use crate::ollama::editor;
use crate::ollama::engine::{self, TrayView};
use crate::ollama::toggle::{self, OllamaState};

/// Item de autocompletado de la bandeja, registrado como estado de la app
/// para que el comando `editor_engine_set` pueda refrescarlo tras un cambio
/// hecho desde AI Router.
struct EngineTrayItem(CheckMenuItem<tauri::Wry>);

/// `set_text`/`set_checked`/`set_enabled` son seguros desde cualquier hilo —
/// Tauri los reenvia internamente al hilo principal.
fn apply_view(item: &CheckMenuItem<tauri::Wry>, view: &TrayView) {
    let _ = item.set_text(&view.label);
    let _ = item.set_checked(view.checked);
    let _ = item.set_enabled(view.enabled);
}

/// Vista actual: motor segun settings.json y, si es local, si su modelo
/// esta cargado. Bloqueante (consulta `/api/ps`).
fn current_view() -> TrayView {
    let status = editor::status();
    let loaded = status
        .active_model
        .as_deref()
        .is_some_and(|model| toggle::query_state(model) == OllamaState::Loaded);
    engine::tray_view(&status, loaded)
}

/// Re-sincroniza el item con el estado real. Bloqueante: llamar desde un
/// hilo de fondo. No hace nada si la bandeja no se llego a crear.
pub(crate) fn refresh_engine_item(app: &AppHandle) {
    if let Some(item) = app.try_state::<EngineTrayItem>() {
        apply_view(&item.0, &current_view());
    }
}

/// Maneja el clic sobre el item. Corre en un hilo de fondo (ver
/// `on_menu_event`). Si el cambio falla (incluido "otra accion en curso"),
/// se avisa con un toast en vez de callar el error (mandamiento 11).
fn handle_engine_click(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    apply_view(item, &TrayView::busy());
    if let Err(e) = engine::toggle_engine_blocking() {
        crate::toast_emit::record_alert_and_maybe_toast(app, "ollama_toggle", "warn", &e);
    }
    apply_view(item, &current_view());
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
    let open_i = MenuItem::with_id(app, "open", "Open ULTRON", true, None::<&str>)?;
    let sessions_i =
        MenuItem::with_id(app, "open_sesiones", "ULTRON Sessions", true, None::<&str>)?;
    let new_claude_i =
        MenuItem::with_id(app, "new_claude", "New Claude session", true, None::<&str>)?;
    let new_codex_i = MenuItem::with_id(app, "new_codex", "New Codex session", true, None::<&str>)?;
    let plans_i = MenuItem::with_id(app, "open_plans", "Open Plans", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    // Texto/marca provisionales: se resuelven contra el estado real justo
    // debajo, tras construir la bandeja (ver refresh en segundo plano).
    // Deshabilitado hasta el primer sondeo para no lanzar una accion sobre
    // un estado que todavia no se conoce.
    let ollama_i = CheckMenuItem::with_id(
        app,
        "ollama_toggle",
        "Autocompletado: comprobando…",
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
    app.manage(EngineTrayItem(ollama_i.clone()));

    let menu = Menu::with_items(
        app,
        &[
            &open_i,
            &sessions_i,
            &new_claude_i,
            &new_codex_i,
            &plans_i,
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
        .tooltip("ULTRON Control Center")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id.as_ref();
            match id {
                "open" => focus_main_window(app),
                "open_sesiones" => {
                    if let Err(e) = crate::sesiones::ventana::open(app, None) {
                        tracing::warn!(error = %e, "bandeja: no se pudo abrir ULTRON Sessions");
                    }
                }
                "quit" => {
                    // Los PTY mueren en RunEvent::Exit (lib.rs): matarlos aquí
                    // se saltaría el aviso de sesiones/proteccion.rs.
                    app.exit(0);
                }
                "ollama_toggle" => {
                    let item = ollama_i.clone();
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        handle_engine_click(&app_handle, &item);
                    });
                }
                "new_claude" | "new_codex" | "open_plans" => {
                    // Surface the window first so the user sees the
                    // response, then emit. Frontend listens on
                    // "tray-action" and routes to the existing flow
                    // (spawn_session for new_*, tab switch for plans).
                    focus_main_window(app);
                    let action = match id {
                        "new_claude" => "new_claude",
                        "new_codex" => "new_codex",
                        "open_plans" => "open_plans",
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

    // Sondeo inicial, en segundo plano para no retrasar el arranque con una
    // llamada de red. El item arranca deshabilitado ("comprobando…") y este
    // hilo lo deja listo en cuanto se conoce el estado real.
    tauri::async_runtime::spawn_blocking(move || {
        apply_view(&ollama_i_initial, &current_view());
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
