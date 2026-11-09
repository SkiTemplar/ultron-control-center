// pty/mod.rs — ULTRON Control Center 2.0 — Internal PTY runtime.
//
// Spawns `claude` / `codex` (or arbitrary commands) inside a PTY via
// portable-pty. Consumidores: la ventana ULTRON Sessions (chat sobre un PTY
// oculto; único llamante de `spawn_with`) y el cierre de la app (kill_all).
// El RunBatch del kanban, que también lanzaba aquí, se retiró el 2026-10-17.
//
// Contrato de estabilidad de Sessions (§3.2, §3.4): cada PTY tiene un
// escritor serializado con garantías G1-G4, un hilo esperador que detecta la
// salida del proceso por su handle (ConPTY no da EOF fiable), un Job Object
// con todo el árbol de procesos y su estado fuera del lock global.
//
// Submodules:
//   types    — tipos del runtime y estado compartido de una sesión
//   registry — registro global (solo `Arc`, sin E/S bajo el lock)
//   escritor — hilo escritor por PTY con G1-G4
//   salida   — esperador del proceso, kill y liberación fuera del lock
//   arbol    — Job Object y recorrido de descendientes (Windows)
//   spawn    — cwd resolution, PATH probing, command building
//   ops      — lanzamiento (spawn_with / lanzar) y lector
//   io       — escribir / redimensionar / enganchar / matar (Sesiones)

pub(crate) mod arbol;
pub(crate) mod escritor;
pub(crate) mod io;
pub(crate) mod ops;
pub(crate) mod registry;
pub(crate) mod salida;
pub(crate) mod spawn;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_salida;
pub(crate) mod types;

pub use ops::{spawn_with, SpawnOptions};
pub use registry::kill_all_inner;
