// pty/types.rs — Core PTY data types and session struct.

use portable_pty::MasterPty;
use serde::{Deserialize, Serialize};
use std::io::Write;

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

pub struct PtySession {
    /// Session identity. Retenido aunque `.summary()` (su único lector) se
    /// retiró junto a `pty::list_inner` (cat cleanup 2026-09-11, sin
    /// consumidor tras borrar `project_invoke_agent_from_session`) — sigue
    /// siendo la clave conceptual de la sesión en el registro.
    #[allow(dead_code)]
    pub id: String,
    #[allow(dead_code)]
    pub project_id: String,
    #[allow(dead_code)]
    pub card_id: Option<String>,
    #[allow(dead_code)]
    pub provider: String,
    #[allow(dead_code)]
    pub started_at: String,
    pub status: PtyStatus,
    /// Master handle. Nunca se lee tras el spawn (el resize del terminal
    /// embebido se retiró), pero es RAII load-bearing: si se dropea, el PTY
    /// se cierra y el proceso hijo pierde su terminal. NO quitar.
    #[allow(dead_code)]
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    /// Ring buffer of raw output bytes captured by the reader thread.
    ///
    /// The reader thread appends every chunk here; `capture_output_inner`
    /// (delegate polling) reads windows of it by offset. Capped at 256 KiB
    /// to bound memory; older bytes are dropped from the front when full.
    pub output_buffer: Vec<u8>,
    /// Live-emission flag. While false the reader thread captures bytes
    /// into `output_buffer` but does NOT emit `pty:data:<id>` events.
    /// The embedded terminal (whose `pty_replay` command flipped this to
    /// true) was retired 2026-07, so today this stays false and consumers
    /// poll the buffer instead.
    pub subscribed: bool,
}

/// Maximum size of the per-session output ring buffer (256 KiB).
pub const PTY_REPLAY_BUFFER_MAX: usize = 256 * 1024;

/// Result of a [`super::ops::capture_output_inner`] call.
#[derive(Debug, Serialize, Deserialize)]
pub struct CaptureResult {
    /// Base64-encoded raw PTY bytes from `since_offset` to `new_offset`.
    /// Empty string when there are no new bytes.
    pub data_b64: String,
    /// The new offset to pass as `since_offset` on the next poll.
    pub new_offset: usize,
    /// Current session status; `None` when the session is unknown.
    pub session_status: Option<PtyStatus>,
}
