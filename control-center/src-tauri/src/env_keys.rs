// ULTRON Control Center — env_keys
//
// Persiste API keys de proveedores IA como variables de entorno de usuario
// Windows via `setx KEY value`. El efecto es permanente para sesiones nuevas;
// la sesión actual del proceso NO recibe el cambio (comportamiento estándar
// de setx). El frontend muestra un toast indicando que hay que reiniciar.
//
// Seguridad:
//   - Whitelist estricta de nombres de variable — ningún nombre arbitrario.
//   - `setx` opera en User scope (HKCU), sin necesidad de elevación.
//   - Los valores se pasan como argumentos de proceso, no interpolados en
//     strings de shell, por lo que no hay inyección de comandos.
//   - Los valores vacíos se omiten (no se pasa "" a setx — en Windows setx ""
//     borra la variable, lo cual puede no ser lo deseado; el usuario debe
//     borrar manualmente si quiere revocar).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;

/// Nombres de variables de entorno que este comando acepta modificar.
/// Cualquier clave que no esté en esta lista es ignorada (skipped).
const ALLOWED_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "COHERE_API_KEY",
];

#[derive(Debug, Serialize, Deserialize)]
pub struct EnvKeysSaveResult {
    /// Keys efectivamente guardadas con setx.
    pub saved: Vec<String>,
    /// Keys recibidas pero ignoradas (no en whitelist o valor vacío).
    pub skipped: Vec<String>,
    /// Errores de setx por key (nombre -> mensaje de error).
    pub errors: HashMap<String, String>,
}

pub fn set_env_vars_keys_inner(
    keys: HashMap<String, String>,
) -> Result<EnvKeysSaveResult, String> {
    let mut saved: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut errors: HashMap<String, String> = HashMap::new();

    for (key, value) in &keys {
        // Whitelist check — reject unknown keys silently (skipped).
        if !ALLOWED_KEYS.contains(&key.as_str()) {
            skipped.push(key.clone());
            continue;
        }

        // Skip blank values — caller should send non-empty strings only.
        let trimmed = value.trim();
        if trimmed.is_empty() {
            skipped.push(key.clone());
            continue;
        }

        // setx KEY value  — User scope, no /M flag (no elevation required).
        // Arguments passed as separate &str so the OS builds the argv array
        // directly; no shell interpretation possible.
        let result = Command::new("setx").arg(key).arg(trimmed).output();

        match result {
            Ok(output) if output.status.success() => {
                saved.push(key.clone());
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let msg = if !stderr.is_empty() { stderr } else { stdout };
                errors.insert(key.clone(), msg);
            }
            Err(e) => {
                errors.insert(key.clone(), format!("spawn setx: {e}"));
            }
        }
    }

    Ok(EnvKeysSaveResult { saved, skipped, errors })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_keys_are_skipped() {
        let mut keys = HashMap::new();
        keys.insert("UNKNOWN_KEY".to_string(), "somevalue".to_string());
        let result = set_env_vars_keys_inner(keys).unwrap();
        assert!(result.saved.is_empty());
        assert_eq!(result.skipped, vec!["UNKNOWN_KEY"]);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn empty_values_are_skipped() {
        let mut keys = HashMap::new();
        keys.insert("ANTHROPIC_API_KEY".to_string(), "   ".to_string());
        let result = set_env_vars_keys_inner(keys).unwrap();
        assert!(result.saved.is_empty());
        assert_eq!(result.skipped, vec!["ANTHROPIC_API_KEY"]);
    }
}
