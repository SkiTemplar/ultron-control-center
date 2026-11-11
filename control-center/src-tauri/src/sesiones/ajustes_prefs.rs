// sesiones/ajustes_prefs.rs — Preferencias de lanzamiento de las sesiones
// nuevas (`SessionPrefs`, §2.5-§2.6).
//
// Fuente única del modo de lanzamiento: el fichero de prefs. Su valor
// inicial se calcula **una vez**, al crearlo: `default` si
// `features.json:claude_safe_mode` es `true` y `bypassPermissions` en
// cualquier otro caso; después Sessions no vuelve a leer ese campo. El
// fichero vive fuera del repo, en los datos locales de la app.
//
// Propiedad: WP-ESTADO.

use std::path::{Path, PathBuf};

use super::{valid_session_model, EFFORTS};
use crate::sesiones::types::{PermissionMode, SessionPrefs};

const IDENTIFICADOR: &str = "io.github.skitemplar.ultron";

/// `%LOCALAPPDATA%/<identificador>/sesiones/prefs.json`.
pub fn ruta_prefs() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(IDENTIFICADOR).join("sesiones").join("prefs.json"))
}

/// Prefs del fichero `path`; si no existe, las crea a partir de
/// `safe_mode` (se evalúa solo en ese caso) y las escribe.
pub fn prefs_en(path: &Path, safe_mode: impl FnOnce() -> bool) -> SessionPrefs {
    if let Ok(texto) = std::fs::read_to_string(path) {
        match serde_json::from_str::<SessionPrefs>(&texto) {
            Ok(p) => return p,
            Err(e) => tracing::warn!(error = %e, "prefs de Sesiones ilegibles: se regeneran"),
        }
    }
    let p = SessionPrefs {
        launch_permission_mode: if safe_mode() {
            PermissionMode::Default
        } else {
            PermissionMode::BypassPermissions
        },
        ..SessionPrefs::default()
    };
    if let Err(e) = escribir(path, &p) {
        tracing::warn!(error = %e, "no se pudieron guardar las prefs iniciales de Sesiones");
    }
    p
}

/// Valida y guarda las prefs.
pub fn guardar_en(path: &Path, p: &SessionPrefs) -> Result<SessionPrefs, String> {
    if !(60..=600).contains(&p.stall_seconds) {
        return Err("el umbral de colgado va de 60 a 600 s".into());
    }
    if let Some(m) = p.launch_model.as_deref().filter(|m| !m.is_empty()) {
        if !valid_session_model(m) {
            return Err(format!("modelo no permitido: '{m}'"));
        }
    }
    if let Some(e) = p.launch_effort.as_deref().filter(|e| !e.is_empty()) {
        if !EFFORTS.contains(&e) {
            return Err(format!("effort no válido: '{e}'"));
        }
    }
    escribir(path, p)?;
    Ok(p.clone())
}

fn escribir(path: &Path, p: &SessionPrefs) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("no se pudo crear {}: {e}", dir.display()))?;
    }
    let texto = serde_json::to_string_pretty(p).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, texto).map_err(|e| format!("no se pudo escribir las prefs: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("no se pudo guardar las prefs: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn sin_fichero_el_modo_sale_de_safe_mode_una_sola_vez() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("a").join("prefs.json");
        assert_eq!(
            prefs_en(&p, || true).launch_permission_mode,
            PermissionMode::Default
        );
        let leido = Cell::new(false);
        let otra = prefs_en(&p, || {
            leido.set(true);
            false
        });
        assert_eq!(
            otra.launch_permission_mode,
            PermissionMode::Default,
            "fuente única"
        );
        assert!(!leido.get(), "con fichero ya escrito no se vuelve a leer");
        let q = dir.path().join("b.json");
        assert_eq!(
            prefs_en(&q, || false).launch_permission_mode,
            PermissionMode::BypassPermissions
        );
    }

    #[test]
    fn guardar_valida_umbral_modelo_y_effort() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("prefs.json");
        let mut prefs = SessionPrefs {
            stall_seconds: 30,
            ..SessionPrefs::default()
        };
        assert!(guardar_en(&p, &prefs).is_err());
        prefs.stall_seconds = 300;
        prefs.launch_model = Some("claude-opus-5".into());
        assert!(guardar_en(&p, &prefs).is_err());
        prefs.launch_model = Some("claude-opus-5-5".into());
        prefs.launch_effort = Some("max".into());
        assert_eq!(guardar_en(&p, &prefs).expect("ok").stall_seconds, 300);
        assert_eq!(prefs_en(&p, || true).launch_effort.as_deref(), Some("max"));
    }
}
