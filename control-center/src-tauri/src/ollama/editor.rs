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
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_ENGINE: &str = "low";
pub const ENGINE_KEY: &str = "ollamaTab.engine";
pub const COPILOT_KEY: &str = "github.copilot.editor.enableAutoCompletions";
/// Plazo de residencia explicito; vacio o ausente = segun el motor.
pub const KEEP_ALIVE_KEY: &str = "ollamaTab.keepAlive";

/// Plazo que Ollama mantiene el modelo en VRAM tras la ultima peticion, segun
/// el motor. Corto a proposito: los modelos locales no conviven con Unreal ni
/// Blender, asi que deben soltar la VRAM poco despues de dejar de usarse.
/// `high` aguanta mas porque su carga en frio es la mas cara. Espejo de
/// `keepAliveFor` en `plugins/vscode-ollama-tab/src/logic.ts`.
pub fn keep_alive_for(engine: &str) -> &'static str {
    if engine == "high" {
        "10m"
    } else {
        "5m"
    }
}

/// `keep_alive_for`, salvo que `ollamaTab.keepAlive` traiga un valor
/// explicito no vacio.
pub fn resolve_keep_alive(engine: &str, explicit: Option<&str>) -> String {
    explicit
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| keep_alive_for(engine).to_string())
}

/// `keep_alive` como lo espera la API de Ollama: un entero (`0`, `-1`,
/// segundos) va como numero; una duracion (`5m`, `1h`) como cadena.
pub fn keep_alive_json(value: &str) -> serde_json::Value {
    match value.trim().parse::<i64>() {
        Ok(n) => serde_json::Value::from(n),
        Err(_) => serde_json::Value::from(value.trim()),
    }
}

const MODEL_KEYS: [(&str, &str); 3] = [
    ("ollamaTab.modelLow", "qwen2.5-coder:1.5b-base"),
    ("ollamaTab.modelMid", "qwen2.5-coder:3b-base"),
    ("ollamaTab.modelHigh", "qwen2.5-coder:7b-base"),
];

/// Motores validos. Cualquier otro valor en el fichero se trata como ausente:
/// mejor caer al defecto que propagar un motor que la extension no entiende.
pub const ENGINES: [&str; 5] = ["off", "copilot", "low", "mid", "high"];

/// Motores que sirven las sugerencias con un modelo de Ollama, en el mismo
/// orden que `MODEL_KEYS`.
pub const LOCAL_ENGINES: [&str; 3] = ["low", "mid", "high"];

/// Motor local al que se vuelve cuando no hay ninguno persistido.
pub const DEFAULT_LOCAL_ENGINE: &str = "mid";

/// `Some` con la constante `'static` si `engine` es un motor local.
pub fn as_local_engine(engine: &str) -> Option<&'static str> {
    LOCAL_ENGINES.iter().copied().find(|local| *local == engine)
}

pub fn is_local_engine(engine: &str) -> bool {
    as_local_engine(engine).is_some()
}

/// Motor local de referencia: el activo si es local; si no (Copilot o
/// apagado), el ultimo local persistido; si tampoco lo hay, el defecto.
pub fn reference_local_engine(engine: &str, last_local: Option<&str>) -> &'static str {
    as_local_engine(engine)
        .or_else(|| last_local.and_then(as_local_engine))
        .unwrap_or(DEFAULT_LOCAL_ENGINE)
}

/// Tamano legible de un modelo a partir de su nombre:
/// `qwen2.5-coder:3b-base` -> `3b`. Busca primero en el tag y despues en el
/// nombre base un trozo con forma `<numero>[.<numero>]b|m`; si no lo hay,
/// devuelve el tag (o el nombre entero si no tiene tag). Espejo de
/// `modelSizeLabel` en `src/components/AIRouter/ollamaEngine.ts`.
pub fn model_size_label(model: &str) -> String {
    let (base, tag) = match model.rsplit_once(':') {
        Some((base, tag)) if !tag.is_empty() => (base, tag),
        _ => (model, model),
    };
    let is_size = |token: &&str| {
        let lower = token.to_ascii_lowercase();
        let Some(number) = lower.strip_suffix('b').or_else(|| lower.strip_suffix('m')) else {
            return false;
        };
        let mut parts = number.split('.');
        let whole = parts.next().unwrap_or("");
        let frac = parts.next();
        let is_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        parts.next().is_none() && is_digits(whole) && frac.is_none_or(is_digits)
    };
    let split = |s: &str| -> Option<String> {
        s.split(['-', '_', '/'])
            .find(is_size)
            .map(str::to_ascii_lowercase)
    };
    split(tag)
        .or_else(|| split(base))
        .unwrap_or_else(|| tag.to_string())
}

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
    /// `ollamaTab.keepAlive` si es explicito y no vacio.
    pub keep_alive_override: Option<String>,
}

