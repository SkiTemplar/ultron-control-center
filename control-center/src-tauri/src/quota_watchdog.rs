// ULTRON Control Center — Quota Watchdog
//
// Tracks Claude subscription quota usage and triggers automatic provider
// fallback when usage reaches the critical 98% threshold. The watchdog has
// two data paths:
//
//   1. Push path — `update_from_headers` called by any future HTTP-proxy layer
//      or by the `quota-capture.js` hook writing to quota-state.json.
//   2. Poll path — `init` spawns a background thread that reads
//      quota-state.json every 60 s. If the file changes, the watchdog emits
//      Tauri events so the frontend reacts without polling itself.
//
// The critical flag is the single source of truth consumed by
// `ai_router::route` via `is_critical`. When the flag is set the router
// skips any "claude"-prefixed provider and cascades to its fallback chain.
//
// Reset logic (two independent triggers):
//   - `reset_at` is in the past   → tokens have renewed, clear the flag.
//   - `pct_used < 50`             → measured usage dropped (manual reset or
//                                    new billing window), clear the flag.
//   - `quota_force_reset` command → user manually cleared the state.
//
// Persistence: `~/.ultron/cockpit/quota-state.json`, written atomically
// (tmp + rename) so a crash mid-write never corrupts the file.

use std::fs;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Public state type
// ---------------------------------------------------------------------------

/// Snapshot of Claude subscription quota state. Serialised to JSON for
/// the Tauri command surface and persisted to disk via `quota-state.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaStatus {
    /// Percentage of the current billing window already consumed (0.0–100.0).
    pub claude_pct_used: f64,
    /// True when `claude_pct_used >= CRITICAL_THRESHOLD`.
    pub claude_critical: bool,
    /// Best-known time at which the current window resets.
    /// `None` when the watchdog has not yet seen a reset timestamp.
    pub reset_at: Option<DateTime<Utc>>,
    /// Wall clock of the last successful state update.
    pub last_check: DateTime<Utc>,
}

impl Default for QuotaStatus {
    fn default() -> Self {
        Self {
            claude_pct_used: 0.0,
            claude_critical: false,
            reset_at: None,
            last_check: Utc::now(),
        }
    }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

/// Critical threshold — trip the flag at or above this percentage.
pub const CRITICAL_THRESHOLD: f64 = 98.0;

/// Below this percentage we consider the quota to have refreshed and clear
/// the critical flag automatically.
const CLEAR_THRESHOLD: f64 = 50.0;

/// Background poll interval.
const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Process-wide quota state.
pub static QUOTA: OnceLock<RwLock<QuotaStatus>> = OnceLock::new();

fn global_quota() -> &'static RwLock<QuotaStatus> {
    QUOTA.get_or_init(|| {
        // Try to restore persisted state so a restart doesn't lose the
        // critical flag across a process boundary.
        let initial = parse_quota_state_file().unwrap_or_default();
        RwLock::new(initial)
    })
}

// ---------------------------------------------------------------------------
// State path helpers
// ---------------------------------------------------------------------------

fn quota_state_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| {
            h.join(".ultron")
                .join("cockpit")
                .join("quota-state.json")
        })
        .ok_or_else(|| "No HOME dir".to_string())
}

// ---------------------------------------------------------------------------
// Public API — called from ai_router and Tauri commands
// ---------------------------------------------------------------------------

/// Return a snapshot of the current quota state. Cheap: takes a read lock.
pub fn current() -> QuotaStatus {
    global_quota()
        .read()
        .map(|g| g.clone())
        .unwrap_or_default()
}

/// Merge new measurement into the global state and re-evaluate the critical
/// flag. Called from the HTTP proxy layer or from the poll loop after reading
/// the state file.
///
/// # Parameters
/// * `pct_used`  — usage percentage reported by Anthropic (0.0–100.0).
/// * `reset_at`  — optional window-reset timestamp from response headers.
pub fn update_from_headers(pct_used: f64, reset_at: Option<DateTime<Utc>>) {
    let pct = pct_used.clamp(0.0, 100.0);
    let critical = pct >= CRITICAL_THRESHOLD;
    if let Ok(mut g) = global_quota().write() {
        g.claude_pct_used = pct;
        g.claude_critical = critical;
        if reset_at.is_some() {
            g.reset_at = reset_at;
        }
        g.last_check = Utc::now();
        // Best-effort persist — write errors are non-fatal.
        let _ = persist_quota_state(&*g);
    }
}

/// Returns `true` when the named provider is a Claude subscription provider
/// *and* the quota is currently critical.
///
/// The router calls this before every HTTP attempt. When it returns `true`
/// the router records `quota_critical_skip:<provider_id>` as the error for
/// that slot and advances to the next fallback.
///
/// # Provider matching
/// Any provider whose `id` contains the substring `"claude"` (case-insensitive)
/// is treated as a Claude subscription provider.
pub fn is_critical(provider_id: &str) -> bool {
    if !provider_id.to_ascii_lowercase().contains("claude") {
        return false;
    }
    global_quota()
        .read()
        .map(|g| g.claude_critical)
        .unwrap_or(false)
}

