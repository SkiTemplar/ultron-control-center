// sesiones/foco_sesion.rs — Llevar al primer plano una sesión concreta.
//
// Lo usa la mascota: con un aviso de permiso pendiente, un clic en Pupus
// enfoca la ventana de Sessions que estaba señalando y pone esa sesión en
// el panel con foco (`sesiones://focus-session`, bootstrap.ts). Si no hay
// ninguna ventana de Sessions abierta, abre la principal con `?session=`.

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use super::registro::{self, WINDOW_LABEL};
use super::types::ev;
use super::ventana;

/// Ventana que se enfoca: la pedida (si existe y es de Sessions), si no la
/// principal y, si no, cualquier otra de Sessions. Pura.
pub fn elegir_ventana(pedida: Option<&str>, abiertas: &[String]) -> Option<String> {
    let es = |l: &str| abiertas.iter().any(|a| a == l) && registro::is_sessions_window(l);
    if let Some(p) = pedida.filter(|p| es(p)) {
        return Some(p.to_string());
    }
    if es(WINDOW_LABEL) {
        return Some(WINDOW_LABEL.to_string());
    }
    abiertas
        .iter()
        .find(|l| registro::is_sessions_window(l))
        .cloned()
}

fn enfocar(app: &AppHandle, label: &str, session_id: &str) -> Result<(), String> {
    let w = app
        .get_webview_window(label)
        .ok_or_else(|| format!("la ventana '{label}' ya no existe"))?;
    w.show()
        .map_err(|e| format!("no se pudo mostrar la ventana: {e}"))?;
    w.unminimize()
        .map_err(|e| format!("no se pudo restaurar la ventana: {e}"))?;
    w.set_focus()
        .map_err(|e| format!("no se pudo enfocar la ventana: {e}"))?;
    app.emit_to(label, ev::FOCUS_SESSION, json!({ "sessionId": session_id }))
        .map_err(|e| format!("no se pudo enviar el foco de sesión: {e}"))
}

/// `sesiones_focus_session`: enfoca la sesión en `window` (o en la mejor
/// ventana de Sessions abierta). Devuelve la etiqueta de la ventana.
#[tauri::command]
pub async fn sesiones_focus_session(
    app: AppHandle,
    session_id: String,
    window: Option<String>,
) -> Result<String, String> {
    if !registro::exists(&session_id) {
        return Err(format!("sesión desconocida: {session_id}"));
    }
    let abiertas: Vec<String> = app.webview_windows().into_keys().collect();
    match elegir_ventana(window.as_deref(), &abiertas) {
        Some(label) => enfocar(&app, &label, &session_id).map(|_| label),
        None => ventana::open_session(&app, &session_id).map(|_| WINDOW_LABEL.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(ls: &[&str]) -> Vec<String> {
        ls.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn prefiere_la_pedida_y_luego_la_principal() {
        let abiertas = labels(&["main", "sesiones", "sesiones-1a2b3c4d"]);
        assert_eq!(
            elegir_ventana(Some("sesiones-1a2b3c4d"), &abiertas).as_deref(),
            Some("sesiones-1a2b3c4d")
        );
        assert_eq!(elegir_ventana(None, &abiertas).as_deref(), Some("sesiones"));
        assert_eq!(
            elegir_ventana(Some("sesiones-cerrada"), &abiertas).as_deref(),
            Some("sesiones"),
            "una pedida que ya no existe no cuenta"
        );
    }

    #[test]
    fn sin_principal_vale_una_extra_y_nunca_otra_ventana() {
        let abiertas = labels(&["main", "mascot", "sesiones-9f9f9f9f"]);
        assert_eq!(
            elegir_ventana(Some("main"), &abiertas).as_deref(),
            Some("sesiones-9f9f9f9f"),
            "«main» no es de Sessions"
        );
        assert_eq!(elegir_ventana(None, &labels(&["main", "mascot"])), None);
        assert_eq!(elegir_ventana(None, &[]), None);
    }
}
