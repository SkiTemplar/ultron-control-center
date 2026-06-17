// pty/registry.rs — Global session registry and timestamp/ID helpers.

use super::types::{PtySession, PtyStatus};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static SESSIONS: OnceLock<Mutex<HashMap<String, PtySession>>> = OnceLock::new();

pub(super) fn registry() -> &'static Mutex<HashMap<String, PtySession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{}", secs)
}

pub(super) fn new_ulid() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    format!("pty-{t}-{n}")
}

/// Kill every tracked session and mark them as `Killed`. Used on clean shutdown.
pub fn kill_all_inner() {
    if let Ok(mut reg) = registry().lock() {
        for s in reg.values_mut() {
            let _ = s.child.kill();
            s.status = PtyStatus::Killed;
        }
    }
}
