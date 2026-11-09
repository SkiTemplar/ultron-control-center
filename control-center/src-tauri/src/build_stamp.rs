// build_stamp.rs — sello de compilación que embebe build.rs (K1, 2026-10-23).
//
// `git_sha` solo identifica el código si el árbol estaba limpio al compilar.
// Antes, un `ultron-memory.exe` compilado con cambios sin commitear informaba
// `git_sha=<HEAD>` y pasaba por el binario de ese commit. `dirty` lo delata, y
// el check `versions` del doctor lo convierte en aviso.

use serde_json::{json, Value};

const RAW_SHA: Option<&str> = option_env!("ULTRON_GIT_SHA");
const RAW_DIRTY: Option<&str> = option_env!("ULTRON_GIT_DIRTY");

/// Sello legible en los bytes del `.exe` de la app; lo lee el check 23.6 del
/// medidor (`parseAppStamp` en `scripts/kirkardo/predicates-r3.mjs`). `dirty` es
/// el mismo valor que informa `ultron-memory version`. Usa `env!` porque
/// `concat!` no admite `option_env!`: `build.rs` emite siempre las dos variables.
pub const APP_STAMP: &str = concat!(
    "ULTRON_BUILD_STAMP:sha=",
    env!("ULTRON_GIT_SHA"),
    ";dirty=",
    env!("ULTRON_GIT_DIRTY"),
    ";"
);

/// Deja el sello en el log de arranque de la app. Es lo que lo mantiene en el
/// binario: `build_stamp` vive en la lib, y el enlazador descarta lo que el
/// ejecutable no referencia. También responde a qué commit corresponde un log.
pub fn log_app_stamp() {
    tracing::info!(stamp = APP_STAMP, "arranque de la app");
}

/// SHA corto y estado del árbol (`None` = desconocido, build sin git).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildStamp {
    pub git_sha: &'static str,
    pub dirty: Option<bool>,
}

/// Traduce el valor de `ULTRON_GIT_DIRTY`; cualquier otra cosa es desconocido.
pub fn parse_dirty(raw: Option<&str>) -> Option<bool> {
    match raw {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    }
}

/// Sello del binario en ejecución.
pub fn current() -> BuildStamp {
    BuildStamp {
        git_sha: RAW_SHA.unwrap_or("unknown"),
        dirty: parse_dirty(RAW_DIRTY),
    }
}

/// Respuesta de `<bin> version`. `dirty` es `null` si el build no tuvo git.
pub fn version_json(bin: &str, stamp: BuildStamp) -> Value {
    json!({
        "bin": bin,
        "pkg_version": env!("CARGO_PKG_VERSION"),
        "git_sha": stamp.git_sha,
        "dirty": stamp.dirty,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_dirty_solo_acepta_true_y_false() {
        assert_eq!(parse_dirty(Some("true")), Some(true));
        assert_eq!(parse_dirty(Some("false")), Some(false));
        // Caso negativo: valores raros o ausentes no se dan por limpios.
        assert_eq!(parse_dirty(Some("unknown")), None);
        assert_eq!(parse_dirty(Some("1")), None);
        assert_eq!(parse_dirty(None), None);
    }

    #[test]
    fn version_json_expone_dirty() {
        let sucio = BuildStamp {
            git_sha: "abc1234",
            dirty: Some(true),
        };
        let v = version_json("ultron-memory", sucio);
        assert_eq!(v["git_sha"], "abc1234");
        assert_eq!(v["dirty"], true);
        let limpio = version_json(
            "ultron-memory",
            BuildStamp {
                dirty: Some(false),
                ..sucio
            },
        );
        assert_eq!(limpio["dirty"], false);
        let sin_git = version_json(
            "ultron-memory",
            BuildStamp {
                dirty: None,
                ..sucio
            },
        );
        assert!(sin_git["dirty"].is_null());
    }

    #[test]
    fn app_stamp_declara_sha_y_dirty_como_el_sidecar() {
        let stamp = current();
        let dirty = match stamp.dirty {
            Some(true) => "true",
            Some(false) => "false",
            None => "unknown",
        };
        assert_eq!(
            APP_STAMP,
            format!("ULTRON_BUILD_STAMP:sha={};dirty={dirty};", stamp.git_sha)
        );
    }

    #[test]
    fn el_build_script_embebe_el_sello() {
        // build.rs siempre emite las dos variables (con "unknown" sin git).
        assert!(RAW_SHA.is_some(), "falta ULTRON_GIT_SHA");
        assert!(RAW_DIRTY.is_some(), "falta ULTRON_GIT_DIRTY");
    }
}
