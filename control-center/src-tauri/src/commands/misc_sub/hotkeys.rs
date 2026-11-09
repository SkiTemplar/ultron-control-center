// Global hotkey runtime commands (main toggle get/set).
//
// Parsing helpers (`parse_hotkey`, `load_hotkey_spec`, `save_hotkey_spec`,
// `code_from_name`, `hotkey_config_path`) live in `crate::hotkeys` so both
// `lib.rs` setup() and these commands share one source of truth.
//
// Higiene 2026-08-12 (audit 08-09 #46, decidido por el usuario): los wrappers
// pause_global_hotkeys / resume_global_hotkeys se borraron — nunca registrados
// ni consumidos (el caso de uso "modal de captura de hotkey" no llego a
// cablearse). Git los conserva si algun dia hacen falta.

use crate::hotkeys;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[tauri::command]
pub async fn get_global_hotkey() -> Result<String, String> {
    Ok(hotkeys::load_hotkey_spec())
}

#[tauri::command]
pub async fn set_global_hotkey(app: tauri::AppHandle, spec: String) -> Result<String, String> {
    let new_shortcut = hotkeys::parse_hotkey(&spec)?;
    let previous = hotkeys::parse_hotkey(&hotkeys::load_hotkey_spec()).ok();
    let registro = RegistroTauri(app.global_shortcut());
    cambiar_atajo(&registro, previous, new_shortcut, || {
        hotkeys::save_hotkey_spec(&spec)
    })
    .map_err(|e| format!("'{spec}': {e}"))?;
    Ok(spec)
}

/// Registro de atajos globales. Separa la secuencia de `set_global_hotkey`
/// del plugin para poder probar los caminos de fallo.
trait RegistroAtajos {
    type Atajo: Clone;
    fn registrar(&self, atajo: Self::Atajo) -> Result<(), String>;
    fn desregistrar(&self, atajo: Self::Atajo) -> Result<(), String>;
}

struct RegistroTauri<'a>(&'a tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>);

impl RegistroAtajos for RegistroTauri<'_> {
    type Atajo = Shortcut;
    fn registrar(&self, atajo: Shortcut) -> Result<(), String> {
        self.0.register(atajo).map_err(|e| e.to_string())
    }
    fn desregistrar(&self, atajo: Shortcut) -> Result<(), String> {
        self.0.unregister(atajo).map_err(|e| e.to_string())
    }
}

/// Sustituye `previo` por `nuevo` y persiste el cambio con `guardar`.
///
/// Atómico desde fuera: si falla el registro del nuevo o el guardado, se
/// deshace lo hecho y vuelve a quedar registrado el anterior, para no dejar
/// al usuario sin atajo ni con uno registrado que no sobrevive al reinicio.
/// Un fallo del propio rollback no oculta el error original: se registra en
/// el log.
fn cambiar_atajo<R: RegistroAtajos>(
    registro: &R,
    previo: Option<R::Atajo>,
    nuevo: R::Atajo,
    guardar: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if let Some(p) = previo.clone() {
        // El anterior puede no estar registrado (otra app lo tenía al
        // arrancar): no impide el cambio, pero no se calla.
        if let Err(e) = registro.desregistrar(p) {
            tracing::warn!(error = %e, "[hotkeys] no se pudo desregistrar el atajo anterior");
        }
    }
    if let Err(e) = registro.registrar(nuevo.clone()) {
        restaurar_previo(registro, previo);
        return Err(format!("register failed: {e}"));
    }
    if let Err(e) = guardar() {
        if let Err(re) = registro.desregistrar(nuevo) {
            tracing::warn!(error = %re, "[hotkeys] rollback: no se pudo desregistrar el atajo nuevo");
        }
        restaurar_previo(registro, previo);
        return Err(format!("save failed, previous hotkey restored: {e}"));
    }
    Ok(())
}

fn restaurar_previo<R: RegistroAtajos>(registro: &R, previo: Option<R::Atajo>) {
    let Some(p) = previo else { return };
    if let Err(e) = registro.registrar(p) {
        tracing::warn!(error = %e, "[hotkeys] rollback: no se pudo volver a registrar el atajo anterior");
    }
}

#[cfg(test)]
#[path = "hotkeys_tests.rs"]
mod tests;