impl EditorEngineStatus {
    /// Plazo de residencia para `engine` (ver `resolve_keep_alive`).
    pub fn keep_alive(&self, engine: &str) -> String {
        resolve_keep_alive(engine, self.keep_alive_override.as_deref())
    }

    /// Modelo configurado para el motor local `engine`; `None` si `engine`
    /// no es local.
    pub fn model_for(&self, engine: &str) -> Option<&str> {
        match as_local_engine(engine)? {
            "low" => Some(&self.model_low),
            "mid" => Some(&self.model_mid),
            _ => Some(&self.model_high),
        }
    }
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
            keep_alive_override: None,
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
        keep_alive_override: read_string_key(&text, KEEP_ALIVE_KEY)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
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
    write_engine_at(&path, engine)
}

/// Copia de seguridad y escritura atomica de `settings.json`, separada de la
/// resolucion de la ruta real para poder probarla sobre un fichero temporal.
fn write_engine_at(path: &Path, engine: &str) -> Result<(Option<String>, Vec<String>), String> {
    let text = fs::read_to_string(path).map_err(|e| format!("no se pudo leer {path:?}: {e}"))?;

    let copilot_on = engine == "copilot";
    let updated = upsert_key(&text, ENGINE_KEY, &format!("\"{engine}\""))?;
    let updated = upsert_key(
        &updated,
        COPILOT_KEY,
        if copilot_on { "true" } else { "false" },
    )?;

    // Copia de seguridad antes de tocar un fichero que no es nuestro: si no se
    // puede hacer, no se toca el original.
    let backup = path.with_extension("json.ultron-bak");
    fs::write(&backup, &text).map_err(|e| {
        format!("no se pudo hacer la copia de seguridad {backup:?}; settings.json sin tocar: {e}")
    })?;
    write_atomic(path, &updated)?;

    Ok(plan_for(engine, &models_from(&updated)))
}

