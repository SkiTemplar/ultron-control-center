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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtySessionSummary {
    pub id: String,
    pub project_id: String,
    pub card_id: Option<String>,
    pub provider: String,
    pub started_at: String,
    pub status: PtyStatus,
}

pub struct PtySession {
    pub id: String,
    pub project_id: String,
    pub card_id: Option<String>,
    pub provider: String,
    pub started_at: String,
    pub status: PtyStatus,
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    /// Ring buffer of raw output bytes captured by the reader thread.
    ///
    /// P0 bug fix (2026-05-24): the previous build emitted `pty:data:<id>`
    /// events immediately as the PTY produced output, but the frontend
    /// `EmbeddedTerminal` registers its `listen()` *after* the React mount
    /// has finished and the Tauri IPC handshake completes (tens to hundreds
    /// of ms). The first burst of output from Claude/Codex/Gemini — the TUI
    /// splash, banner and entire initial paint — was emitted into a void:
    /// the listener wasn't subscribed yet, so the chunks were lost forever.
    /// TUIs don't periodically repaint, so the terminal stayed blank.
    ///
    /// Fix: capture every byte the reader produces into this buffer and
    /// HOLD live emission until the frontend calls `pty_replay`. The
    /// replay call returns the buffered bytes and flips `subscribed=true`,
    /// after which the reader thread starts emitting `pty:data:<id>`
    /// events in real time. This way there is exactly one path bytes can
    /// reach the frontend — first as replay, then as live events — with
    /// no duplication and no loss. Capped at 256 KiB to bound memory;
    /// older bytes are dropped from the front when full.
    pub output_buffer: Vec<u8>,
    /// Has the frontend subscribed via `pty_replay`? While false, the
    /// reader thread captures bytes into `output_buffer` but does NOT
    /// emit `pty:data:<id>` events. Once true, the reader switches to
    /// live emission for every subsequent chunk.
    pub subscribed: bool,
}

/// Maximum size of the per-session output ring buffer (256 KiB).
pub const PTY_REPLAY_BUFFER_MAX: usize = 256 * 1024;

impl PtySession {
    pub fn summary(&self) -> PtySessionSummary {
        PtySessionSummary {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            card_id: self.card_id.clone(),
            provider: self.provider.clone(),
            started_at: self.started_at.clone(),
            status: self.status.clone(),
        }
    }
}

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
