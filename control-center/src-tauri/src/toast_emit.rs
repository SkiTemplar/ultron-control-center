// ULTRON Control Center — Toast + alert emitter.
//
// Single entry-point for backend modules that need to surface a UI alert
// AND optionally fire a native Windows toast. Encapsulates:
//
//   1. The same alerts.jsonl append discipline that `record_ui_alert`
//      uses (atomic line, capped lengths, ISO timestamp).
//   2. A per-source rate limiter (last_message + min interval) so a
//      flapping health probe can't spam the user.
//   3. A persistent user toggle stored at ~/.ultron/.tmp/toast-enabled.flag
//      ("1" / "0"). When "0" we still append the alert but skip the toast.
//
// All public functions are infallible from the caller's POV: failures are
// logged to stderr and swallowed so notification machinery never breaks
// the producer (e.g. plan resolution, project creation).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

/// Minimum interval between two alerts that share the same source+message.
/// 30 s is enough to absorb a noisy probe loop while still surfacing a
/// genuinely new event quickly.
const RATE_WINDOW: Duration = Duration::from_secs(30);

struct RateState {
    last_fired: Instant,
    last_message: String,
}

static RATE_LIMITER: Lazy<Mutex<HashMap<String, RateState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Returns true if (source, message) is allowed to fire right now. Updates
/// the per-source bookkeeping on the way out.
fn should_fire(source: &str, message: &str) -> bool {
    let mut guard = match RATE_LIMITER.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(), // poisoned mutex still gives us the map
    };
    let now = Instant::now();
    let key = source.to_string();
    if let Some(state) = guard.get_mut(&key) {
        let same_msg = state.last_message == message;
        let still_hot = now.duration_since(state.last_fired) < RATE_WINDOW;
        if same_msg && still_hot {
            return false;
        }
        state.last_fired = now;
        state.last_message = message.to_string();
        return true;
    }
    guard.insert(
        key,
        RateState {
            last_fired: now,
            last_message: message.to_string(),
        },
    );
    true
}

// ---------------------------------------------------------------------------
// Toast toggle (persisted)
// ---------------------------------------------------------------------------

fn toast_flag_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/.tmp/toast-enabled.flag"))
}

/// Read the toast toggle from disk. Defaults to true (enabled) when the
/// flag file does not exist or is malformed.
pub fn read_toast_enabled() -> bool {
    let Some(path) = toast_flag_path() else {
        return true;
    };
    match std::fs::read_to_string(&path) {
        Ok(s) => s.trim() != "0",
        Err(_) => true,
    }
}

/// Persist the toast toggle. Returns Err with a human string on IO
/// failure so the Tauri command can bubble it up to the UI.
pub fn write_toast_enabled(enabled: bool) -> Result<(), String> {
    let path = toast_flag_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {}", e))?;
    }
    std::fs::write(&path, if enabled { "1" } else { "0" })
        .map_err(|e| format!("write flag: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// alerts.jsonl append
// ---------------------------------------------------------------------------

fn format_iso(now: u64) -> String {
    let mut days = (now / 86_400) as i64;
    let secs_in_day = (now % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd {
            break;
        }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        days + 1,
        h,
        m,
        s
    )
}

fn append_alert_line(source: &str, severity: &str, message: &str) -> Result<(), String> {
    let path = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/alerts.jsonl");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let entry = serde_json::json!({
        "timestamp": format_iso(now),
        "source": source,
        "severity": severity,
        "status": "backend",
        "message": message,
    });
    let line = entry.to_string() + "\n";
    use std::io::Write;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open alerts: {}", e))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("append alert: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Sanitise a free-form message for both alerts.jsonl and the toast body.
/// Strips CR/LF, collapses internal whitespace, caps to 600 chars (alerts
/// already enforce 600 — we mirror that to stay consistent).
fn sanitize(msg: &str) -> String {
    let mut out: String = msg.replace('\r', " ").replace('\n', " ");
    if out.len() > 600 {
        out.truncate(600);
        out.push('…');
    }
    out.trim().to_string()
}

/// Emit an in-app toast event consumed by `PopupHost` in the frontend.
/// v15.5.20: replaces the Windows-native `tauri_plugin_notification` path
/// per user directive ("no quiero notificaciones tipo Windows — popups
/// abajo a la izquierda mientras ULTRON está activo"). Honours the user
/// toggle; failures are logged to stderr and swallowed. Severity drives
/// the accent colour rendered in the popup card.
pub fn try_emit_toast_with_severity(
    app: &AppHandle,
    source: &str,
    severity: &str,
    message: &str,
) {
    if !read_toast_enabled() {
        return;
    }
    let body_full = sanitize(message);
    let body: String = if body_full.chars().count() > 280 {
        let truncated: String = body_full.chars().take(280).collect();
        format!("{}…", truncated)
    } else {
        body_full
    };
    let payload = serde_json::json!({
        "source": source,
        "severity": severity,
        "message": body,
    });
    if let Err(e) = app.emit("ultron-toast", payload) {
        eprintln!(
            "[toast_emit] emit ultron-toast failed for source={}: {}",
            source, e
        );
    }
}

/// Append an alert AND (when the severity is critical/blocking AND the
/// user toggle is on AND the rate-limiter allows it) fire a Windows
/// toast. This is the function backend modules should call instead of
/// poking alerts.jsonl directly.
///
/// `severity` is normalised: anything outside {info, warn, critical,
/// blocking} becomes "warn".
pub fn record_alert_and_maybe_toast(
    app: &AppHandle,
    source: &str,
    severity: &str,
    message: &str,
) {
    let sev = match severity {
        "info" | "warn" | "critical" | "blocking" => severity,
        _ => "warn",
    };
    let mut src = source.to_string();
    src.truncate(80);
    let msg = sanitize(message);
    if msg.is_empty() {
        return;
    }
    // Rate-limit BEFORE doing any IO so a flapping caller can't churn the
    // disk either.
    if !should_fire(&src, &msg) {
        return;
    }
    if let Err(e) = append_alert_line(&src, sev, &msg) {
        eprintln!("[toast_emit] append alert failed: {}", e);
    }
    // Toast only on user-visible severities.
    if matches!(sev, "critical" | "blocking") {
        try_emit_toast_with_severity(app, &src, sev, &msg);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (toggle get/set)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_toast_enabled() -> bool {
    read_toast_enabled()
}

#[tauri::command]
pub fn set_toast_enabled(enabled: bool) -> Result<(), String> {
    write_toast_enabled(enabled)
}

// LIB_RS_WIRING:
//   mod toast_emit;
//   // inside .invoke_handler(tauri::generate_handler![...]):
//   toast_emit::get_toast_enabled,
//   toast_emit::set_toast_enabled,
//
//   // Add `once_cell = "1"` to control-center/src-tauri/Cargo.toml deps.
