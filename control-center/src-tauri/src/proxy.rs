// ULTRON Control Center — Proxy lifecycle manager
//
// Gestiona el ciclo de vida del proxy local `ultron-proxy.exe` que implementa
// la API Anthropic y reenvía a providers OpenAI-compatibles (NVIDIA NIM,
// OpenRouter, Groq, DeepSeek, etc.). Las sesiones Claude se enrutan a este
// proxy poniendo `ANTHROPIC_BASE_URL=http://127.0.0.1:8082`.
//
// Diseño:
//   - Binario buscado en tres rutas (junto al exe / target/release /
//     ~/.ultron/proxy/). Si no se encuentra, proxy_start devuelve Err claro.
//   - El Child se guarda en un OnceLock<Mutex<Option<Child>>> de proceso.
//     proxy_start es idempotente: si ya hay un proceso vivo, no relanza.
//   - proxy_stop mata el proceso y libera el slot. Se llama también desde
//     el handler de salida de Tauri para no dejar :8082 huerfano.
//   - proxy_health hace un GET corto a http://127.0.0.1:8082 con timeout 1s.
//   - Las API keys (NVIDIA_NIM_API_KEY, OPENROUTER_API_KEY, etc.) se pasan
//     como variables de entorno al proceso hijo; NUNCA se loguean.
//
// Seguridad:
//   - Whitelist de keys copiada de env_keys::ALLOWED_KEYS mas las nuevas.
//   - Los valores de env no se incluyen en ningun mensaje de error o log.
//   - Sin codigo unsafe.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

// ---------------------------------------------------------------------------
// Keys que el proxy necesita como env. Subconjunto del ALLOWED_KEYS total.
// ---------------------------------------------------------------------------

/// Variables de entorno reenviadas al proceso proxy. Se leen desde el env
/// del proceso actual (que ya las cargo desde ~/.ultron/.env via dotenvy).
const PROXY_ENV_KEYS: &[&str] = &[
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "NVIDIA_NIM_API_KEY",
    "OPENROUTER_API_KEY",
    // Incluimos tambien las principales por si el proxy las necesita
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
];

/// Puerto fijo del proxy local.
pub const PROXY_PORT: u16 = 8082;

/// Base URL que las sesiones deben usar cuando el proxy esta activo.
pub const PROXY_BASE_URL: &str = "http://127.0.0.1:8082";

// ---------------------------------------------------------------------------
// Estado global del proceso proxy
// ---------------------------------------------------------------------------

static PROXY_CHILD: OnceLock<Mutex<Option<std::process::Child>>> = OnceLock::new();

fn proxy_slot() -> &'static Mutex<Option<std::process::Child>> {
    PROXY_CHILD.get_or_init(|| Mutex::new(None))
}

// ---------------------------------------------------------------------------
// Busqueda del binario
// ---------------------------------------------------------------------------

/// Busca `ultron-proxy.exe` en (por orden de prioridad):
///   1. Directorio del ejecutable actual.
///   2. `<exe_dir>/../../target/release/` (dev build).
///   3. `~/.ultron/proxy/ultron-proxy.exe`.
///
/// Devuelve la primera ruta que exista en disco.
pub fn find_proxy_binary() -> Option<PathBuf> {
    let candidates = proxy_binary_candidates();
    candidates.into_iter().find(|p| p.exists())
}

fn proxy_binary_candidates() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();

    // 1. Junto al ejecutable actual.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            v.push(dir.join("ultron-proxy.exe"));
        }
    }

    // 2. target/release/ (util en dev con `cargo run`).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            v.push(dir.join("..").join("..").join("target").join("release").join("ultron-proxy.exe"));
        }
    }

    // 3. ~/.ultron/proxy/
    if let Some(home) = dirs::home_dir() {
        v.push(home.join(".ultron").join("proxy").join("ultron-proxy.exe"));
    }

    v
}