/// Temporal hermano + rename: una interrupcion a mitad deja el original
/// entero, nunca truncado (mismo volumen, asi que el rename es atomico).
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.ultron-tmp");
    fs::write(&tmp, text).map_err(|e| format!("no se pudo escribir {tmp:?}: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        // Limpieza best-effort; el error que importa es el del rename.
        let _ = fs::remove_file(&tmp);
        format!("no se pudo reemplazar {path:?}: {e}")
    })
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

    fn temp_settings(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ultron-editor-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, SAMPLE).unwrap();
        path
    }

    #[test]
    fn write_engine_hace_copia_y_reemplaza_sin_dejar_temporal() {
        let path = temp_settings("ok");
        write_engine_at(&path, "high").unwrap();
        let backup = path.with_extension("json.ultron-bak");
        assert_eq!(fs::read_to_string(&backup).unwrap(), SAMPLE);
        let now = fs::read_to_string(&path).unwrap();
        assert_eq!(read_engine(&now), "high");
        assert!(now.contains("un comentario que no se debe perder"));
        assert!(!path.with_extension("json.ultron-tmp").exists());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn write_engine_aborta_si_falla_la_copia_de_seguridad() {
        let path = temp_settings("bak");
        // Un directorio donde va la copia: fs::write falla.
        fs::create_dir_all(path.with_extension("json.ultron-bak")).unwrap();
        let err = write_engine_at(&path, "high").unwrap_err();
        assert!(err.contains("copia de seguridad"), "{err}");
        // Caso negativo: antes el fallo se ignoraba y settings.json se reescribía.
        assert_eq!(fs::read_to_string(&path).unwrap(), SAMPLE);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

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

    #[test]
    fn keep_alive_for_da_5m_a_low_y_mid_y_10m_a_high() {
        assert_eq!(keep_alive_for("low"), "5m");
        assert_eq!(keep_alive_for("mid"), "5m");
        assert_eq!(keep_alive_for("high"), "10m");
        // Copilot y apagado no cargan modelo; si alguien pregunta, el corto.
        assert_eq!(keep_alive_for("copilot"), "5m");
        assert_eq!(keep_alive_for("off"), "5m");
    }

    #[test]
    fn resolve_keep_alive_respeta_el_valor_explicito() {
        assert_eq!(resolve_keep_alive("low", Some("1h")), "1h");
        assert_eq!(resolve_keep_alive("high", Some(" 45m ")), "45m");
    }

    /// Caso negativo: un valor vacio o en blanco no tapa el plazo del motor.
    #[test]
    fn resolve_keep_alive_ignora_el_valor_vacio() {
        assert_eq!(resolve_keep_alive("high", Some("")), "10m");
        assert_eq!(resolve_keep_alive("mid", Some("   ")), "5m");
        assert_eq!(resolve_keep_alive("mid", None), "5m");
    }

    #[test]
    fn status_lee_el_keep_alive_explicito_del_settings() {
        let text = r#"{ "ollamaTab.keepAlive": "2h", "ollamaTab.engine": "mid" }"#;
        assert_eq!(read_string_key(text, KEEP_ALIVE_KEY).as_deref(), Some("2h"));
    }

    #[test]
    fn keep_alive_json_distingue_numero_y_duracion() {
        assert_eq!(keep_alive_json("5m"), serde_json::json!("5m"));
        assert_eq!(keep_alive_json("-1"), serde_json::json!(-1));
        assert_eq!(keep_alive_json("0"), serde_json::json!(0));
    }

    #[test]
    fn model_size_label_saca_el_tamano_del_tag() {
        assert_eq!(model_size_label("qwen2.5-coder:1.5b-base"), "1.5b");
        assert_eq!(model_size_label("qwen2.5-coder:3b-base"), "3b");
        assert_eq!(model_size_label("qwen2.5-coder:7B"), "7b");
        assert_eq!(model_size_label("smollm:135m"), "135m");
    }

    #[test]
    fn model_size_label_busca_en_el_nombre_si_el_tag_no_lo_trae() {
        assert_eq!(model_size_label("phi3-3.8b:latest"), "3.8b");
    }

    /// Caso negativo: sin tamano reconocible se devuelve el tag, no un
    /// trozo cualquiera que parezca numerico (`qwen2.5`, `v2`, `q4_0`).
    #[test]
    fn model_size_label_cae_al_tag_sin_tamano() {
        assert_eq!(model_size_label("llama3:latest"), "latest");
        assert_eq!(model_size_label("deepseek-coder-v2:q4_0"), "q4_0");
        assert_eq!(model_size_label("mistral"), "mistral");
        assert_eq!(model_size_label("modelo:1.2.3b"), "1.2.3b");
    }

    #[test]
    fn reference_local_engine_prefiere_el_activo_y_luego_el_persistido() {
        assert_eq!(reference_local_engine("high", Some("low")), "high");
        assert_eq!(reference_local_engine("copilot", Some("low")), "low");
        assert_eq!(reference_local_engine("off", None), DEFAULT_LOCAL_ENGINE);
        // Un persistido que no es local no cuenta.
        assert_eq!(
            reference_local_engine("copilot", Some("copilot")),
            DEFAULT_LOCAL_ENGINE
        );
    }

    #[test]
    fn model_for_devuelve_el_modelo_de_cada_nivel_y_none_si_no_es_local() {
        let status = EditorEngineStatus {
            available: true,
            engine: "mid".to_string(),
            model_low: "a:1b".to_string(),
            model_mid: "a:3b".to_string(),
            model_high: "a:7b".to_string(),
            active_model: Some("a:3b".to_string()),
            settings_path: None,
            keep_alive_override: None,
        };
        assert_eq!(status.model_for("low"), Some("a:1b"));
        assert_eq!(status.model_for("mid"), Some("a:3b"));
        assert_eq!(status.model_for("high"), Some("a:7b"));
        assert_eq!(status.model_for("copilot"), None);
        assert_eq!(status.model_for("off"), None);
    }
}
