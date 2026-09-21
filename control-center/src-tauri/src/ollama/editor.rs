// editor.rs — motor de autocompletado del editor, gobernado desde ULTRON.
//
// La extension `ollama-tab` de VS Code (plugins/vscode-ollama-tab) guarda el
// motor activo en `ollamaTab.engine`: `off`, `copilot`, `low`, `mid` o `high`.
// Es excluyente — al activar un motor local, Copilot se apaga escribiendo
// `github.copilot.editor.enableAutoCompletions`, y al reves.
//
// Aqui se lee y escribe ese estado para poder cambiarlo desde el Control
// Center sin abrir VS Code. VS Code recarga `settings.json` en caliente, asi
// que el cambio llega a una ventana ya abierta sin reiniciarla.
//
// Por que NO se parsea el fichero como JSON: `settings.json` es JSONC — admite
// comentarios y comas colgantes, que `serde_json` rechaza. Reescribirlo desde
// una estructura tambien borraria comentarios y formato del usuario. Por eso
// la edicion es quirurgica sobre el texto: se sustituye el valor de la clave
// concreta y el resto del fichero queda byte a byte igual.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const DEFAULT_ENGINE: &str = "low";
pub const ENGINE_KEY: &str = "ollamaTab.engine";
pub const COPILOT_KEY: &str = "github.copilot.editor.enableAutoCompletions";

const MODEL_KEYS: [(&str, &str); 3] = [
    ("ollamaTab.modelLow", "qwen2.5-coder:1.5b-base"),
    ("ollamaTab.modelMid", "qwen2.5-coder:3b-base"),
    ("ollamaTab.modelHigh", "qwen2.5-coder:7b-base"),
];

/// Motores validos. Cualquier otro valor en el fichero se trata como ausente:
/// mejor caer al defecto que propagar un motor que la extension no entiende.
pub const ENGINES: [&str; 5] = ["off", "copilot", "low", "mid", "high"];

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct EditorEngineStatus {
    /// false cuando no se encuentra el `settings.json` de VS Code: la UI lo
    /// dice en vez de fingir un estado.
    pub available: bool,
    pub engine: String,
    pub model_low: String,
    pub model_mid: String,
    pub model_high: String,
    /// Modelo del motor activo, o `None` si el motor no es local.
    pub active_model: Option<String>,
    pub settings_path: Option<String>,
}

pub fn settings_path() -> Option<PathBuf> {
    let base = dirs::config_dir()?; // %APPDATA% en Windows
    let path = base.join("Code").join("User").join("settings.json");
    path.exists().then_some(path)
}

/// Valor de una clave string de primer nivel, o None si no esta.
pub fn read_string_key(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = text.find(&needle)? + needle.len();
    let rest = &text[start..];
    let colon = rest.find(':')? + 1;
    let after = rest[colon..].trim_start();
    let quoted = after.strip_prefix('"')?;
    let end = quoted.find('"')?;
    Some(quoted[..end].to_string())
}

/// Motor declarado en el fichero, o el defecto si falta o no es valido.
pub fn read_engine(text: &str) -> String {
    match read_string_key(text, ENGINE_KEY) {
        Some(value) if ENGINES.contains(&value.as_str()) => value,
        _ => DEFAULT_ENGINE.to_string(),
    }
}

/// Sustituye el valor de una clave ya presente, o la inserta tras la primera
/// llave de apertura. `value_literal` entra tal cual: con comillas si es
/// string, sin ellas si es booleano o numero.
pub fn upsert_key(text: &str, key: &str, value_literal: &str) -> Result<String, String> {
    let needle = format!("\"{key}\"");
    if let Some(key_at) = text.find(&needle) {
        let after_key = key_at + needle.len();
        let colon_rel = text[after_key..]
            .find(':')
            .ok_or_else(|| format!("clave '{key}' sin ':' en settings.json"))?;
        let value_start = after_key + colon_rel + 1;
        // El valor termina en la coma o en la llave de cierre del objeto raiz.
        let value_end_rel = text[value_start..]
            .find([',', '\n'])
            .ok_or_else(|| format!("valor de '{key}' sin final reconocible"))?;
        let value_end = value_start + value_end_rel;
        let mut out = String::with_capacity(text.len() + value_literal.len());
        out.push_str(&text[..value_start]);
        out.push(' ');
        out.push_str(value_literal);
        out.push_str(&text[value_end..]);
        return Ok(out);
    }

    let brace = text
        .find('{')
        .ok_or_else(|| "settings.json no parece un objeto JSON".to_string())?;
    let mut out = String::with_capacity(text.len() + key.len() + value_literal.len() + 8);
    out.push_str(&text[..=brace]);
    out.push_str(&format!("\n  \"{key}\": {value_literal},"));
    out.push_str(&text[brace + 1..]);
    Ok(out)
}