// ---------------------------------------------------------------------------
// Estado publico para la UI
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProxyStatus {
    /// Proceso proxy corriendo y respondiendo.
    Running,
    /// Proceso arrancado pero sin responder al health check todavia.
    Starting,
    /// Proceso no arrancado (o ya termino).
    Stopped,
    /// Binario no encontrado en ninguna de las rutas candidatas.
    BinaryMissing,
    /// Error interno (mensaje adjunto).
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyHealth {
    pub status: ProxyStatus,
    /// Mensaje de error o informacion adicional; None cuando todo va bien.
    pub message: Option<String>,
    /// Rutas donde se busco el binario (para diagnostico).
    pub searched_paths: Vec<String>,
}

// ---------------------------------------------------------------------------
// proxy_start
// ---------------------------------------------------------------------------

/// Arranca el proceso proxy si no esta ya corriendo. Idempotente.
///
/// Las variables de entorno de PROXY_ENV_KEYS se leen del proceso actual
/// y se pasan al hijo. Valores no configurados simplemente no se propagan
/// (el proxy usara sus propios defaults).
///
/// # Errors
/// Devuelve `Err` con descripcion human-readable si:
///   - El binario no se encuentra.
///   - `std::process::Command::spawn` falla.
pub fn proxy_start_inner() -> Result<ProxyHealth, String> {
    let mut slot = proxy_slot()
        .lock()
        .map_err(|e| format!("proxy mutex poisoned: {e}"))?;

    // Idempotencia: si hay un Child y sigue vivo, no relanzamos.
    if let Some(child) = slot.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                // Sigue vivo.
                return Ok(ProxyHealth {
                    status: ProxyStatus::Starting,
                    message: Some("proxy ya estaba en ejecucion".to_string()),
                    searched_paths: vec![],
                });
            }
            _ => {
                // Termino o error: limpiar slot y relanzar.
                *slot = None;
            }
        }
    }

    // Detectar proxy huerfano de una sesion anterior: intentamos hacer bind
    // al puerto. Si falla con AddrInUse y el slot esta vacio (no hay Child
    // nuestro), significa que hay un proceso externo ocupando el puerto.
    // Soltamos el listener inmediatamente si el bind funciona.
    //
    // TODO(windows-job-object): para garantia absoluta de limpieza en crash/kill,
    // asignar el proceso hijo a un Windows Job Object con
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Ver:
    // https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
    match std::net::TcpListener::bind(format!("127.0.0.1:{PROXY_PORT}")) {
        Ok(_listener) => {
            // Puerto libre — el bind funciona, soltamos el listener (drop
            // implicito) y continuamos con el spawn normal.
        }
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Puerto ocupado pero sin Child nuestro: proxy huerfano externo.
            return Err(format!(
                "puerto {PROXY_PORT} ya en uso (posible proxy huerfano de una sesion anterior); \
                 cierralo manualmente antes de reiniciar"
            ));
        }
        Err(_) => {
            // Otro error de red (permisos, etc.) — lo ignoramos y dejamos que
            // el spawn falle con su propio mensaje si hay problema real.
        }
    }

    let binary = match find_proxy_binary() {
        Some(p) => p,
        None => {
            let paths: Vec<String> = proxy_binary_candidates()
                .iter()
                .map(|p| p.display().to_string())
                .collect();
            return Err(format!(
                "binario del proxy no encontrado en: {}",
                paths.join(", ")
            ));
        }
    };

    // Construir el Command con las env keys del proceso actual.
    let mut cmd = std::process::Command::new(&binary);
    cmd.arg(format!("--port={PROXY_PORT}"))
        .arg("--bind=127.0.0.1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    // Pasar keys de proveedor al proceso hijo.
    for key in PROXY_ENV_KEYS {
        if let Ok(val) = std::env::var(key) {
            if !val.trim().is_empty() {
                cmd.env(key, val);
            }
        }
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("no se pudo arrancar el proxy ({}): {e}", binary.display()))?;

    *slot = Some(child);

    Ok(ProxyHealth {
        status: ProxyStatus::Starting,
        message: None,
        searched_paths: vec![binary.display().to_string()],
    })
}

// ---------------------------------------------------------------------------
// proxy_stop
// ---------------------------------------------------------------------------

