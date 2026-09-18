// mar.ia — puente de estado de voz hacia las ventanas.
//
// La ventana flotante del orbe se retiro el 2026-09-18: el orbe ES la pantalla
// principal (components/jarvis/MariaHome.tsx), asi que una ventanita aparte
// duplicaba la cara del asistente y obligaba a mantener dos caminos de
// arranque del microfono.

use tauri::{AppHandle, Emitter, Manager};

/// Deja mar.ia registrada para arrancar con Windows, UNA sola vez.
///
/// Se marca en `~/.ultron/.tmp/maria-autostart-done.txt` para no volver a
/// activarlo en cada arranque: si el usuario lo desactiva en Ajustes, la
/// decision es suya y aqui no se pisa.
///
/// Best-effort: un fallo del registro no puede impedir que la aplicacion abra.
pub fn ensure_autostart(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;

    let Some(marca) = dirs::home_dir()
        .map(|h| h.join(".ultron").join(".tmp").join("maria-autostart-done.txt"))
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

/// Trae la ventana principal al frente (bandeja, atajo, notificacion).
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

/// Estado que el sidecar de voz publica en la interfaz.
///
/// Se reenvia tal cual como evento `maria:voice`. El sidecar es un proceso
/// aparte (no puede invocar comandos Tauri), asi que entra por aqui.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VoicePayload {
    /// "idle" | "listening" | "thinking" | "speaking".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Nivel de microfono 0..1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amp: Option<f32>,
    /// Ultimo texto transcrito o hablado.
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
