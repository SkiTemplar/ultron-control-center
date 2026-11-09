// pty/salida.rs — Salida del proceso, kill y liberación de un PTY (contrato
// de estabilidad, §3.4; `comandos:M2`, `seguridad-robustez:F3`, `F4`).
//
// Con ConPTY el pipe de salida no se cierra al terminar el hijo mientras la
// pseudoconsola siga abierta: el EOF del lector no es una señal fiable. Un
// hilo esperador por PTY bloquea en `wait()` sobre el `Child` (fuera de todo
// lock) y, al salir, marca `Exited`, cierra el escritor (G4), llama a
// `on_exit` y suelta el maestro en otro hilo. `kill` mata el árbol entero
// (Job Object) y `forget` saca la entrada del registro y la suelta fuera del
// lock.

use std::sync::Arc;

use portable_pty::Child;

use super::registry;
use super::types::{bloquear, PtySession, PtyStatus};

/// Callback invocado una sola vez con el código de salida del proceso hijo
/// (`-1` si se mató desde la app o si `wait()` falló).
pub type OnExit = Box<dyn FnOnce(i32) + Send + 'static>;

/// Lanza el hilo esperador del proceso de `s`.
pub(super) fn lanzar_esperador(
    s: Arc<PtySession>,
    child: Box<dyn Child + Send + Sync>,
    on_exit: OnExit,
) -> std::io::Result<()> {
    let nombre = format!("pty-esperador-{}", s.id);
    std::thread::Builder::new()
        .name(nombre)
        .spawn(move || esperar(&s, child, on_exit))
        .map(|_| ())
}

fn esperar(s: &Arc<PtySession>, mut child: Box<dyn Child + Send + Sync>, on_exit: OnExit) {
    let code = match child.wait() {
        Ok(st) => i32::try_from(st.exit_code()).unwrap_or(-1),
        Err(e) => {
            tracing::warn!(pty = %s.id, error = %e, "wait() del PTY falló");
            -1
        }
    };
    let code = marcar_salida(s, code);
    tracing::info!(pty = %s.id, provider = %s.provider, code, "proceso del PTY terminado");
    on_exit(code);
    soltar(s);
}

/// Fija `Exited(code)` salvo que se matara desde la app (queda `Killed` y el
/// código pasa a `-1`). Cierra el escritor: a partir de aquí todo envío es
/// Err «la sesión terminó» (G4).
pub(super) fn marcar_salida(s: &PtySession, code: i32) -> i32 {
    let code = {
        let mut st = bloquear(&s.estado);
        if *st == PtyStatus::Killed {
            -1
        } else {
            *st = PtyStatus::Exited(code);
            code
        }
    };
    s.escritor.marcar_salido();
    code
}

/// Suelta el maestro (cierra la pseudoconsola), el escritor y el job en otro
/// hilo: `ClosePseudoConsole` puede bloquear y nunca se llama con un lock
/// tomado. Cerrar el job mata lo que quedara vivo del árbol
/// (`KILL_ON_JOB_CLOSE`).
pub(super) fn soltar(s: &Arc<PtySession>) {
    s.escritor.cerrar();
    let master = bloquear(&s.master).take();
    let arbol = bloquear(&s.arbol).take();
    if master.is_none() && arbol.is_none() {
        return;
    }
    let id = s.id.clone();
    let r = std::thread::Builder::new()
        .name(format!("pty-soltar-{id}"))
        .spawn(move || {
            drop(master);
            drop(arbol);
            tracing::debug!(pty = %id, "pseudoconsola y job cerrados");
        });
    if let Err(e) = r {
        tracing::warn!(error = %e, "no se pudo lanzar el hilo de cierre del PTY");
    }
}

/// Mata el árbol de procesos de `s` y lo marca `Killed`. No hace nada si ya
/// había salido.
pub(super) fn matar(s: &PtySession) -> Result<(), String> {
    {
        let mut st = bloquear(&s.estado);
        if *st != PtyStatus::Running {
            return Ok(());
        }
        *st = PtyStatus::Killed;
    }
    tracing::info!(pty = %s.id, provider = %s.provider, "matando el árbol del PTY");
    let arbol = bloquear(&s.arbol).as_ref().map(super::arbol::Arbol::matar);
    let killer = bloquear(&s.killer).as_mut().map(|k| k.kill());
    match (arbol, killer) {
        (Some(Ok(())), _) | (None, Some(Ok(()))) => Ok(()),
        (Some(Err(e)), Some(Ok(()))) => {
            tracing::warn!(pty = %s.id, error = %e, "árbol sin matar; el hijo directo sí");
            Ok(())
        }
        (Some(Err(e)), _) => Err(format!("no se pudo terminar el proceso: {e}")),
        (None, Some(Err(e))) => Err(format!("no se pudo terminar el proceso: {e}")),
        (None, None) => Err("el PTY no tiene proceso que terminar".to_string()),
    }
}

/// Mata el proceso de `id` (`Killed`).
pub fn kill(id: &str) -> Result<(), String> {
    let s = registry::get(id)?;
    matar(&s)
}

/// Retira la entrada del registro y la suelta fuera del lock. Solo si el
/// proceso ya no corre (tras `kill` o la salida natural).
pub fn forget(id: &str) {
    let Ok(s) = registry::get(id) else {
        return;
    };
    if s.running() {
        return;
    }
    if let Some(s) = registry::remove(id) {
        soltar(&s);
    }
}

/// Si el proceso de `id` sigue corriendo (`false` si ya no está registrado).
pub fn corriendo(id: &str) -> bool {
    registry::get(id).is_ok_and(|s| s.running())
}
