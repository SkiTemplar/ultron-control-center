// pty/io.rs — Escritura, redimensionado, enganche y cierre de un PTY vivo.
//
// Toda escritura pasa por el escritor serializado del PTY (`escritor.rs`). El
// registro global solo se toca para clonar el `Arc` de la sesión: ninguna
// función mantiene un lock global durante E/S (`SC-08`).

use portable_pty::PtySize;

use super::escritor::{ErrorEscritura, Trabajo};
use super::registry;
use super::types::bloquear;

pub use super::salida::{corriendo, forget, kill};

/// Envía un trabajo al escritor del PTY y espera su resultado.
pub fn enviar(id: &str, t: Trabajo) -> Result<(), ErrorEscritura> {
    let s = registry::get(id).map_err(|_| ErrorEscritura::Terminada)?;
    s.escritor.enviar(t)
}

/// Rechaza dimensiones nulas o absurdas (también para la pantalla emulada,
/// que se redimensiona antes que el PTY).
pub fn validar_tamano(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 500 {
        return Err(format!("tamaño de terminal no válido: {cols}x{rows}"));
    }
    Ok(())
}

/// Cambia el tamaño del PTY. Rechaza dimensiones nulas o absurdas.
pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    validar_tamano(cols, rows)?;
    let s = registry::get(id)?;
    let master = bloquear(&s.master);
    let m = master
        .as_ref()
        .ok_or_else(|| "la sesión ya terminó".to_string())?;
    m.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
    .map_err(|e| format!("no se pudo redimensionar el PTY: {e}"))
}

/// Activa la emisión en vivo y devuelve una copia del búfer acumulado.
pub fn attach(id: &str) -> Result<Vec<u8>, String> {
    let s = registry::get(id)?;
    let mut sal = bloquear(&s.salida);
    sal.subscribed = true;
    Ok(sal.buffer.clone())
}

/// true si la terminal en superposición está enganchada.
pub fn attached(id: &str) -> bool {
    registry::get(id).is_ok_and(|s| bloquear(&s.salida).subscribed)
}

/// Copia del búfer acumulado sin tocar la emisión en vivo. Error si el PTY
/// ya terminó.
#[cfg(test)]
pub fn snapshot(id: &str) -> Result<Vec<u8>, String> {
    let s = registry::get(id)?;
    if !s.running() {
        return Err("la sesión ya terminó".to_string());
    }
    let sal = bloquear(&s.salida);
    Ok(sal.buffer.clone())
}

/// Desactiva la emisión en vivo (el búfer sigue acumulando).
pub fn detach(id: &str) -> Result<(), String> {
    let s = registry::get(id)?;
    bloquear(&s.salida).subscribed = false;
    Ok(())
}
