// mar.ia — cerrar de verdad: quien manda a parar a quien, y en que orden.
//
// EL PROBLEMA QUE RESUELVE (reportado el 2026-09-21): "cuando cierro la
// aplicacion, el modelo termina de responder y reproduce la respuesta por voz
// aunque ya esta cerrada", y "incluso cerrando desde el icono minimizado
// quedan procesos abiertos".
//
// Lo que habia: al salir solo se hacia `pty::kill_all_inner()` (las terminales)
// y `proxy_stop_inner()`. Todo lo demas sobrevivia — el sidecar de voz el
// primero, y con el su PowerShell de sintesis, que es quien seguia hablando.
//
// PROPIEDAD (ownership), que es la parte que no se puede improvisar:
//
//   SIEMPRE nuestro — lo arranca mar.ia y no sirve a nadie mas:
//     * el sidecar de voz (python maria_voice.py) y su arbol
//     * el hook de teclado de `//maria`
//     * el servidor del movil
//     * las terminales embebidas (PTY)
//     * el proxy de free-tier
//
//   NUESTRO SOLO SI LO ARRANCAMOS NOSOTROS:
//     * Qdrant — `qdrant_auto_launch` lo levanta unicamente si no estaba. Si
//       ya corria, es del usuario y se queda.
//
//   NUNCA NUESTRO, aunque mar.ia los use:
//     * Ollama — el usuario lo tiene como servicio y lo usa por su cuenta.
//       Matarlo al cerrar una app que solo es cliente seria un abuso.
//     * Tailscale — es un servicio del sistema. mar.ia solo LEE su estado
//       (ver `maria_tailscale`), no lo arranca jamas.
//
// Regla: matar por nombre de ejecutable esta PROHIBIDO aqui. Se guarda el PID
// de lo que arrancamos y se mata ese PID (y su arbol), nada mas.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Un proceso que arranco mar.ia y que le toca cerrar.
#[derive(Debug, Clone)]
pub struct Propio {
    /// Para el log. No se usa para buscar ni para matar.
    pub nombre: &'static str,
    pub pid: u32,
}

static PROPIOS: Mutex<Vec<Propio>> = Mutex::new(Vec::new());

/// El cierre ya ha empezado.
///
/// Lo consulta todo lo que pueda producir efectos visibles (locutar, escribir
/// con el teclado, contestar): una respuesta que llega tarde no puede sonar
/// cuando la ventana ya no esta.
static APAGANDO: AtomicBool = AtomicBool::new(false);

/// ¿Se esta cerrando la aplicacion?
#[must_use]
pub fn apagando() -> bool {
    APAGANDO.load(Ordering::SeqCst)
}

/// Apunta un proceso como propio. Idempotente por PID.
pub fn registrar(nombre: &'static str, pid: u32) {
    if pid == 0 {
        return;
    }
    let mut g = PROPIOS.lock().unwrap_or_else(|e| e.into_inner());
    if g.iter().any(|p| p.pid == pid) {
        return;
    }
    tracing::info!(proceso = nombre, pid, "apagado: registrado como propio");
    g.push(Propio { nombre, pid });
}

/// Olvida un proceso (murio por su cuenta o lo paro quien lo arranco).
pub fn olvidar(pid: u32) {
    let mut g = PROPIOS.lock().unwrap_or_else(|e| e.into_inner());
    g.retain(|p| p.pid != pid);
}

/// Lo que hay registrado ahora mismo. Para la pantalla de diagnostico.
#[must_use]
pub fn registrados() -> Vec<Propio> {
    PROPIOS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Mata un proceso propio y su arbol. Publico para quien tenga su propio
/// handle y quiera asegurarse de llevarse a los nietos.
pub fn matar_propio(pid: u32) -> bool {
    matar_arbol(pid)
}

/// Mata un proceso Y SU ARBOL.
///
/// El arbol importa: el sidecar de voz lanza PowerShell para sintetizar, y
/// matar solo al padre deja al nieto hablando solo. Eso es literalmente el
/// fallo que se reporto.
#[cfg(windows)]
fn matar_arbol(pid: u32) -> bool {
    crate::proc::oculto("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn matar_arbol(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Secuencia de cierre. Idempotente: llamarla dos veces no hace dano.
///
/// El orden no es casual — primero lo que produce sonido o escribe en la
/// pantalla de otros programas, y al final los servicios de datos:
///
///   1. marcar que se cierra (corta las respuestas en vuelo)
///   2. voz: sidecar + su arbol (ahi va el TTS)
///   3. teclado global (`//maria`)
///   4. servidor del movil
///   5. terminales embebidas
///   6. proxy
///   7. procesos propios que queden (Qdrant si lo arrancamos nosotros)
pub fn apagar() {
    if APAGANDO.swap(true, Ordering::SeqCst) {
        tracing::debug!("apagado: ya estaba en marcha");
        return;
    }
    tracing::info!("apagado: empieza");

    // 2. La voz, lo primero: es lo unico que puede seguir sonando.
    crate::maria_voice::parar_para_apagado();

    // 3. El hook de teclado deja de escribir en otros programas.
    crate::maria_teclado::parar();

    // 4. El servidor del movil deja de aceptar peticiones.
    crate::maria_web::stop();

    // 5. Las terminales embebidas.
    crate::pty::kill_all_inner();

    // 6. El proxy de free-tier.
    let _ = crate::proxy::proxy_stop_inner();

    // 7. Lo que hayamos arrancado y siga vivo.
    let pendientes = {
        let mut g = PROPIOS.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *g)
    };
    for p in pendientes {
        let ok = matar_arbol(p.pid);
        tracing::info!(proceso = p.nombre, pid = p.pid, ok, "apagado: proceso propio");
    }

    tracing::info!("apagado: terminado");
}

/// Lo que mar.ia tiene abierto y le tocaria cerrar.
///
/// Punto de consumo del registro: sin esto, "estos procesos son mios" seria
/// un dato que nadie mira (mandamiento 12). Lo pinta Ajustes > Sistema.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProcesoPropio {
    pub nombre: String,
    pub pid: u32,
    /// Sigue vivo ahora mismo.
    pub vivo: bool,
}

/// ¿Vive ese PID? Sin matar nada: `taskkill` con `/F` no, aqui solo se mira.
#[cfg(windows)]
fn vive(pid: u32) -> bool {
    crate::proc::oculto("tasklist.exe")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn vive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

#[tauri::command]
pub async fn maria_procesos_propios() -> Result<Vec<ProcesoPropio>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        registrados()
            .into_iter()
            .map(|p| ProcesoPropio {
                nombre: p.nombre.to_string(),
                pid: p.pid,
                vivo: vive(p.pid),
            })
            .collect()
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registrar_es_idempotente_por_pid() {
        olvidar(424_242);
        registrar("prueba", 424_242);
        registrar("prueba", 424_242);
        let n = registrados().iter().filter(|p| p.pid == 424_242).count();
        assert_eq!(n, 1, "el mismo pid no puede apuntarse dos veces");
        olvidar(424_242);
        assert!(registrados().iter().all(|p| p.pid != 424_242));
    }

    #[test]
    fn el_pid_cero_no_se_registra() {
        // Caso negativo, y de los peligrosos: en Windows el PID 0 es el
        // proceso inactivo del sistema. Registrarlo seria pedir un taskkill
        // contra el nucleo.
        let antes = registrados().len();
        registrar("basura", 0);
        assert_eq!(registrados().len(), antes);
    }
}
