// sesiones/ruta_fichero.rs — Ruta real en disco de un `File` del DOM.
//
// El navegador no expone la ruta de un fichero soltado, elegido o pegado, y el
// manejador de arrastre de Tauri no se puede activar en Sessions porque anularía
// el arrastre HTML de las pestañas. WebView2 sí la entrega al host: la página
// llama a `chrome.webview.postMessageWithAdditionalObjects("ultronFilePath:<id>",
// [file])` y aquí se lee `ICoreWebView2File::Path`.
//
// El mensaje tiene que ser una cadena: con un objeto, el manejador de IPC de wry
// devuelve error y WebView2 ya no llama a este (comprobado en vivo). La cadena
// llega también al IPC de Tauri, que no la reconoce y deja un `console.error`
// inofensivo por adjunto. La página solo obtiene rutas de `File` que ya tiene, es
// decir, de ficheros que el usuario eligió; no se accede al disco. Solo se
// responde al origen de la propia app.

use serde_json::{json, Value};

const CLAVE_PETICION: &str = "ultronFilePath";
const PREFIJO_PETICION: &str = "ultronFilePath:";
const ID_MAX_CHARS: usize = 64;

/// Identificador de la petición, si `mensaje` (cadena JSON) es una petición de ruta.
fn id_de_peticion(mensaje: &str) -> Option<String> {
    let value: Value = serde_json::from_str(mensaje).ok()?;
    let id = value.as_str()?.strip_prefix(PREFIJO_PETICION)?;
    (!id.is_empty() && id.chars().count() <= ID_MAX_CHARS).then(|| id.to_string())
}

/// JSON de respuesta; `path` es null si el origen no es el de la app o no hay ruta.
fn respuesta(id: &str, path: Option<&str>) -> String {
    json!({ CLAVE_PETICION: id, "path": path }).to_string()
}

#[cfg(windows)]
fn ruta_del_primer_fichero(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs2,
) -> windows::core::Result<Option<String>> {
    use webview2_com::take_pwstr;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2File;
    use windows::core::{Interface, PWSTR};

    // SAFETY: `args` es válido durante el evento; `path` lo libera `take_pwstr`.
    unsafe {
        let objects = args.AdditionalObjects()?;
        let mut count = 0u32;
        objects.Count(&mut count)?;
        if count == 0 {
            return Ok(None);
        }
        let Ok(file) = objects.GetValueAtIndex(0)?.cast::<ICoreWebView2File>() else {
            return Ok(None);
        };
        let mut path = PWSTR::null();
        file.Path(&mut path)?;
        let path = take_pwstr(path);
        Ok((!path.is_empty()).then_some(path))
    }
}

/// Registra el manejador en una ventana de Sessions.
#[cfg(windows)]
pub fn registrar(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs2;
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows::core::{Interface, HSTRING, PWSTR};

    // SAFETY: llamadas COM sobre interfaces vivas, en el hilo de la UI.
    let core = unsafe { controller.CoreWebView2()? };
    let handler = WebMessageReceivedEventHandler::create(Box::new(|sender, args| {
        let (Some(sender), Some(args)) = (sender, args) else {
            return Ok(());
        };
        let mut mensaje = PWSTR::null();
        let mut origen = PWSTR::null();
        // SAFETY: `args` es válido durante el evento; las cadenas las libera `take_pwstr`.
        unsafe {
            args.WebMessageAsJson(&mut mensaje)?;
            args.Source(&mut origen)?;
        }
        let (mensaje, origen) = (take_pwstr(mensaje), take_pwstr(origen));
        let Some(id) = id_de_peticion(&mensaje) else {
            return Ok(());
        };
        let path = if super::ventana::es_origen_de_app(&origen) {
            args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()
                .and_then(|a| ruta_del_primer_fichero(&a))
                .unwrap_or_else(|e| {
                    tracing::warn!(error = %e, "WebView2 no dio la ruta del fichero adjunto");
                    None
                })
        } else {
            None
        };
        let reply = HSTRING::from(respuesta(&id, path.as_deref()));
        // SAFETY: `reply` vive durante la llamada.
        unsafe { sender.PostWebMessageAsJson(&reply) }
    }));
    let mut token = 0i64;
    // SAFETY: `handler` y `token` viven durante la llamada.
    unsafe { core.add_WebMessageReceived(&handler, &mut token) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconoce_solo_peticiones_de_ruta() {
        assert_eq!(
            id_de_peticion(r#""ultronFilePath:f1""#).as_deref(),
            Some("f1")
        );
        // Lo que manda el IPC de Tauri es una cadena JSON sin el prefijo.
        assert_eq!(id_de_peticion(r#""{\"cmd\":\"x\"}""#), None);
        assert_eq!(id_de_peticion(r#"{"ultronFilePath":"f1"}"#), None);
        assert_eq!(id_de_peticion(r#""ultronFilePath:""#), None);
        assert_eq!(id_de_peticion("no es json"), None);
        let largo = format!(r#""ultronFilePath:{}""#, "x".repeat(ID_MAX_CHARS + 1));
        assert_eq!(id_de_peticion(&largo), None);
    }

    #[test]
    fn la_respuesta_escapa_la_ruta_y_admite_la_ausencia() {
        let con_ruta: Value =
            serde_json::from_str(&respuesta("f1", Some(r#"C:\a b\c.zip"#))).expect("json");
        assert_eq!(con_ruta["ultronFilePath"], "f1");
        assert_eq!(con_ruta["path"], r"C:\a b\c.zip");
        let sin_ruta: Value = serde_json::from_str(&respuesta("f2", None)).expect("json");
        assert!(sin_ruta["path"].is_null());
    }
}
