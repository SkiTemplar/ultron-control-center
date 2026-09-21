// mar.ia — cerrar de verdad: quien manda a parar a quien, y en que orden.
//
// EL PROBLEMA QUE RESUELVE (reportado el 2026-09-21): "cuando cierro la
// aplicacion, el modelo termina de responder y reproduce la respuesta por voz
// aunque ya esta cerrada", y "incluso cerrando desde el icono minimizado
// quedan procesos abiertos".
//
// Lo que habia: al salir solo se hacia `pty::kill_all_inner()` (las
// terminales). Todo lo demas sobrevivia — el sidecar de voz el
// primero, y con el su PowerShell de sintesis, que es quien seguia hablando.
//
// PROPIEDAD (ownership), que es la parte que no se puede improvisar:
//
//   SIEMPRE nuestro — lo arranca mar.ia y no sirve a nadie mas:
//     * el sidecar de voz (python maria_voice.py) y su arbol
//     * el hook de teclado de `//maria`
//     * el servidor del movil
//     * las terminales embebidas (PTY)
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
///   6. procesos propios que queden (Qdrant si lo arrancamos nosotros)
pub fn apagar() {
    if APAGANDO.swap(true, Ordering::SeqCst) {
        tracing::debug!("apagado: ya estaba en marcha");
        return;
    }
    tracing::info!("apagado: empieza");

    // 2. La voz, lo primero: es lo unico que puede seguir sonando.
    crate::maria::voice::parar_para_apagado();

    // 3. El hook de teclado deja de escribir en otros programas.
    crate::maria::teclado::parar();

    // 4. El servidor del movil deja de aceptar peticiones.
    crate::maria::web::stop();

    // 5. Las terminales embebidas.
    crate::pty::kill_all_inner();

    // La VRAM, libre. Con residencia del modelo local (Router -> Criterio) el
    // modelo puede seguir cargado cuando se cierra: Ollama no es nuestro y se
    // queda, pero lo que mar.ia cargo en la GPU se va con mar.ia.
    crate::maria::local::descargar();

    // 6. Lo que hayamos arrancado y siga vivo.
    let pendientes = {
        let mut g = PROPIOS.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *g)
    };
    for p in pendientes {
        let ok = matar_arbol(p.pid);
        tracing::info!(
            proceso = p.nombre,
            pid = p.pid,
            ok,
            "apagado: proceso propio"
        );
    }

    tracing::info!("apagado: terminado");
}

#[cfg(not(windows))]
fn vive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}
