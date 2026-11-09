// ULTRON Control Center — Ollama: persistencia del ultimo motor local.
//
// `~/.ultron/cockpit/ollama/config.json` — mismo patron atomico
// (tmp + rename) que usa `ai_router::store::write_json` para
// `cockpit/ai-router/*.json`. Fichero minimo: solo `lastLocalEngine`
// (`low` | `mid` | `high`), el ultimo motor local elegido para el
// autocompletado del editor. Sirve para volver a el desde Copilot u
// "apagado" (bandeja) y para saber que modelo local es el de referencia
// cuando el motor activo no es local (estado y benchmark de AI Router).
//
// La lectura (`read_last_local_engine`) nunca falla el arranque de ULTRON:
// fichero ausente, JSON corrupto, el campo legado `model` (del selector de
// modelo retirado) o un valor que no es un motor local devuelven `None`, y
// el llamador cae a `editor::DEFAULT_LOCAL_ENGINE`. Solo la escritura
// (`write_last_local_engine`, invocada al elegir un motor local) puede
// devolver `Err`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::editor;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    #[serde(default)]
    last_local_engine: Option<String>,
}

/// Ruta al fichero de config, SIN crear el directorio — para la lectura,
/// que se hace en cada sondeo de estado y no debe crear `cockpit/ollama/`
/// solo por preguntar.
fn config_path_readonly() -> Result<PathBuf, String> {
    Ok(crate::ultron_root()?
        .join("cockpit")
        .join("ollama")
        .join("config.json"))
}

/// Ruta al fichero de config, creando el directorio si hace falta — solo
/// para la escritura.
fn config_path_for_write() -> Result<PathBuf, String> {
    let dir = crate::ultron_root()?.join("cockpit").join("ollama");
    fs::create_dir_all(&dir).map_err(|e| format!("crear {}: {e}", dir.display()))?;
    Ok(dir.join("config.json"))
}

/// Parseo puro del contenido del fichero. `None` si el JSON es invalido, no
/// trae `lastLocalEngine` o su valor no es un motor local.
fn parse_last_local_engine(body: &str) -> Option<&'static str> {
    let parsed: StoredConfig = serde_json::from_str(body).ok()?;
    editor::as_local_engine(parsed.last_local_engine?.trim())
}

fn read_last_local_engine_at(path: &Path) -> Option<&'static str> {
    let body = fs::read_to_string(path).ok()?;
    parse_last_local_engine(&body)
}

fn write_last_local_engine_at(path: &Path, engine: &str) -> Result<(), String> {
    let local = editor::as_local_engine(engine)
        .ok_or_else(|| format!("'{engine}' no es un motor local (low, mid o high)"))?;
    let body = serde_json::to_vec_pretty(&StoredConfig {
        last_local_engine: Some(local.to_string()),
    })
    .map_err(|e| format!("serializar config de ollama: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &body).map_err(|e| format!("escribir {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("renombrar a {}: {e}", path.display()))?;
    Ok(())
}

/// Ultimo motor local persistido, o `None` si no hay nada valido guardado.
pub fn read_last_local_engine() -> Option<&'static str> {
    read_last_local_engine_at(&config_path_readonly().ok()?)
}

/// Persiste `engine` como ultimo motor local. Rechaza `copilot`, `off` y
/// cualquier otro valor: solo los motores locales tienen sentido aqui.
pub fn write_last_local_engine(engine: &str) -> Result<(), String> {
    write_last_local_engine_at(&config_path_for_write()?, engine)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lee_last_local_engine() {
        assert_eq!(
            parse_last_local_engine(r#"{"lastLocalEngine":"high"}"#),
            Some("high")
        );
        assert_eq!(
            parse_last_local_engine(r#"{"lastLocalEngine":"  low  "}"#),
            Some("low")
        );
    }

    /// Caso negativo: JSON invalido nunca debe propagar un error que tumbe
    /// el arranque — solo "no hay nada persistido".
    #[test]
    fn parse_devuelve_none_con_json_corrupto() {
        assert_eq!(parse_last_local_engine("esto no es JSON"), None);
        assert_eq!(parse_last_local_engine(r#"{"lastLocalEngine":"#), None);
    }

    /// El fichero que dejaba el selector de modelo retirado solo trae
    /// `model`: se ignora, no se interpreta como motor.
    #[test]
    fn parse_ignora_el_campo_legado_model() {
        assert_eq!(
            parse_last_local_engine(r#"{"model":"qwen2.5-coder:7b"}"#),
            None
        );
    }

    #[test]
    fn parse_rechaza_motores_no_locales() {
        for value in ["copilot", "off", "turbo", ""] {
            let body = format!(r#"{{"lastLocalEngine":"{value}"}}"#);
            assert_eq!(parse_last_local_engine(&body), None, "{value}");
        }
    }

    #[test]
    fn escribe_y_relee_el_ultimo_motor_local() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.json");
        assert_eq!(read_last_local_engine_at(&path), None, "fichero ausente");

        write_last_local_engine_at(&path, "mid").expect("escribir mid");
        assert_eq!(read_last_local_engine_at(&path), Some("mid"));

        write_last_local_engine_at(&path, "high").expect("escribir high");
        assert_eq!(read_last_local_engine_at(&path), Some("high"));
        assert!(
            !path.with_extension("json.tmp").exists(),
            "la escritura atomica no debe dejar el temporal"
        );
    }

    /// La escritura sobre un fichero legado lo sustituye por el formato
    /// nuevo sin arrastrar `model`.
    #[test]
    fn escribir_sobre_fichero_legado_lo_migra() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.json");
        fs::write(&path, r#"{"model":"qwen2.5-coder:7b"}"#).expect("legado");
        write_last_local_engine_at(&path, "low").expect("escribir low");
        let body = fs::read_to_string(&path).expect("leer");
        assert!(!body.contains("\"model\""));
        assert_eq!(read_last_local_engine_at(&path), Some("low"));
    }

    /// Caso negativo: `copilot`/`off` no son motores locales; la escritura
    /// falla y no crea el fichero.
    #[test]
    fn escribir_rechaza_motores_no_locales() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.json");
        assert!(write_last_local_engine_at(&path, "copilot").is_err());
        assert!(write_last_local_engine_at(&path, "off").is_err());
        assert!(!path.exists());
    }
}
