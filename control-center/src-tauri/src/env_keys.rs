// ULTRON Control Center — env_keys
//
// Persiste API keys de proveedores IA como variables de entorno de usuario
// Windows via `setx KEY value` (permanente para procesos nuevos) Y ADEMÁS las
// refleja en el proceso actual con `std::env::set_var`, de modo que surten
// efecto sin reiniciar: el badge pasa a "activa" y el proxy free-tier (hijo de
// la app) hereda la key recién guardada.
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
/// Cualquier clave que no esté en esta lista es ignorada (skipped). Las
/// sesiones de ULTRON Sessions no las heredan (`sesiones::lanzamiento`).
pub(crate) const ALLOWED_KEYS: &[&str] = &[
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
    // Proveedores OpenAI-compatibles del seed del AI Router (2026-10-26,
    // ai_router/seed_openai_compat.rs).
    "CEREBRAS_API_KEY",
    "GITHUB_MODELS_TOKEN",
    "TOGETHER_API_KEY",
    "FIREWORKS_API_KEY",
    "XAI_API_KEY",
    "SAMBANOVA_API_KEY",
    "HF_TOKEN",
    "MOONSHOT_API_KEY",
    "DASHSCOPE_API_KEY",
    "ZAI_API_KEY",
    // Buscador de papers (hooks/scripts/lib/research/*.js): claves/emails que
    // leen openalex.js, semantic-scholar.js y unpaywall.js vía process.env.
    "OPENALEX_API_KEY",
    "OPENALEX_MAILTO",
    "SEMANTIC_SCHOLAR_API_KEY",
    "UNPAYWALL_EMAIL",
];

/// Prefijo de las keys personalizadas (proveedores dados de alta desde la
/// UI): `ULTRON_KEY_<NOMBRE>`, con `<NOMBRE>` de 2 a 40 caracteres `A-Z0-9_`.
const CUSTOM_KEY_PREFIX: &str = "ULTRON_KEY_";

/// `true` si `name` casa con `^ULTRON_KEY_[A-Z0-9_]{2,40}$`.
pub(crate) fn is_custom_key(name: &str) -> bool {
    name.strip_prefix(CUSTOM_KEY_PREFIX).is_some_and(|rest| {
        (2..=40).contains(&rest.len())
            && rest
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    })
}

/// Variables que la app puede escribir y leer como key: las de
/// `ALLOWED_KEYS` y las personalizadas `ULTRON_KEY_*`. Cualquier otro nombre
/// se rechaza.
pub(crate) fn is_allowed_key(name: &str) -> bool {
    ALLOWED_KEYS.contains(&name) || is_custom_key(name)
}

/// Subconjunto de `ALLOWED_KEYS` que son direcciones de contacto, no
/// secretos: no se enmascaran en la UI y se validan como email en vez de
/// tratarse como una API key opaca.
const EMAIL_KEYS: &[&str] = &["OPENALEX_MAILTO", "UNPAYWALL_EMAIL"];

/// Validación mínima "parse, don't validate": exige un único `@` no inicial
/// ni final y un dominio con al menos un punto. No pretende cubrir el RFC
/// completo — solo evitar que basura evidente (vacío, sin arroba, sin
/// dominio) llegue a `set_var`/`setx` y a las peticiones reales a OpenAlex /
/// Unpaywall, que exigen un contacto con forma de email.
fn is_valid_email(raw: &str) -> bool {
    let t = raw.trim();
    let Some(at) = t.find('@') else {
        return false;
    };
    if at == 0 || at == t.len() - 1 {
        return false;
    }
    let domain = &t[at + 1..];
    domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

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
    /// Vista enmascarada `abcd…wxyz` para secretos. Para las variables de
    /// `EMAIL_KEYS` (`is_secret: false`) lleva el valor COMPLETO sin
    /// enmascarar — un email no es un secreto y ocultarlo solo estorba a
    /// quien quiere comprobar qué contacto quedó guardado. None si no hay
    /// valor.
    pub masked: Option<String>,
    /// False para las variables de contacto (`EMAIL_KEYS`): la UI no debe
    /// enmascararlas ni ofrecer el toggle de mostrar/ocultar.
    pub is_secret: bool,
}

