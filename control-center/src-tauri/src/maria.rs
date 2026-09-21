// mar.ia — puente de estado de voz hacia las ventanas.
//
// La ventana flotante del orbe se retiro el 2026-09-18: el orbe ES la pantalla
// principal (components/jarvis/MariaHome.tsx), asi que una ventanita aparte
// duplicaba la cara del asistente y obligaba a mantener dos caminos de
// arranque del microfono.

use tauri::AppHandle;

/// Deja mar.ia registrada para arrancar con Windows, UNA sola vez.
///
/// Se marca en `<raiz>/.tmp/maria-autostart-done.txt` para no volver a
/// activarlo en cada arranque: si el usuario lo desactiva en Ajustes, la
/// decision es suya y aqui no se pisa.
///
/// Best-effort: un fallo del registro no puede impedir que la aplicacion abra.
pub fn ensure_autostart(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;

    let Some(marca) = dirs::home_dir()
        .map(|_| crate::maria_paths::home().join(".tmp").join("maria-autostart-done.txt"))
    else {
        return;
    };
    if marca.exists() {
        return;
    }
    let launcher = app.autolaunch();
    match launcher.enable() {
        Ok(()) => {
            if let Some(dir) = marca.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&marca, "1");
            tracing::info!("mar.ia registrada para arrancar con Windows");
        }
        Err(e) => tracing::warn!(error = %e, "no pude registrar el arranque automatico"),
    }
}