/// Modelo que sirve las sugerencias con ese motor, y los que deben soltarse de
/// VRAM. Espejo de `resolveEngine` en la extension: si uno cambia, el otro
/// tambien.
pub fn plan_for(engine: &str, models: &[String; 3]) -> (Option<String>, Vec<String>) {
    let index = match engine {
        "low" => Some(0),
        "mid" => Some(1),
        "high" => Some(2),
        _ => None,
    };
    match index {
        Some(i) => (
            Some(models[i].clone()),
            models
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, m)| m.clone())
                .collect(),
        ),
        None => (None, models.to_vec()),
    }
}

fn models_from(text: &str) -> [String; 3] {
    let value = |i: usize| {
        let (key, fallback) = MODEL_KEYS[i];
        read_string_key(text, key).unwrap_or_else(|| fallback.to_string())
    };
    [value(0), value(1), value(2)]
}

/// Estado actual segun el `settings.json` de VS Code.
pub fn status() -> EditorEngineStatus {
    let Some(path) = settings_path() else {
        return EditorEngineStatus {
            available: false,
            engine: DEFAULT_ENGINE.to_string(),
            model_low: MODEL_KEYS[0].1.to_string(),
            model_mid: MODEL_KEYS[1].1.to_string(),
            model_high: MODEL_KEYS[2].1.to_string(),
            active_model: None,
            settings_path: None,
        };
    };
    let text = fs::read_to_string(&path).unwrap_or_default();
    let engine = read_engine(&text);
    let models = models_from(&text);
    let (active_model, _) = plan_for(&engine, &models);

    EditorEngineStatus {
        available: true,
        engine,
        model_low: models[0].clone(),
        model_mid: models[1].clone(),
        model_high: models[2].clone(),
        active_model,
        settings_path: Some(path.to_string_lossy().to_string()),
    }
}

/// Escribe el motor elegido en `settings.json` (con copia de seguridad previa)
/// y devuelve el plan de modelos: cual cargar y cuales soltar. No toca Ollama
/// — de eso se encarga el comando, que ya tiene el candado de ocupacion.
pub fn write_engine(engine: &str) -> Result<(Option<String>, Vec<String>), String> {
    if !ENGINES.contains(&engine) {
        return Err(format!("motor invalido: '{engine}'"));
    }
    let path =
        settings_path().ok_or_else(|| "no se encontro el settings.json de VS Code".to_string())?;
    let text = fs::read_to_string(&path).map_err(|e| format!("no se pudo leer {path:?}: {e}"))?;

    let copilot_on = engine == "copilot";
    let updated = upsert_key(&text, ENGINE_KEY, &format!("\"{engine}\""))?;
    let updated = upsert_key(
        &updated,
        COPILOT_KEY,
        if copilot_on { "true" } else { "false" },
    )?;

    // Copia de seguridad antes de tocar un fichero que no es nuestro.
    let backup = path.with_extension("json.ultron-bak");
    let _ = fs::write(&backup, &text);
    fs::write(&path, &updated).map_err(|e| format!("no se pudo escribir {path:?}: {e}"))?;

    Ok(plan_for(engine, &models_from(&updated)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
  // un comentario que no se debe perder
  "editor.fontSize": 14,
  "ollamaTab.engine": "low",
  "github.copilot.editor.enableAutoCompletions": true
}"#;

    #[test]
    fn reads_engine_and_falls_back_on_garbage() {
        assert_eq!(read_engine(SAMPLE), "low");
        assert_eq!(
            read_engine(r#"{"ollamaTab.engine": "turbo"}"#),
            DEFAULT_ENGINE
        );
        assert_eq!(read_engine("{}"), DEFAULT_ENGINE);
    }

    #[test]
    fn upsert_replaces_the_value_and_keeps_comments() {
        let out = upsert_key(SAMPLE, ENGINE_KEY, "\"high\"").unwrap();
        assert_eq!(read_engine(&out), "high");
        assert!(out.contains("// un comentario que no se debe perder"));
        assert!(out.contains("\"editor.fontSize\": 14"));
    }

    #[test]
    fn upsert_inserts_the_key_when_it_is_missing() {
        let out = upsert_key("{\n  \"editor.fontSize\": 14\n}", ENGINE_KEY, "\"mid\"").unwrap();
        assert_eq!(read_engine(&out), "mid");
        assert!(out.contains("\"editor.fontSize\": 14"));
    }

    #[test]
    fn upsert_rejects_text_that_is_not_an_object() {
        assert!(upsert_key("no soy json", ENGINE_KEY, "\"low\"").is_err());
    }

    #[test]
    fn plan_loads_one_model_and_unloads_the_rest() {
        let models = [
            "qwen:low".to_string(),
            "qwen:mid".to_string(),
            "qwen:high".to_string(),
        ];
        assert_eq!(
            plan_for("mid", &models),
            (
                Some("qwen:mid".to_string()),
                vec!["qwen:low".to_string(), "qwen:high".to_string()]
            )
        );
        assert_eq!(plan_for("copilot", &models), (None, models.to_vec()));
        assert_eq!(plan_for("off", &models), (None, models.to_vec()));
    }
}