/// Enmascara una key: primeros 4 + ... + últimos 4. Devuelve None si vacía
/// o demasiado corta para ocultar nada útil.
fn mask_secret(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    Some(mask_ends(t, 4, 4))
}

/// `head` caracteres + … + `tail` caracteres; todo asteriscos si no hay
/// nada que ocultar entre medias. Cuenta caracteres, no bytes: un corte por
/// bytes con «ñ» o «€» en el borde hacía panic.
fn mask_ends(t: &str, head: usize, tail: usize) -> String {
    let n = t.chars().count();
    if n <= head + tail {
        return "*".repeat(n);
    }
    let first: String = t.chars().take(head).collect();
    let last: String = t.chars().skip(n - tail).collect();
    format!("{first}…{last}")
}

/// Lee el valor User-scope de cada key vía `reg query HKCU\Environment`.
/// Bulk: una sola llamada. Devuelve mapa env_var -> valor (sin masking).
///
/// `pub(crate)` para que `proxy.rs` pueda inyectar estas keys al proxy
/// free-tier directamente del registro, sin depender de que la app las haya
/// heredado (setx no refresca el proceso padre / explorer.exe).
pub(crate) fn read_user_scope_keys() -> HashMap<String, String> {
    let output = Command::new("reg")
        .args(["query", "HKCU\\Environment"])
        .output();
    let Ok(output) = output else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }
    parse_reg_query(&String::from_utf8_lossy(&output.stdout))
}

/// Extrae de la salida de `reg query HKCU\Environment` las variables
/// permitidas (`is_allowed_key`). Cada línea de valor es
/// `    NAME    REG_SZ    value`; el nombre se compara ENTERO (primer token),
/// así que `GROQ_API_KEY_EVIL` no cuela como `GROQ_API_KEY`. Pura.
pub(crate) fn parse_reg_query(text: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        let line = line.trim_start();
        let Some((name, rest)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        if !is_allowed_key(name) {
            continue;
        }
        // rest = ws + "REG_SZ" (o REG_EXPAND_SZ) + ws + valor
        let Some(idx) = rest.find("REG_") else {
            continue;
        };
        let after = &rest[idx..];
        if let Some(ws) = after.find(char::is_whitespace) {
            let value = after[ws..].trim();
            if !value.is_empty() {
                out.insert(name.to_string(), value.to_string());
            }
        }
    }
    out
}

/// Keys que se muestran en Settings: las de `ALLOWED_KEYS` y, detrás y
/// ordenadas, las `ULTRON_KEY_*` que existan en el registro o en el proceso.
fn listed_keys(user_scope: &HashMap<String, String>) -> Vec<String> {
    let mut custom: Vec<String> = user_scope
        .keys()
        .cloned()
        .chain(std::env::vars().map(|(k, _)| k))
        .filter(|k| is_custom_key(k))
        .collect();
    custom.sort();
    custom.dedup();
    ALLOWED_KEYS
        .iter()
        .map(|k| (*k).to_string())
        .chain(custom)
        .collect()
}

