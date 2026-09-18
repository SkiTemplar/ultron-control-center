// mar.ia — ventana del orbe y puente de estado de voz.
//
// El orbe es una ventana aparte (label `maria_orb`): pequena, sin marco,
// transparente, siempre encima y fuera de la barra de tareas. La ventana
// principal sigue siendo la aplicacion completa (memoria, skills, MCPs,
// conversaciones, terminales) y se abre con doble clic sobre el orbe.
//
// Por que una ventana y no una pestana: el orbe tiene que poder quedarse
// visible encima de lo que estes haciendo — es un asistente, no una pantalla
// a la que vas. Se sigue el mismo patron que `detach.rs`, la unica otra
// ventana dinamica del proyecto.

use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

/// Label de la ventana del orbe. Tiene que casar con el glob de
/// `capabilities/maria-orb.json`, o la webview se queda sin permisos.
pub const ORB_LABEL: &str = "maria_orb";

/// Tamano por defecto. Pequeno a proposito: cabe en una esquina.
const ORB_SIZE: f64 = 260.0;

#[derive(Debug, serde::Serialize)]
pub struct OrbResult {
    pub label: String,
    /// false cuando la ventana ya existia y solo se ha traido al frente.
    pub created: bool,
}

pub fn open_orb_inner(app: &AppHandle) -> Result<OrbResult, String> {
    if let Some(win) = app.get_webview_window(ORB_LABEL) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(OrbResult {
            label: ORB_LABEL.to_string(),
            created: false,
        });
    }

    WebviewWindowBuilder::new(app, ORB_LABEL, tauri::WebviewUrl::App("/orb".into()))
        .title("mar.ia")
        .inner_size(ORB_SIZE, ORB_SIZE)
        .resizable(false)
        // Sin marco y transparente: solo se ve el blob, no una caja.
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        // Fuera de la barra de tareas: la entrada de la app es la principal.
        .skip_taskbar(true)
        .visible(true)
        .build()
        .map_err(|e| format!("no pude crear la ventana del orbe: {e}"))?;

    Ok(OrbResult {
        label: ORB_LABEL.to_string(),
        created: true,
    })
}

/// Abre (o enfoca) el orbe.
#[tauri::command]
pub async fn maria_open_orb(app: AppHandle) -> Result<OrbResult, String> {
    open_orb_inner(&app)
}

/// Cierra el orbe. La ventana principal no se toca.
#[tauri::command]
pub async fn maria_close_orb(app: AppHandle) -> Result<bool, String> {
    match app.get_webview_window(ORB_LABEL) {
        Some(win) => {
            win.close()
                .map_err(|e| format!("no pude cerrar el orbe: {e}"))?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Trae la ventana principal al frente (doble clic en el orbe).
#[tauri::command]
pub async fn maria_open_main(app: AppHandle) -> Result<bool, String> {
    match app.get_webview_window("main") {
        Some(win) => {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Estado que el sidecar de voz publica en el orbe.
///
/// Se reenvia tal cual como evento `maria:voice`. El sidecar es un proceso
/// aparte (no puede invocar comandos Tauri), asi que entra por aqui: o bien
/// por esta orden desde el frontend, o por el puente HTTP local cuando exista.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VoicePayload {
    /// "idle" | "listening" | "thinking" | "speaking".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Nivel de microfono 0..1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amp: Option<f32>,
    /// Ultimo texto transcrito o hablado (subtitulo del orbe).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Emite el estado de voz a todas las ventanas.
#[tauri::command]
pub async fn maria_voice_state(app: AppHandle, payload: VoicePayload) -> Result<(), String> {
    app.emit("maria:voice", payload)
        .map_err(|e| format!("no pude emitir maria:voice: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_label_casa_con_el_glob_de_la_capability() {
        // capabilities/maria-orb.json declara windows: ["maria_orb"]. Si el
        // label cambia sin actualizar el fichero, la ventana arranca sin
        // permisos y el frontend falla en silencio.
        assert_eq!(ORB_LABEL, "maria_orb");
        let caps = include_str!("../capabilities/maria-orb.json");
        assert!(caps.contains(ORB_LABEL));
    }

    #[test]
    fn el_payload_de_voz_omite_lo_ausente() {
        let json = serde_json::to_string(&VoicePayload {
            state: Some("listening".into()),
            amp: None,
            text: None,
        })
        .expect("serializa");
        assert_eq!(json, r#"{"state":"listening"}"#);
    }
}
