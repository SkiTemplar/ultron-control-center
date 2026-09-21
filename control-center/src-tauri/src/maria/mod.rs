// mar.ia — puente de estado de voz hacia las ventanas.
//
// La ventana flotante del orbe se retiro el 2026-09-18: el orbe ES la pantalla
// principal (components/jarvis/MariaHome.tsx), asi que una ventanita aparte
// duplicaba la cara del asistente y obligaba a mantener dos caminos de
// arranque del microfono.

pub(crate) mod adjuntos; // mar.ia: ficheros arrastrados o pegados en el chat
pub(crate) mod apagado;
pub(crate) mod arranque; // mar.ia: arrancar con Windows, y por que no arranca
pub(crate) mod artefactos; // mar.ia: paginas y SVG que la IA genera, funcionando en un panel
pub(crate) mod capacidades; // mar.ia: skills y MCP compartidos entre proveedores
pub(crate) mod cli; // mar.ia: invocar claude, codex y antigravity de la misma manera // mar.ia: cerrar de verdad (quien para a quien)
pub(crate) mod criterio; // mar.ia: los parametros con los que la IA local decide
pub(crate) mod cuentas;
pub(crate) mod encargos; // mar.ia: varios agentes a la vez sobre una carpeta y un tablero comunes
pub(crate) mod enrutado; // mar.ia: decidir destino sin modelo y enfriar a quien no tiene cuota
pub(crate) mod flujo; // mar.ia: respuesta en streaming y boton de parar // mar.ia: que cuentas y claves hay conectadas, y a que correo
pub(crate) mod local;
pub(crate) mod local_agente; // mar.ia: el modelo local con herramientas // mar.ia: el modelo local disponible, sin ocupar VRAM
pub(crate) mod login; // mar.ia: como se entra en cada proveedor y si ya se entro
pub(crate) mod models; // mar.ia: catalogo de modelos y esfuerzo por proveedor
pub(crate) mod paths; // mar.ia: donde vive todo (.maria, con .ultron heredado)
pub(crate) mod perfiles; // mar.ia: varias cuentas por proveedor y cambiar entre ellas
pub(crate) mod quota; // mar.ia: consumo real por ventana movil
pub(crate) mod relay; // mar.ia: relevo de proveedores sobre un unico hilo
pub(crate) mod sysinfo; // mar.ia: consumo real por ventana movil
pub(crate) mod tailscale; // mar.ia: por que la direccion .ts.net da 404
pub(crate) mod teclado; // mar.ia: autocompletado global con `//maria`
pub(crate) mod term; // mar.ia: terminales embebidas (claude/codex/gemini/powershell)
pub(crate) mod threads; // mar.ia: indice de conversaciones (titulo, carpeta, fijado)
pub(crate) mod tools; // mar.ia: ejecucion real de las herramientas que pide la voz
pub(crate) mod voice; // mar.ia: supervisor del sidecar de voz (stdin/stdout JSON)
pub(crate) mod web; // mar.ia: webapp del movil (servidor local + avisos por ntfy)

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

    let Some(marca) = dirs::home_dir().map(|_| {
        crate::maria::paths::home()
            .join(".tmp")
            .join("maria-autostart-done.txt")
    }) else {
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
