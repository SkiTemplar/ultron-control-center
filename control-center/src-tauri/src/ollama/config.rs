// ULTRON Control Center — Ollama: persistencia del modelo elegido en la UI.
//
// `~/.ultron/cockpit/ollama/config.json` — mismo patron atomico
// (tmp + rename) que usa `ai_router::store::write_json` para
// `cockpit/ai-router/*.json`. Fichero minimo: solo el nombre del modelo
// elegido desde AI Router > Modelo local.
//
// La lectura (`read_configured_model`) nunca falla el arranque de ULTRON
// por un fichero ausente o corrupto: un `None` aqui simplemente hace que
// `toggle::model_name` caiga al siguiente nivel de precedencia (ver
// `toggle.rs`). Solo la escritura (`write_configured_model`, invocada
// desde el comando `ollama_set_model`) puede devolver `Err`.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct StoredConfig {
    model: String,
}

/// Ruta al fichero de config, SIN crear el directorio — para la lectura
/// (`read_configured_model`, llamada en cada `model_name()`, así que no
/// debe tener el efecto secundario de crear `cockpit/ollama/` en cada
/// arranque solo por preguntar si hay algo persistido).
fn config_path_readonly() -> Result<PathBuf, String> {
    Ok(crate::maria_root()?
        .join("cockpit")
        .join("ollama")
        .join("config.json"))
}

/// Parseo puro del contenido del fichero de config — separado de la
/// lectura en disco para poder testearlo sin tocar el sistema de
/// ficheros. `None` si el JSON es invalido, no trae `model`, o `model`
/// esta vacio tras recortar espacios.
fn parse_configured_model(body: &str) -> Option<String> {
    let parsed: StoredConfig = serde_json::from_str(body).ok()?;
    let trimmed = parsed.model.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Lee el modelo persistido por la UI. `None` si el fichero no existe,
/// esta vacio o no se puede parsear.
pub fn read_configured_model() -> Option<String> {
    let path = config_path_readonly().ok()?;
    let body = fs::read_to_string(&path).ok()?;
    parse_configured_model(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_configured_model_lee_el_campo_model() {
        assert_eq!(
            parse_configured_model(r#"{"model":"qwen2.5-coder:7b"}"#),
            Some("qwen2.5-coder:7b".to_string())
        );
    }

    #[test]
    fn parse_configured_model_recorta_espacios() {
        assert_eq!(
            parse_configured_model(r#"{"model":"  qwen2.5-coder:7b  "}"#),
            Some("qwen2.5-coder:7b".to_string())
        );
    }

    #[test]
    fn parse_configured_model_devuelve_none_con_campo_vacio() {
        assert_eq!(parse_configured_model(r#"{"model":"   "}"#), None);
    }

    /// Caso negativo: JSON invalido nunca debe entrar en pánico ni
    /// propagar un error que tumbe el arranque — solo "no hay nada
    /// persistido".
    #[test]
    fn parse_configured_model_devuelve_none_con_json_invalido() {
        assert_eq!(parse_configured_model("esto no es JSON"), None);
    }

    #[test]
    fn parse_configured_model_devuelve_none_sin_campo_model() {
        assert_eq!(parse_configured_model(r#"{}"#), None);
    }
}