/// Detiene el proceso proxy si esta corriendo. Idempotente.
/// Se llama tambien desde el handler de salida de Tauri.
pub fn proxy_stop_inner() -> Result<(), String> {
    let mut slot = proxy_slot()
        .lock()
        .map_err(|e| format!("proxy mutex poisoned: {e}"))?;

    if let Some(mut child) = slot.take() {
        child
            .kill()
            .map_err(|e| format!("kill proxy: {e}"))?;
        // Recogemos el exit status para evitar zombie en Windows.
        let _ = child.wait();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// proxy_health
// ---------------------------------------------------------------------------

/// Comprueba si el proxy responde en http://127.0.0.1:8082.
/// GET con timeout de 1 segundo; sin tokens, sin autenticacion.
pub fn proxy_health_inner() -> ProxyHealth {
    let searched_paths: Vec<String> = proxy_binary_candidates()
        .iter()
        .map(|p| p.display().to_string())
        .collect();

    // Primero verificamos si el proceso esta vivo en nuestra slot.
    {
        let Ok(mut slot) = proxy_slot().lock() else {
            return ProxyHealth {
                status: ProxyStatus::Error,
                message: Some("mutex poisoned".to_string()),
                searched_paths,
            };
        };

        if let Some(child) = slot.as_mut() {
            match child.try_wait() {
                Ok(None) => {} // Sigue corriendo; continuamos al HTTP check.
                Ok(Some(exit)) => {
                    *slot = None;
                    // Persist disabled so sessions.rs stops routing to a dead proxy.
                    let _ = persist_proxy_state(false);
                    return ProxyHealth {
                        status: ProxyStatus::Stopped,
                        message: Some(format!("proceso termino con codigo: {:?}", exit.code())),
                        searched_paths,
                    };
                }
                Err(e) => {
                    return ProxyHealth {
                        status: ProxyStatus::Error,
                        message: Some(format!("try_wait error: {e}")),
                        searched_paths,
                    };
                }
            }
        } else {
            // Sin binario disponible ni proceso corriendo.
            let bin_exists = find_proxy_binary().is_some();
            return ProxyHealth {
                status: if bin_exists {
                    ProxyStatus::Stopped
                } else {
                    ProxyStatus::BinaryMissing
                },
                message: None,
                searched_paths,
            };
        }
    }

    // HTTP health check (corto, no gasta tokens).
    let url = format!("http://127.0.0.1:{PROXY_PORT}");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(1))
        .build();

    match agent.get(&url).call() {
        Ok(_) | Err(ureq::Error::Status(_, _)) => {
            // Cualquier respuesta HTTP (incluso 4xx) = el proxy esta escuchando.
            ProxyHealth {
                status: ProxyStatus::Running,
                message: None,
                searched_paths,
            }
        }
        Err(e) => {
            // Connection refused / timeout = proceso arrancando o caido.
            ProxyHealth {
                status: ProxyStatus::Starting,
                message: Some(format!("health check: {e}")),
                searched_paths,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Persistencia del estado del toggle en proxy-state.json
// ---------------------------------------------------------------------------

/// Ruta de `~/.ultron/cockpit/proxy-state.json`.
fn proxy_state_path() -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron").join("cockpit").join("proxy-state.json"))
        .ok_or_else(|| "No HOME dir".to_string())
}

/// Escribe `{"enabled": <bool>}` atomicamente (tmp + rename).
fn persist_proxy_state(enabled: bool) -> Result<(), String> {
    let path = proxy_state_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create proxy cockpit dir: {e}"))?;
    }
    let body = serde_json::json!({ "enabled": enabled, "updated_at": Utc::now() });
    let bytes = serde_json::to_vec_pretty(&body).map_err(|e| format!("serialize proxy state: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write proxy state tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename proxy state: {e}"))?;
    Ok(())
}

/// Lee el estado persistido. Devuelve `false` si el archivo no existe.
pub fn read_proxy_state_enabled() -> bool {
    let Ok(path) = proxy_state_path() else { return false; };
    let Ok(bytes) = std::fs::read(&path) else { return false; };
    let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return false; };
    val.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Arranca el proxy local. Idempotente.
/// Persiste `{"enabled": true}` en `~/.ultron/cockpit/proxy-state.json`.
#[tauri::command]
pub fn proxy_start() -> Result<ProxyHealth, String> {
    let result = proxy_start_inner()?;
    // Persistir de forma best-effort; fallo de escritura no bloquea el arranque.
    let _ = persist_proxy_state(true);
    Ok(result)
}

/// Detiene el proxy local. Idempotente.
/// Persiste `{"enabled": false}` en `~/.ultron/cockpit/proxy-state.json`.
#[tauri::command]
pub fn proxy_stop() -> Result<(), String> {
    proxy_stop_inner()?;
    let _ = persist_proxy_state(false);
    Ok(())
}

/// Devuelve el estado de salud del proxy para que la UI lo pinte.
#[tauri::command]
pub fn proxy_health() -> ProxyHealth {
    proxy_health_inner()
}

/// Devuelve el valor del toggle persistido en `proxy-state.json`.
/// El frontend lo invoca al montar el toggle para hidratarlo sin necesidad
/// de llamar a `proxy_health` (que hace un health-check HTTP).
///
/// Firma: `proxy_state_enabled() -> bool`
#[tauri::command]
pub fn proxy_state_enabled() -> bool {
    read_proxy_state_enabled()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_not_empty() {
        let c = proxy_binary_candidates();
        assert!(!c.is_empty(), "debe haber al menos una ruta candidata");
    }

    #[test]
    fn health_returns_binary_missing_when_not_installed() {
        // En CI no hay proxy instalado; esperamos BinaryMissing o Stopped.
        let h = proxy_health_inner();
        assert!(
            matches!(h.status, ProxyStatus::BinaryMissing | ProxyStatus::Stopped),
            "estado inesperado sin binario: {:?}",
            h.status
        );
    }

    #[test]
    fn proxy_env_keys_whitelist_non_empty() {
        assert!(!PROXY_ENV_KEYS.is_empty());
        assert!(PROXY_ENV_KEYS.contains(&"NVIDIA_NIM_API_KEY"));
        assert!(PROXY_ENV_KEYS.contains(&"OPENROUTER_API_KEY"));
    }

    #[test]
    fn proxy_stop_idempotent_when_not_running() {
        // No debe panicar si se llama sin proceso activo.
        assert!(proxy_stop_inner().is_ok());
    }
}
