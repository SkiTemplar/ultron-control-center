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
    // Providers para el proxy free-tier (NVIDIA NIM + OpenRouter).
    "NVIDIA_NIM_API_KEY",
    "OPENROUTER_API_KEY",
];

/// Estado de una API key de proveedor: si está configurada (registro User
/// scope o env del proceso) y una versión enmascarada para mostrar en la UI.
/// NUNCA se devuelve el valor completo.
#[derive(Debug, Serialize, Deserialize)]
pub struct EnvKeyStatus {
    pub env_var: String,
    /// True si la key existe en el env del PROCESO actual (la que el AI
    /// router puede usar ahora mismo sin reiniciar).
    pub active: bool,
    /// True si la key existe en el registro de usuario (HKCU\Environment),
    /// aunque el proceso actual no la vea todavía (requiere reiniciar).
    pub configured: bool,
    /// Vista enmascarada `abcd…wxyz`. None si no hay key o parece placeholder.
    pub masked: Option<String>,
}

/// Enmascara una key: primeros 4 + ... + últimos 4. Devuelve None si vacía
/// o demasiado corta para ocultar nada útil.
fn mask_secret(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if t.len() <= 8 {
        return Some("*".repeat(t.len()));
    }
    Some(format!("{}…{}", &t[..4], &t[t.len() - 4..]))
}

/// Lee el valor User-scope de cada key vía `reg query HKCU\Environment`.
/// Bulk: una sola llamada. Devuelve mapa env_var -> valor (sin masking).
fn read_user_scope_keys() -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let output = Command::new("reg")
        .args(["query", "HKCU\\Environment"])
        .output();
    let Ok(output) = output else {
        return out;
    };
    if !output.status.success() {
        return out;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // Cada línea de valor: "    NAME    REG_SZ    value"
    for line in text.lines() {
        let line = line.trim_start();
        for key in ALLOWED_KEYS {
            if let Some(rest) = line.strip_prefix(key) {
                // rest empieza con whitespace + "REG_SZ" (o REG_EXPAND_SZ) + ws + valor
                if let Some(idx) = rest.find("REG_") {
                    let after = &rest[idx..];
                    // saltar el token REG_xxx y el whitespace siguiente
                    if let Some(ws) = after.find(char::is_whitespace) {
                        let value = after[ws..].trim();
                        if !value.is_empty() {
                            out.insert((*key).to_string(), value.to_string());
                        }
                    }
                }
            }
        }
    }
    out
}

/// Devuelve el estado de todas las API keys conocidas para que la UI muestre
/// cuáles ya están puestas (sin exponer el valor).
pub fn get_env_keys_status_inner() -> Result<Vec<EnvKeyStatus>, String> {
    let user_scope = read_user_scope_keys();
    let mut rows: Vec<EnvKeyStatus> = Vec::with_capacity(ALLOWED_KEYS.len());
    for key in ALLOWED_KEYS {
        let proc_val = std::env::var(key).ok();
        let active = proc_val.as_deref().map(|v| !v.trim().is_empty()).unwrap_or(false);
        let user_val = user_scope.get(*key);
        let configured = active || user_val.is_some();
        // Preferimos el valor del proceso para masking; si no, el del registro.
        let masked = proc_val
            .as_deref()
            .and_then(mask_secret)
            .or_else(|| user_val.map(|s| s.as_str()).and_then(mask_secret));
        rows.push(EnvKeyStatus {
            env_var: (*key).to_string(),
            active,
            configured,
            masked,
        });
    }
    Ok(rows)
}

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
