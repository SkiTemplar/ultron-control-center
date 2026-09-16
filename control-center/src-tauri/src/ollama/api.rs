// ULTRON Control Center — Ollama: tipos expuestos al frontend + parseo
// puro de las respuestas REST que usa la seccion "Modelo local" de AI
// Router.
//
// Todo lo que toca red vive en `commands.rs`; aqui solo tipos
// serializables y funciones de parseo puras (testeables sin Ollama vivo),
// en la misma linea que `toggle.rs`.

use serde::Serialize;
use serde_json::Value;

// ---------------------------------------------------------------------------
// Tipos expuestos al frontend
// ---------------------------------------------------------------------------

/// Un modelo actualmente cargado en memoria, segun `GET /api/ps`.
#[derive(Debug, Clone, Serialize)]
pub struct LoadedModel {
    pub name: String,
    /// VRAM ocupada en bytes (`size_vram` de `/api/ps`).
    pub size_vram: u64,
    /// Instante RFC3339 hasta el que Ollama mantiene el modelo cargado.
    /// Ollama lo omite o lo fija muy lejos en el futuro cuando se cargo
    /// con `keep_alive: -1` — el frontend decide como mostrarlo ("fijado"
    /// vs. cuenta atras) a partir de este valor crudo.
    pub expires_at: Option<String>,
}

/// Un modelo descargado en disco, segun `GET /api/tags`.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadedModel {
    pub name: String,
    pub size: u64,
    pub family: Option<String>,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
}

/// Snapshot completo que consume la seccion "Modelo local" de AI Router.
#[derive(Debug, Clone, Serialize)]
pub struct OllamaStatus {
    pub installed: bool,
    pub server_up: bool,
    pub version: Option<String>,
    pub configured_model: String,
    /// `"env"` | `"config"` | `"default"` — de donde sale `configured_model`
    /// (ver `toggle::resolve_model_name`).
    pub configured_model_source: &'static str,
    pub loaded_models: Vec<LoadedModel>,
    pub downloaded_models: Vec<DownloadedModel>,
}

/// Resultado de `ollama_benchmark`: N peticiones FIM en caliente.
#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkResult {
    pub model: String,
    pub samples_ms: Vec<u64>,
    pub median_ms: u64,
    pub max_ms: u64,
    /// Ultima linea sugerida por el modelo durante la medicion — sirve
    /// para comprobar a ojo que la respuesta tiene sentido, no solo que
    /// llego rapido.
    pub suggested_line: String,
}

