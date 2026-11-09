// sesiones/motor_stderr.rs — Lectura de stderr de las tareas de motor: las
// últimas líneas (se añaden como evento si la tarea falla) y el vigía que
// aborta la tarea cuando el motor deja en stderr un fallo final y no sale
// (OpenCode con los reintentos agotados; `opencode_parse::fallo_stderr`
// ignora los errores que el motor aún reintentará).

use std::io::{BufRead, BufReader};
use std::time::Duration;

const STDERR_TAIL_LINES: usize = 20;
/// Margen tras un fallo detectado en stderr antes de matar el motor.
const GRACIA_FALLO: Duration = Duration::from_secs(2);

/// Detecta en una línea de stderr un fallo que deja el motor colgado (OpenCode
/// no sale cuando falla el proveedor) y devuelve la causa.
pub type VigiaStderr = fn(&str) -> Option<String>;

/// Últimas líneas de stderr. Con vigía, el primer fallo que detecta aborta la
/// tarea pasado `GRACIA_FALLO` (si el motor sale solo, manda su salida).
pub fn cola(id: String, e: std::process::ChildStderr, vigia: Option<VigiaStderr>) -> String {
    let mut tail: Vec<String> = Vec::new();
    let mut avisado = false;
    for l in BufReader::new(e).lines().map_while(Result::ok) {
        if let Some(causa) = vigia.filter(|_| !avisado).and_then(|v| v(&l)) {
            avisado = true;
            let id = id.clone();
            std::thread::spawn(move || {
                std::thread::sleep(GRACIA_FALLO);
                super::motor::abortar(&id, |_| causa);
            });
        }
        tail.push(l);
        if tail.len() > STDERR_TAIL_LINES {
            tail.remove(0);
        }
    }
    tail.join("\n")
}
