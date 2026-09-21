// mar.ia — terminales embebidas.
//
// El usuario pidio (2026-09-18) que las CLIs de Claude, Codex y Gemini se
// lancen DENTRO de la aplicacion en vez de en consolas sueltas. Aqui viven los
// comandos que la pestana "Terminales" usa; el trabajo de verdad (abrir el
// PTY, leerlo y emitir `pty:data:<id>`) ya estaba hecho en `pty/`, solo estaba
// sin cablear a ninguna interfaz.
//
// Reparto: este modulo es una capa fina de validacion + traduccion de errores
// al castellano. Toda la logica de proceso vive en `pty/ops.rs`.

use base64::Engine;
use serde::Serialize;
use tauri::AppHandle;

/// Proveedores que la pestana puede abrir. Lista cerrada a proposito: el
/// nombre viaja desde el frontend hasta un `CommandBuilder`, y aceptar
/// cualquier cadena seria dejar que la interfaz ejecute lo que quiera.
const PERMITIDOS: &[&str] = &["claude", "codex", "antigravity", "powershell"];

#[derive(Debug, Serialize)]
pub struct TermInfo {
    pub id: String,
    pub provider: String,
    pub running: bool,
    /// Modelo con el que se abrio ("" = el que traiga la CLI por defecto).
    pub model: String,
}

/// Modelo con el que se abrio cada terminal, para poder enseñarlo en la
/// pestana. El PTY no lo guarda (es una sesion interactiva, no una llamada),
/// asi que se apunta aqui al abrirla.
static MODELOS: once_cell::sync::Lazy<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn apuntar_modelo(id: &str, modelo: &str) {
    if modelo.is_empty() {
        return;
    }
    if let Ok(mut m) = MODELOS.lock() {
        m.insert(id.to_string(), modelo.to_string());
    }
}

fn modelo_de(id: &str) -> String {
    MODELOS
        .lock()
        .ok()
        .and_then(|m| m.get(id).cloned())
        .unwrap_or_default()
}

/// ¿Es un proveedor de la lista blanca? Pura: se testea sin abrir nada.
#[must_use]
pub fn proveedor_permitido(p: &str) -> bool {
    PERMITIDOS.contains(&p.trim())
}

/// Carpeta de trabajo por defecto de una terminal nueva.
fn cwd_por_defecto() -> String {
    crate::maria::paths::home().to_string_lossy().to_string()
}

/// Abre una terminal y devuelve su id.
#[tauri::command]
pub async fn maria_term_open(
    app: AppHandle,
    provider: String,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    if !proveedor_permitido(&provider) {
        return Err(format!("proveedor no permitido: {provider}"));
    }
    // El modelo se valida contra el catalogo antes de acercarse a una linea de
    // comandos (mismo motivo que la lista blanca de proveedores).
    let modelo = model.map(|m| m.trim().to_string()).unwrap_or_default();
    if !crate::maria::models::modelo_valido(&provider, &modelo) {
        return Err(format!("{provider} no tiene el modelo {modelo}"));
    }
    let carpeta = cwd
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(cwd_por_defecto);
    let modelo_apuntar = modelo.clone();
    let extra = crate::maria::models::argumentos_interactivos(&provider, &modelo);
    // Bloqueante (sondeo de PATH + spawn) fuera del hilo async de Tauri.
    let id = tauri::async_runtime::spawn_blocking(move || {
        crate::pty::spawn_inner(
            app,
            "maria-term".to_string(),
            None,
            provider,
            None,
            carpeta,
            None,
            extra,
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;
    apuntar_modelo(&id, &modelo_apuntar);
    Ok(id)
}

/// Enciende la emision en vivo y devuelve (en base64) lo ya capturado.
#[tauri::command]
pub async fn maria_term_subscribe(id: String) -> Result<String, String> {
    crate::pty::subscribe_inner(&id)
}

/// Teclea en la terminal. `data` viaja en base64: lo que se escribe incluye
/// secuencias de escape y bytes que no son texto valido.
#[tauri::command]
pub async fn maria_term_write(id: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("datos ilegibles: {e}"))?;
    crate::pty::write_inner(&id, &bytes)
}

#[tauri::command]
pub async fn maria_term_resize(id: String, rows: u16, cols: u16) -> Result<(), String> {
    crate::pty::resize_inner(&id, rows, cols)
}

#[tauri::command]
pub async fn maria_term_kill(id: String) -> Result<(), String> {
    crate::pty::kill_inner(&id)
}

#[tauri::command]
pub async fn maria_term_list() -> Result<Vec<TermInfo>, String> {
    Ok(crate::pty::list_inner()
        .into_iter()
        .map(|(id, provider, running)| TermInfo {
            model: modelo_de(&id),
            id,
            provider,
            running,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acepta_los_proveedores_de_la_lista() {
        for p in ["claude", "codex", "antigravity", "powershell", " claude "] {
            assert!(proveedor_permitido(p), "deberia aceptar {p:?}");
        }
    }

    #[test]
    fn rechaza_cualquier_otra_cosa() {
        // Caso negativo: el nombre acaba en un CommandBuilder. Sin lista
        // blanca, la interfaz podria pedir que se ejecute lo que sea.
        for p in ["", "cmd", "powershell-admin", "rm -rf /", "claude; calc"] {
            assert!(!proveedor_permitido(p), "no deberia aceptar {p:?}");
        }
    }

    #[test]
    fn la_carpeta_por_defecto_no_va_vacia() {
        let c = cwd_por_defecto();
        assert!(!c.trim().is_empty());
    }
}