/// Devuelve el estado de todas las API keys conocidas para que la UI muestre
/// cuáles ya están puestas (sin exponer el valor).
pub fn get_env_keys_status_inner() -> Result<Vec<EnvKeyStatus>, String> {
    let user_scope = read_user_scope_keys();
    let keys = listed_keys(&user_scope);
    let mut rows: Vec<EnvKeyStatus> = Vec::with_capacity(keys.len());
    for key in &keys {
        let proc_val = std::env::var(key).ok();
        let active = proc_val
            .as_deref()
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        let user_val = user_scope.get(key);
        let configured = active || user_val.is_some();
        let is_secret = !EMAIL_KEYS.contains(&key.as_str());
        // Preferimos el valor del proceso; si no, el del registro. Los
        // secretos se enmascaran (mask_secret); los emails (EMAIL_KEYS) se
        // muestran completos — no son un dato sensible.
        let raw_val = proc_val.as_deref().or_else(|| user_val.map(String::as_str));
        let masked = if is_secret {
            raw_val.and_then(mask_secret)
        } else {
            raw_val
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        rows.push(EnvKeyStatus {
            env_var: key.clone(),
            active,
            configured,
            masked,
            is_secret,
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

pub fn set_env_vars_keys_inner(keys: HashMap<String, String>) -> Result<EnvKeysSaveResult, String> {
    let mut saved: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut errors: HashMap<String, String> = HashMap::new();

    for (key, value) in &keys {
        // Whitelist check — reject unknown keys silently (skipped).
        if !is_allowed_key(key) {
            skipped.push(key.clone());
            continue;
        }

        // Skip blank values — caller should send non-empty strings only.
        let trimmed = value.trim();
        if trimmed.is_empty() {
            skipped.push(key.clone());
            continue;
        }

        // EMAIL_KEYS (OPENALEX_MAILTO, UNPAYWALL_EMAIL) son direcciones de
        // contacto, no secretos opacos: validamos forma de email en vez de
        // aceptar cualquier string. Unpaywall en concreto rechaza la
        // petición si el valor no parece un email real (verificado contra
        // la API el 2026-09-11, ver lib/research/unpaywall.js).
        if EMAIL_KEYS.contains(&key.as_str()) && !is_valid_email(trimmed) {
            skipped.push(key.clone());
            continue;
        }

        // setx KEY value  — User scope, no /M flag (no elevation required).
        // Arguments passed as separate &str so the OS builds the argv array
        // directly; no shell interpretation possible.
        let result = Command::new("setx").arg(key).arg(trimmed).output();

        match result {
            Ok(output) if output.status.success() => {
                // Reflejar el cambio en el PROCESO actual para que surta efecto
                // SIN reiniciar la app: `get_env_keys_status` pasa a active=true
                // y, sobre todo, el proxy free-tier (lanzado como hijo de la app
                // vía `proxy_start_inner`, que lee `std::env::var`) hereda la key
                // recien guardada. `setx` solo afecta a procesos nuevos; esto
                // cubre el proceso vivo. Edition 2021 → `set_var` es seguro.
                std::env::set_var(key, trimmed);
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

    Ok(EnvKeysSaveResult {
        saved,
        skipped,
        errors,
    })
}

// ---------------------------------------------------------------------------
// Quitar una key: entorno de usuario, proceso y ficheros .env
// ---------------------------------------------------------------------------

/// Quita la línea que define `key` en un `.env`, conservando el resto tal cual.
/// `None` si no la define. Comentarios y claves con el mismo prefijo no cuentan.
fn strip_env_line(text: &str, key: &str) -> Option<String> {
    let defines_key = |line: &str| {
        let line = line.trim_start();
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        line.split_once('=')
            .is_some_and(|(name, _)| name.trim() == key)
    };
    if !text.lines().any(defines_key) {
        return None;
    }
    let kept: String = text
        .split_inclusive('\n')
        .filter(|line| !defines_key(line))
        .collect();
    Some(kept)
}

/// Escribe sin dejar el `.env` a medias si el proceso muere en mitad.
fn remove_key_from_env_file(path: &std::path::Path, key: &str) -> Result<(), String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("leer {}: {e}", path.display())),
    };
    let Some(kept) = strip_env_line(&text, key) else {
        return Ok(());
    };
    let tmp = path.with_extension("env.tmp");
    std::fs::write(&tmp, kept).map_err(|e| format!("escribir {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("reemplazar {}: {e}", path.display()))
}

/// Borra la variable de usuario. `setx` no borra y `reg delete` no avisa a los
/// procesos nuevos; la API de .NET hace ambas cosas. El nombre va por el entorno
/// del hijo, no interpolado en el script.
fn remove_user_scope_var(key: &str) -> Result<(), String> {
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::SetEnvironmentVariable($env:ULTRON_KEY_TO_REMOVE, $null, 'User')",
    ])
    .env("ULTRON_KEY_TO_REMOVE", key);
    let timeout = std::time::Duration::from_secs(30);
    let out = crate::ai_router::exec::run_with_timeout(cmd, timeout, None)
        .map_err(|e| format!("powershell: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
}

fn remove_env_key_with(
    key: &str,
    env_files: &[std::path::PathBuf],
    remove_user_var: impl Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    if !is_allowed_key(key) {
        return Err(format!("{key} no es una key que esta app gestione"));
    }
    remove_user_var(key)?;
    // Los `.env` antes que el proceso: si uno falla, la key sigue activa y el
    // error lo dice, en vez de reaparecer sola en el siguiente arranque.
    for path in env_files {
        remove_key_from_env_file(path, key)?;
    }
    std::env::remove_var(key);
    Ok(())
}

/// Quita una key del entorno de usuario, del proceso y de los dos `.env` que
/// carga `dotenvy` al arrancar: si siguiera en uno, volvería en el siguiente inicio.
pub fn remove_env_key_inner(key: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let ultron = home.join(".ultron");
    let env_files = [
        ultron.join(".env"),
        ultron.join("control-center").join(".env"),
    ];
    remove_env_key_with(key, &env_files, remove_user_scope_var)
}

// ---------------------------------------------------------------------------
// GitHub Token — persist to ~/.ultron/.env
// ---------------------------------------------------------------------------

/// Result returned to the frontend after a set_github_token call.
#[derive(Debug, Serialize, Deserialize)]
pub struct GithubTokenResult {
    /// Whether the write succeeded.
    pub ok: bool,
    /// Masked preview of the token that was saved (first 6 + … + last 4 chars).
    pub masked: String,
    /// Human-readable status message suitable for display in a toast.
    pub message: String,
}

/// Valid GitHub token prefixes (as of 2022 fine-grained PATs + classic).
const GITHUB_TOKEN_PREFIXES: &[&str] = &["ghp_", "gho_", "ghs_", "ghu_", "github_pat_"];

fn mask_github_token(token: &str) -> String {
    mask_ends(token, 6, 4)
}

/// Write `GITHUB_TOKEN=<token>` to `~/.ultron/.env`.
///
/// Strategy:
///   1. Read the existing .env (if present).
///   2. Replace an existing GITHUB_TOKEN line, or append one.
///   3. Write atomically via tmp + rename.
///   4. Apply to the current process with `std::env::set_var`.
pub fn set_github_token_inner(token: String) -> Result<GithubTokenResult, String> {
    let token = token.trim().to_string();

    // --- Validation ---
    if token.is_empty() {
        return Ok(GithubTokenResult {
            ok: false,
            masked: String::new(),
            message: "El token no puede estar vacío.".to_string(),
        });
    }
    let known_prefix = GITHUB_TOKEN_PREFIXES.iter().any(|p| token.starts_with(p));
    if !known_prefix {
        return Ok(GithubTokenResult {
            ok: false,
            masked: mask_github_token(&token),
            message: format!(
                "Prefijo desconocido. Los tokens GitHub válidos empiezan con: {}",
                GITHUB_TOKEN_PREFIXES.join(", ")
            ),
        });
    }

    // --- Locate ~/.ultron/.env ---
    let env_path = dirs::home_dir()
        .ok_or_else(|| "No se pudo determinar el directorio home.".to_string())?
        .join(".ultron")
        .join(".env");

    // Ensure the parent directory exists.
    if let Some(parent) = env_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear ~/.ultron/: {e}"))?;
    }

    // Read existing content (tolerate missing file).
    let existing = if env_path.exists() {
        std::fs::read_to_string(&env_path)
            .map_err(|e| format!("No se pudo leer ~/.ultron/.env: {e}"))?
    } else {
        String::new()
    };

    // Rebuild lines: replace any existing GITHUB_TOKEN= line, preserving order.
    let new_line = format!("GITHUB_TOKEN={token}");
    let mut replaced = false;
    let mut lines: Vec<String> = existing
        .lines()
        .map(|l| {
            if l.trim_start().starts_with("GITHUB_TOKEN=") {
                replaced = true;
                new_line.clone()
            } else {
                l.to_string()
            }
        })
        .collect();

    if !replaced {
        // Ensure a trailing newline before appending.
        if !lines.is_empty() && !existing.ends_with('\n') {
            // The last stored line had no newline — writeln will add it.
        }
        lines.push(new_line);
    }

    // Atomic write: tmp + rename.
    let tmp = env_path.with_extension("env.tmp");
    let content = lines.join("\n") + "\n";
    std::fs::write(&tmp, content.as_bytes())
        .map_err(|e| format!("No se pudo escribir el tmp de .env: {e}"))?;
    std::fs::rename(&tmp, &env_path)
        .map_err(|e| format!("No se pudo renombrar .env.tmp -> .env: {e}"))?;

    // Apply to the current process so the change takes effect without restart.
    // No es un proceso de un solo hilo (spawn_blocking corre en un pool y la
    // app es multihilo). En Rust 2021 `set_var` es seguro frente a otros hilos
    // que usen `std::env` (comparten el lock de std); el riesgo que queda es
    // una lectura del entorno desde código C (FFI) que no tome ese lock.
    std::env::set_var("GITHUB_TOKEN", &token);

    let masked = mask_github_token(&token);
    Ok(GithubTokenResult {
        ok: true,
        masked: masked.clone(),
        message: format!(
            "GITHUB_TOKEN guardado en ~/.ultron/.env ({masked}). Activo en el proceso actual."
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enmascarar_no_parte_un_caracter_multibyte() {
        // Antes se cortaba por bytes (`&t[..4]`): con «ñ» o «€» en el borde,
        // panic en el comando.
        assert_eq!(mask_secret("aaañbbbbbbbñ").as_deref(), Some("aaañ…bbbñ"));
        assert_eq!(mask_secret("€€€€€€€€€€").as_deref(), Some("€€€€…€€€€"));
        assert_eq!(mask_github_token("ghp_aañ€bbbbbbbbñ"), "ghp_aa…bbbñ");
        // Caso negativo: lo corto se tapa entero, contado en caracteres.
        assert_eq!(mask_secret("ñññññññ").as_deref(), Some("*******"));
        assert_eq!(mask_github_token("€€€€€"), "*****");
        assert_eq!(mask_secret("  "), None);
    }

    /// Toca el HKCU real con una variable desechable. A mano:
    /// `cargo test --features finance --lib borra_una_variable_real -- --ignored`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn borra_una_variable_real_del_entorno_de_usuario() {
        let nombre = "ULTRON_KEY_SELFTEST_REMOVE";
        let set = Command::new("setx")
            .args([nombre, "x"])
            .output()
            .expect("setx");
        assert!(set.status.success());
        assert!(
            read_user_scope_keys().contains_key(nombre),
            "la variable existe"
        );
        remove_user_scope_var(nombre).expect("quitar");
        assert!(!read_user_scope_keys().contains_key(nombre), "ya no existe");
        remove_user_scope_var(nombre).expect("quitar lo que no está no es un error");
    }

    #[test]
    fn strip_env_line_quita_solo_esa_clave() {
        let env =
            "# OPENAI_API_KEY=comentada\nOPENAI_API_KEY=a\nOPENAI_API_KEY_2=b\nexport  OTRA=c\n";
        assert_eq!(
            strip_env_line(env, "OPENAI_API_KEY").as_deref(),
            Some("# OPENAI_API_KEY=comentada\nOPENAI_API_KEY_2=b\nexport  OTRA=c\n")
        );
        assert_eq!(
            strip_env_line(env, "OTRA").as_deref(),
            Some("# OPENAI_API_KEY=comentada\nOPENAI_API_KEY=a\nOPENAI_API_KEY_2=b\n")
        );
        assert_eq!(strip_env_line(env, "NO_ESTA"), None);
    }

    #[test]
    fn quitar_una_key_limpia_entorno_y_env_y_no_toca_lo_demas() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let con = tmp.path().join("a.env");
        let falta = tmp.path().join("no-existe.env");
        std::fs::write(&con, "GROQ_API_KEY=x\r\nOTRA=y\r\n").expect("env");
        let llamadas = std::cell::RefCell::new(Vec::new());
        std::env::set_var("GROQ_API_KEY", "x");
        remove_env_key_with("GROQ_API_KEY", &[con.clone(), falta.clone()], |k| {
            llamadas.borrow_mut().push(k.to_string());
            Ok(())
        })
        .expect("quitar");
        assert_eq!(*llamadas.borrow(), ["GROQ_API_KEY"]);
        assert_eq!(std::fs::read_to_string(&con).expect("env"), "OTRA=y\r\n");
        assert!(!falta.exists(), "un .env ausente no se crea");
        assert!(std::env::var("GROQ_API_KEY").is_err());
    }

    #[test]
    fn quitar_rechaza_nombres_fuera_de_la_lista_sin_tocar_nada() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let env = tmp.path().join("a.env");
        std::fs::write(&env, "PATH=x\n").expect("env");
        let err = remove_env_key_with("PATH", std::slice::from_ref(&env), |_| {
            panic!("no debe llamarse")
        })
        .unwrap_err();
        assert!(err.contains("PATH"), "{err}");
        assert_eq!(std::fs::read_to_string(&env).expect("env"), "PATH=x\n");
    }

    #[test]
    fn si_falla_el_entorno_de_usuario_no_se_sigue_y_se_informa() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let env = tmp.path().join("a.env");
        std::fs::write(&env, "GROQ_API_KEY=x\n").expect("env");
        let err = remove_env_key_with("GROQ_API_KEY", std::slice::from_ref(&env), |_| {
            Err("denegado".into())
        })
        .unwrap_err();
        assert_eq!(err, "denegado");
        assert!(std::fs::read_to_string(&env)
            .expect("env")
            .contains("GROQ_API_KEY"));
    }

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

    #[test]
    fn invalid_email_is_skipped_without_touching_setx() {
        // Caso negativo del buscador de papers: OPENALEX_MAILTO y
        // UNPAYWALL_EMAIL son EMAIL_KEYS — un valor sin forma de email debe
        // quedar en `skipped` sin llegar a invocar `setx` (igual que el resto
        // de casos skip de este módulo, no mutamos el entorno real en test).
        let mut keys = HashMap::new();
        keys.insert("OPENALEX_MAILTO".to_string(), "not-an-email".to_string());
        keys.insert("UNPAYWALL_EMAIL".to_string(), "@example.com".to_string());
        let result = set_env_vars_keys_inner(keys).unwrap();
        assert!(result.saved.is_empty());
        assert_eq!(result.skipped.len(), 2);
        assert!(result.skipped.contains(&"OPENALEX_MAILTO".to_string()));
        assert!(result.skipped.contains(&"UNPAYWALL_EMAIL".to_string()));
        assert!(result.errors.is_empty());
    }

    #[test]
    fn is_valid_email_accepts_plausible_addresses_and_rejects_junk() {
        assert!(is_valid_email("alumno@example.com"));
        assert!(is_valid_email("  alumno@example.com  ")); // trimmed
        assert!(!is_valid_email(""));
        assert!(!is_valid_email("no-at-sign"));
        assert!(!is_valid_email("@example.com"));
        assert!(!is_valid_email("alumno@"));
        assert!(!is_valid_email("alumno@localhost")); // sin punto en el dominio
        assert!(!is_valid_email("alumno@.com"));
    }

    #[test]
    fn research_keys_are_in_the_allowlist() {
        for key in [
            "OPENALEX_API_KEY",
            "OPENALEX_MAILTO",
            "SEMANTIC_SCHOLAR_API_KEY",
            "UNPAYWALL_EMAIL",
        ] {
            assert!(
                ALLOWED_KEYS.contains(&key),
                "{key} debe estar en ALLOWED_KEYS para que el buscador de papers pueda configurarse desde Settings"
            );
        }
    }

    #[test]
    fn get_env_keys_status_marks_email_keys_as_not_secret() {
        let rows = get_env_keys_status_inner().unwrap();
        for row in &rows {
            let expected_secret = !EMAIL_KEYS.contains(&row.env_var.as_str());
            assert_eq!(
                row.is_secret, expected_secret,
                "is_secret incorrecto para {}",
                row.env_var
            );
        }
    }

    #[test]
    fn is_allowed_key_acepta_la_lista_y_el_patron_ultron_key() {
        assert!(is_allowed_key("DEEPSEEK_API_KEY"));
        assert!(is_allowed_key("HF_TOKEN"));
        assert!(is_allowed_key("ULTRON_KEY_MI_PROXY"));
        assert!(is_allowed_key("ULTRON_KEY_A1"));
        assert!(is_allowed_key(&format!("ULTRON_KEY_{}", "X".repeat(40))));
    }

    /// Caso negativo: nombres arbitrarios o que solo se parecen al patrón.
    #[test]
    fn is_allowed_key_rechaza_nombres_arbitrarios() {
        for name in [
            "PATH",
            "USERPROFILE",
            "MY_SECRET",
            "ULTRON_KEY_",
            "ULTRON_KEY_A",
            "ULTRON_KEY_minusculas",
            "ULTRON_KEY_CON-GUION",
            "ULTRON_KEY_ESPACIO X",
            "XULTRON_KEY_AB",
            "groq_api_key",
        ] {
            assert!(!is_allowed_key(name), "{name} no debía aceptarse");
        }
        assert!(!is_allowed_key(&format!("ULTRON_KEY_{}", "X".repeat(41))));
    }

    #[test]
    fn set_rechaza_un_nombre_con_forma_casi_valida_sin_llamar_a_setx() {
        let mut keys = HashMap::new();
        keys.insert("ULTRON_KEY_x".to_string(), "valor".to_string());
        keys.insert("PATH".to_string(), "C:\\malo".to_string());
        let result = set_env_vars_keys_inner(keys).unwrap();
        assert!(result.saved.is_empty());
        assert_eq!(result.skipped.len(), 2);
    }

    #[test]
    fn parse_reg_query_coge_permitidas_y_personalizadas_con_nombre_exacto() {
        let text = "\r\nHKEY_CURRENT_USER\\Environment\r\n\
            \x20   GROQ_API_KEY    REG_SZ    gsk_abc\r\n\
            \x20   GROQ_API_KEY_EVIL    REG_SZ    malo\r\n\
            \x20   ULTRON_KEY_MI_PROXY    REG_EXPAND_SZ    sk-123 con espacio\r\n\
            \x20   ULTRON_KEY_x    REG_SZ    no\r\n\
            \x20   Path    REG_EXPAND_SZ    C:\\bin\r\n";
        let map = parse_reg_query(text);
        assert_eq!(map.get("GROQ_API_KEY").map(String::as_str), Some("gsk_abc"));
        assert_eq!(
            map.get("ULTRON_KEY_MI_PROXY").map(String::as_str),
            Some("sk-123 con espacio")
        );
        assert_eq!(map.len(), 2, "{map:?}");
    }

    /// Toda key que declara un proveedor del seed del AI Router se puede
    /// configurar desde Settings (si no, el proveedor quedaría sin key posible).
    #[test]
    fn las_keys_del_seed_del_router_estan_permitidas() {
        for p in crate::ai_router::seed::seed_providers() {
            if !p.key_env_var.is_empty() {
                assert!(
                    is_allowed_key(&p.key_env_var),
                    "{} usa {}, que no está en ALLOWED_KEYS",
                    p.id,
                    p.key_env_var
                );
            }
        }
    }
}