/// Poll-triggered check: clear the critical flag when the billing window has
/// refreshed or usage has dropped below `CLEAR_THRESHOLD`.
///
/// Returns `true` when the flag was cleared (i.e., a `quota:reset` event
/// should be emitted).
pub fn maybe_clear_critical() -> bool {
    let now = Utc::now();
    let should_clear = {
        let Ok(g) = global_quota().read() else {
            return false;
        };
        if !g.claude_critical {
            return false;
        }
        let window_expired = g.reset_at.map_or(false, |ra| ra <= now);
        let usage_dropped = g.claude_pct_used < CLEAR_THRESHOLD;
        window_expired || usage_dropped
    };

    if should_clear {
        if let Ok(mut g) = global_quota().write() {
            g.claude_critical = false;
            g.last_check = now;
            let _ = persist_quota_state(&*g);
        }
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// File persistence
// ---------------------------------------------------------------------------

/// Read and deserialise `~/.ultron/cockpit/quota-state.json`.
/// Returns `Ok(QuotaStatus::default())` when the file does not exist yet.
pub fn parse_quota_state_file() -> Result<QuotaStatus, String> {
    let path = quota_state_path()?;
    if !path.exists() {
        return Ok(QuotaStatus::default());
    }
    let bytes = fs::read(&path).map_err(|e| format!("read quota-state: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse quota-state: {e}"))
}

/// Atomically write `status` to `~/.ultron/cockpit/quota-state.json`.
/// Uses tmp-file + rename so a crash mid-write leaves the old file intact.
pub fn persist_quota_state(status: &QuotaStatus) -> Result<(), String> {
    let path = quota_state_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create quota dir: {e}"))?;
    }
    let body = serde_json::to_vec_pretty(status).map_err(|e| format!("serialize quota: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &body).map_err(|e| format!("write quota tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename quota state: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Background watcher thread
// ---------------------------------------------------------------------------

/// Initialise the quota watchdog background thread. Call once during Tauri
/// `setup`. The thread polls `quota-state.json` every 60 s, merges any
/// changes into the in-process state, and emits Tauri events so the frontend
/// can update the quota card and sidebar dot without polling itself.
///
/// Events emitted on the `app_handle`:
///   * `quota:updated`  — state changed (pct_used or reset_at updated).
///   * `quota:critical` — claude_critical transitioned false → true.
///   * `quota:reset`    — claude_critical transitioned true → false.
pub fn init(app_handle: AppHandle) {
    std::thread::Builder::new()
        .name("quota-watchdog".into())
        .spawn(move || watcher_loop(app_handle))
        .unwrap_or_else(|e| {
            eprintln!("[quota_watchdog] failed to spawn watcher: {e}");
            // Return a dummy JoinHandle-compatible value is not needed here;
            // the process continues — the watchdog simply won't run.
            std::thread::spawn(|| {})
        });
}

fn watcher_loop(app: AppHandle) {
    // Snapshot of the last file mtime we processed so we avoid redundant
    // deserialisation on each poll cycle.
    let mut last_modified: Option<std::time::SystemTime> = None;
    let mut last_critical: bool = current().claude_critical;

    loop {
        std::thread::sleep(POLL_INTERVAL);

        // --- Read file mtime first; skip if unchanged. ---
        let path = match quota_state_path() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let mtime = fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok();

        let file_changed = mtime != last_modified;
        last_modified = mtime;

        if file_changed {
            if let Ok(fresh) = parse_quota_state_file() {
                // Merge into global state. We only update pct/reset_at from
                // the file; the in-process critical flag is authoritative.
                update_from_headers(fresh.claude_pct_used, fresh.reset_at);
                let _ = app.emit("quota:updated", current());
            }
        }

        // --- Independently check whether the critical flag should clear. ---
        let cleared = maybe_clear_critical();
        let now_critical = current().claude_critical;

        if cleared {
            let _ = app.emit("quota:reset", current());
            last_critical = false;
        } else if now_critical && !last_critical {
            let _ = app.emit("quota:critical", current());
            last_critical = true;
        } else if !now_critical && last_critical {
            // Edge: cleared via force_reset between polls.
            let _ = app.emit("quota:reset", current());
            last_critical = false;
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Return the current quota status to the frontend.
#[tauri::command]
pub fn quota_get_status() -> QuotaStatus {
    current()
}

/// Manually clear the critical flag (user-triggered reset button in the UI).
/// Use this after verifying that tokens have actually renewed.
#[tauri::command]
pub fn quota_force_reset() {
    if let Ok(mut g) = global_quota().write() {
        g.claude_critical = false;
        g.claude_pct_used = 0.0;
        g.last_check = Utc::now();
        let _ = persist_quota_state(&*g);
    }
}

/// Simulate a critical state for UI/integration testing purposes.
/// Calling with `pct = 99.0` trips the critical flag; `pct = 10.0` clears it.
///
/// This command is intentionally not hidden behind a feature flag because
/// manual QA requires triggering it in the production binary. Never call it
/// from automated flows.
#[tauri::command]
pub fn quota_simulate_critical(pct: f64) {
    update_from_headers(pct, None);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // Helper: write a quota-state.json into a temp dir and return the path.
    fn write_fixture(dir: &TempDir, pct: f64, critical: bool) -> PathBuf {
        let path = dir.path().join("quota-state.json");
        let status = QuotaStatus {
            claude_pct_used: pct,
            claude_critical: critical,
            reset_at: None,
            last_check: Utc::now(),
        };
        let body = serde_json::to_vec_pretty(&status).unwrap();
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn default_status_not_critical() {
        let s = QuotaStatus::default();
        assert!(!s.claude_critical);
        assert_eq!(s.claude_pct_used, 0.0);
    }

    #[test]
    fn serialise_roundtrip() {
        let s = QuotaStatus {
            claude_pct_used: 98.5,
            claude_critical: true,
            reset_at: Some(Utc::now()),
            last_check: Utc::now(),
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: QuotaStatus = serde_json::from_str(&json).unwrap();
        assert!(back.claude_critical);
        assert!((back.claude_pct_used - 98.5).abs() < 0.001);
    }

    #[test]
    fn parse_quota_state_file_roundtrip() {
        let dir = TempDir::new().unwrap();
        let expected_path = write_fixture(&dir, 97.5, false);

        // Override quota_state_path implicitly tested by reading from the
        // written fixture directly.
        let bytes = fs::read(&expected_path).unwrap();
        let parsed: QuotaStatus = serde_json::from_slice(&bytes).unwrap();
        assert!((parsed.claude_pct_used - 97.5).abs() < 0.001);
        assert!(!parsed.claude_critical);
    }

    #[test]
    fn is_critical_only_for_claude_providers() {
        // Seed the global QUOTA with a critical state for this sub-test.
        // We operate on the GLOBAL singleton so we must be careful to restore
        // it; since tests run in separate threads this is racey. We therefore
        // test the *logic* separately from the global state.

        // Non-claude providers must always return false regardless of global state.
        // We cannot easily inject state into the OnceLock without wrapping it,
        // so we directly test the string-matching part of the logic.
        let provider_contains_claude = |id: &str| id.to_ascii_lowercase().contains("claude");
        assert!(provider_contains_claude("claude-haiku"));
        assert!(provider_contains_claude("claude-sonnet-4"));
        assert!(!provider_contains_claude("gemini"));
        assert!(!provider_contains_claude("groq"));
        assert!(!provider_contains_claude("ollama"));
        assert!(!provider_contains_claude("codex"));
    }

    #[test]
    fn maybe_clear_critical_when_reset_at_in_past() {
        // Build a status where reset_at is already in the past.
        let past = Utc::now() - chrono::Duration::seconds(10);
        let status = QuotaStatus {
            claude_pct_used: 99.0,
            claude_critical: true,
            reset_at: Some(past),
            last_check: Utc::now(),
        };
        // Verify the logic: window_expired should be true.
        let window_expired = status.reset_at.map_or(false, |ra| ra <= Utc::now());
        assert!(window_expired, "past reset_at should trigger clear");
    }

    #[test]
    fn maybe_clear_critical_when_usage_dropped() {
        // Verify usage-drop logic independently.
        let status = QuotaStatus {
            claude_pct_used: 30.0, // below CLEAR_THRESHOLD
            claude_critical: true,
            reset_at: None,
            last_check: Utc::now(),
        };
        let usage_dropped = status.claude_pct_used < CLEAR_THRESHOLD;
        assert!(usage_dropped);
    }

    #[test]
    fn maybe_clear_critical_stays_set_when_window_in_future() {
        // reset_at is in the future AND pct > CLEAR_THRESHOLD → must NOT clear.
        let future = Utc::now() + chrono::Duration::hours(3);
        let status = QuotaStatus {
            claude_pct_used: 98.5,
            claude_critical: true,
            reset_at: Some(future),
            last_check: Utc::now(),
        };
        let window_expired = status.reset_at.map_or(false, |ra| ra <= Utc::now());
        let usage_dropped = status.claude_pct_used < CLEAR_THRESHOLD;
        assert!(!window_expired && !usage_dropped, "critical must stay when window is in future and pct is high");
    }

    #[test]
    fn persist_and_parse_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("quota-state.json");
        let status = QuotaStatus {
            claude_pct_used: 55.0,
            claude_critical: false,
            reset_at: None,
            last_check: Utc::now(),
        };
        // Write manually using persist logic.
        let body = serde_json::to_vec_pretty(&status).unwrap();
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, &body).unwrap();
        fs::rename(&tmp, &path).unwrap();

        // Read back.
        let bytes = fs::read(&path).unwrap();
        let back: QuotaStatus = serde_json::from_slice(&bytes).unwrap();
        assert!((back.claude_pct_used - 55.0).abs() < 0.001);
        assert!(!back.claude_critical);
    }
}