/// Evento de progreso de `ollama_pull`, emitido tal cual al frontend via
/// `app.emit("ollama_pull_progress", …)`.
#[derive(Debug, Clone, Serialize, Default)]
pub struct PullProgressEvent {
    pub model: String,
    pub status: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    /// `completed / total * 100`, redondeado. `None` si Ollama no informa
    /// tamano para esta fase (p. ej. "verifying sha256 digest").
    pub percent: Option<u8>,
    pub done: bool,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Parseo puro — /api/ps con detalle (vram + expires_at)
// ---------------------------------------------------------------------------

pub fn parse_loaded_models(body: &str) -> Result<Vec<LoadedModel>, String> {
    let parsed: Value =
        serde_json::from_str(body).map_err(|e| format!("JSON de /api/ps invalido: {e}"))?;
    let empty = Vec::new();
    let models = parsed
        .get("models")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    Ok(models
        .iter()
        .filter_map(|m| {
            let name = m
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| m.get("model").and_then(Value::as_str))?
                .to_string();
            let size_vram = m.get("size_vram").and_then(Value::as_u64).unwrap_or(0);
            let expires_at = m
                .get("expires_at")
                .and_then(Value::as_str)
                .map(str::to_string);
            Some(LoadedModel {
                name,
                size_vram,
                expires_at,
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Parseo puro — /api/tags
// ---------------------------------------------------------------------------

pub fn parse_downloaded_models(body: &str) -> Result<Vec<DownloadedModel>, String> {
    let parsed: Value =
        serde_json::from_str(body).map_err(|e| format!("JSON de /api/tags invalido: {e}"))?;
    let empty = Vec::new();
    let models = parsed
        .get("models")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    Ok(models
        .iter()
        .filter_map(|m| {
            let name = m.get("name").and_then(Value::as_str)?.to_string();
            let size = m.get("size").and_then(Value::as_u64).unwrap_or(0);
            let details = m.get("details");
            let family = details
                .and_then(|d| d.get("family"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let parameter_size = details
                .and_then(|d| d.get("parameter_size"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let quantization_level = details
                .and_then(|d| d.get("quantization_level"))
                .and_then(Value::as_str)
                .map(str::to_string);
            Some(DownloadedModel {
                name,
                size,
                family,
                parameter_size,
                quantization_level,
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Parseo puro — /api/version
// ---------------------------------------------------------------------------

pub fn parse_version(body: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    parsed
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// Validacion del nombre de modelo — antes de mandarlo a /api/pull o
// /api/delete (nunca se interpola en un comando de shell, pero sí viaja
// en la URL/JSON de la peticion: se acota el charset igualmente).
// ---------------------------------------------------------------------------

/// Charset permitido en un nombre de modelo Ollama: alfanumerico + `.`
/// `-` `_` `:` `/` (namespace/repo, tag). Rechaza vacio, demasiado largo,
/// espacios y cualquier secuencia `..` (ruta ascendente).
pub fn is_valid_model_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 200 {
        return false;
    }
    if name.contains("..") {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '/'))
}

// ---------------------------------------------------------------------------
// Parseo puro — una linea NDJSON de progreso de /api/pull
// ---------------------------------------------------------------------------

pub fn parse_pull_progress_line(model: &str, line: &str) -> Result<PullProgressEvent, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err("linea de progreso vacia".to_string());
    }
    let parsed: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("JSON de progreso de pull invalido: {e}"))?;

    if let Some(err) = parsed.get("error").and_then(Value::as_str) {
        return Ok(PullProgressEvent {
            model: model.to_string(),
            status: "error".to_string(),
            error: Some(err.to_string()),
            done: true,
            ..Default::default()
        });
    }

    let status = parsed
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let completed = parsed.get("completed").and_then(Value::as_u64);
    let total = parsed.get("total").and_then(Value::as_u64);
    let percent = match (completed, total) {
        (Some(c), Some(t)) if t > 0 => Some(((c as f64 / t as f64) * 100.0).round() as u8),
        _ => None,
    };
    let done = status == "success";

    Ok(PullProgressEvent {
        model: model.to_string(),
        status,
        completed,
        total,
        percent,
        done,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- parse_loaded_models --

    #[test]
    fn parse_loaded_models_lee_nombre_vram_y_expiracion() {
        let body = r#"{"models":[{"name":"qwen:7b","size_vram":123456,"expires_at":"2026-09-16T12:00:00Z"}]}"#;
        let models = parse_loaded_models(body).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "qwen:7b");
        assert_eq!(models[0].size_vram, 123456);
        assert_eq!(
            models[0].expires_at.as_deref(),
            Some("2026-09-16T12:00:00Z")
        );
    }

    #[test]
    fn parse_loaded_models_usa_size_vram_cero_si_falta() {
        let body = r#"{"models":[{"name":"qwen:7b"}]}"#;
        let models = parse_loaded_models(body).unwrap();
        assert_eq!(models[0].size_vram, 0);
        assert_eq!(models[0].expires_at, None);
    }

    #[test]
    fn parse_loaded_models_devuelve_lista_vacia_sin_campo_models() {
        assert!(parse_loaded_models("{}").unwrap().is_empty());
    }

    #[test]
    fn parse_loaded_models_falla_con_json_invalido() {
        assert!(parse_loaded_models("no es JSON").is_err());
    }

    // -- parse_downloaded_models --

    #[test]
    fn parse_downloaded_models_lee_detalles() {
        let body = r#"{"models":[{"name":"qwen:7b","size":999,"details":{"family":"qwen2","parameter_size":"7B","quantization_level":"Q4_K_M"}}]}"#;
        let models = parse_downloaded_models(body).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "qwen:7b");
        assert_eq!(models[0].size, 999);
        assert_eq!(models[0].family.as_deref(), Some("qwen2"));
        assert_eq!(models[0].parameter_size.as_deref(), Some("7B"));
        assert_eq!(models[0].quantization_level.as_deref(), Some("Q4_K_M"));
    }

    #[test]
    fn parse_downloaded_models_tolera_ausencia_de_details() {
        let body = r#"{"models":[{"name":"qwen:7b","size":999}]}"#;
        let models = parse_downloaded_models(body).unwrap();
        assert_eq!(models[0].family, None);
    }

    #[test]
    fn parse_downloaded_models_falla_con_json_invalido() {
        assert!(parse_downloaded_models("no es JSON").is_err());
    }

    // -- parse_version --

    #[test]
    fn parse_version_lee_el_campo_version() {
        assert_eq!(
            parse_version(r#"{"version":"0.34.1"}"#),
            Some("0.34.1".to_string())
        );
    }

    #[test]
    fn parse_version_devuelve_none_con_json_invalido() {
        assert_eq!(parse_version("no es JSON"), None);
    }

    // -- is_valid_model_name --

    #[test]
    fn is_valid_model_name_acepta_nombre_con_namespace_y_tag() {
        assert!(is_valid_model_name("qwen2.5-coder:1.5b-base"));
        assert!(is_valid_model_name("library/qwen2.5-coder:7b"));
    }

    #[test]
    fn is_valid_model_name_rechaza_vacio() {
        assert!(!is_valid_model_name(""));
    }

    #[test]
    fn is_valid_model_name_rechaza_espacios() {
        assert!(!is_valid_model_name("qwen 7b"));
    }

    #[test]
    fn is_valid_model_name_rechaza_ruta_ascendente() {
        assert!(!is_valid_model_name("../../etc/passwd"));
    }

    #[test]
    fn is_valid_model_name_rechaza_metacaracteres_de_shell() {
        assert!(!is_valid_model_name("qwen:7b; rm -rf /"));
        assert!(!is_valid_model_name("qwen:7b`whoami`"));
        assert!(!is_valid_model_name("qwen:7b\\..\\x"));
    }

    #[test]
    fn is_valid_model_name_rechaza_demasiado_largo() {
        let long = "a".repeat(201);
        assert!(!is_valid_model_name(&long));
    }

    // -- parse_pull_progress_line --

    #[test]
    fn parse_pull_progress_line_calcula_porcentaje() {
        let line = r#"{"status":"downloading","completed":50,"total":200}"#;
        let event = parse_pull_progress_line("qwen:7b", line).unwrap();
        assert_eq!(event.status, "downloading");
        assert_eq!(event.percent, Some(25));
        assert!(!event.done);
        assert!(event.error.is_none());
    }

    #[test]
    fn parse_pull_progress_line_sin_total_no_calcula_porcentaje() {
        let line = r#"{"status":"verifying sha256 digest"}"#;
        let event = parse_pull_progress_line("qwen:7b", line).unwrap();
        assert_eq!(event.percent, None);
    }

    #[test]
    fn parse_pull_progress_line_marca_success_como_done() {
        let line = r#"{"status":"success"}"#;
        let event = parse_pull_progress_line("qwen:7b", line).unwrap();
        assert!(event.done);
    }

    #[test]
    fn parse_pull_progress_line_propaga_error_del_servidor() {
        let line = r#"{"error":"pull model manifest: file does not exist"}"#;
        let event = parse_pull_progress_line("qwen:7b", line).unwrap();
        assert!(event.done);
        assert_eq!(
            event.error.as_deref(),
            Some("pull model manifest: file does not exist")
        );
    }

    #[test]
    fn parse_pull_progress_line_falla_con_json_invalido() {
        assert!(parse_pull_progress_line("qwen:7b", "no es JSON").is_err());
    }

    #[test]
    fn parse_pull_progress_line_falla_con_linea_vacia() {
        assert!(parse_pull_progress_line("qwen:7b", "   ").is_err());
    }
}
