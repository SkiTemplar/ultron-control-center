// pty/types.rs — Tipos del runtime de PTY y estado compartido de una sesión.
//
// Desde el contrato de estabilidad (§3.2, §3.4) cada PTY vive en un
// `Arc<PtySession>` con su estado interior en mutex propios: el registro
// global solo se bloquea para buscar o quitar la entrada, nunca durante E/S.

use std::sync::{Mutex, MutexGuard};

use portable_pty::{ChildKiller, MasterPty};
use serde::{Deserialize, Serialize};

use super::arbol::Arbol;
use super::escritor::Escritor;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(tag = "kind", content = "value")]
pub enum PtyStatus {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "exited")]
    Exited(i32),
    #[serde(rename = "killed")]
    Killed,
}

/// Búfer circular de la salida y bandera de emisión en vivo.
#[derive(Debug, Default)]
pub struct Salida {
    /// Bytes crudos capturados por el lector, con tope `PTY_REPLAY_BUFFER_MAX`.
    pub buffer: Vec<u8>,
    /// Con true el lector emite cada bloque en vivo (terminal enganchada).
    pub subscribed: bool,
}

pub struct PtySession {
    pub id: String,
    pub provider: String,
    pub estado: Mutex<PtyStatus>,
    pub salida: Mutex<Salida>,
    /// Evento de emisión en vivo. `None`: formato histórico `pty:data:<id>`
    /// con `{ data }`; `Some(nombre)`: el base64 como payload plano
    /// (`sesiones://pty/<id>`).
    pub live_event: Option<String>,
    /// Único punto de escritura del PTY (`escritor.rs`).
    pub escritor: Escritor,
    /// Lado maestro. Soltarlo cierra la pseudoconsola (`ClosePseudoConsole`),
    /// así que se toma y se suelta fuera de cualquier lock (`salida.rs`).
    pub master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    pub killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    /// Job Object con el árbol de procesos (`arbol.rs`).
    pub arbol: Mutex<Option<Arbol>>,
}

/// Bloquea `m` aunque esté envenenado: los datos de estos mutex (estado,
/// búfer, handles) siguen siendo coherentes tras un pánico ajeno.
pub fn bloquear<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl PtySession {
    pub fn status(&self) -> PtyStatus {
        bloquear(&self.estado).clone()
    }

    pub fn running(&self) -> bool {
        self.status() == PtyStatus::Running
    }
}

/// Maximum size of the per-session output ring buffer (256 KiB).
pub const PTY_REPLAY_BUFFER_MAX: usize = 256 * 1024;
