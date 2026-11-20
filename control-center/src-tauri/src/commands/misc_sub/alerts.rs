// Alerts / changelog / UI alert sink commands.
use super::read_jsonl_tail;
use crate::alerts_admin;

#[tauri::command]
pub async fn read_alerts(limit: Option<usize>) -> Result<Vec<serde_json::Value>, String> {
    let path = crate::ultron_root()?.join("alerts.jsonl");
    let lim = limit.unwrap_or(100).clamp(1, 2000);
    let raw = read_jsonl_tail::<serde_json::Value>(path, lim)?;
    // Drop ack-only tombstones: rows that carry no source/message/severity
    // and only exist to flag a prior alert as acknowledged. They are pure
    // markers, never UI items. Without this filter they render as
    // "info" with empty text in the Notifications tab.
    let filtered: Vec<serde_json::Value> = raw
        .into_iter()
        .filter(|v| {
            let has_message = v
                .get("message")
                .and_then(|m| m.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            let has_source = v
                .get("source")
                .and_then(|s| s.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            let has_severity = v
                .get("severity")
                .and_then(|s| s.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            has_message || has_source || has_severity
        })
        .collect();
    Ok(filtered)
}

#[tauri::command]
pub async fn delete_alert_entries(fingerprints: Vec<String>) -> Result<usize, String> {
    alerts_admin::delete_alerts_by_fingerprints(fingerprints)
}

#[tauri::command]
pub async fn read_changelog(limit: Option<usize>) -> Result<Vec<serde_json::Value>, String> {
    let path = crate::ultron_root()?.join("cockpit/changelog.ndjson");
    let lim = limit.unwrap_or(100).clamp(1, 2000);
    read_jsonl_tail::<serde_json::Value>(path, lim)
}

/// Máximo de caracteres del campo `source` de una alerta de la UI.
const UI_ALERT_SOURCE_MAX_CHARS: usize = 80;
/// Máximo de caracteres del campo `message` de una alerta de la UI.
const UI_ALERT_MESSAGE_MAX_CHARS: usize = 600;

/// Recorta `source` y `message` por carácter, no por byte: `String::truncate`
/// hace panic si el corte cae dentro de un carácter UTF-8 de varios bytes
/// («á», «ñ») y la alerta se perdería. El mensaje se aplana a una línea y,
/// si se recorta, se marca con `…`.
fn clamp_ui_alert_fields(source: &str, message: &str) -> (String, String) {
    let src = crate::toast_emit::cap_chars(source, UI_ALERT_SOURCE_MAX_CHARS);
    let flat = message.replace(['\r', '\n'], " ");
    if flat.chars().count() <= UI_ALERT_MESSAGE_MAX_CHARS {
        return (src, flat);
    }
    let mut msg = crate::toast_emit::cap_chars(&flat, UI_ALERT_MESSAGE_MAX_CHARS);
    msg.push('…');
    (src, msg)
}

/// Append a UI-side alert to alerts.jsonl so Notifications picks it up.
/// Used by the frontend's window.onerror / onunhandledrejection so failures
/// in the webview don't get swallowed silently — they show up alongside
/// the backend alerts the user already monitors.
#[tauri::command]
pub async fn record_ui_alert(
    severity: String,
    source: String,
    message: String,
) -> Result<(), String> {
    // Hard caps so the UI can't flood the file. Also strip CR/LF so the
    // JSONL stays one record per line.
    let sev = match severity.as_str() {
        "info" | "warn" | "critical" | "blocking" => severity,
        _ => "warn".to_string(),
    };
    let (src, msg) = clamp_ui_alert_fields(&source, &message);
    if msg.trim().is_empty() {
        return Ok(());
    }
    let path = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/alerts.jsonl");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let iso = {
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
            31,
            if leap { 29 } else { 28 },
            31,
            30,
            31,
            30,
            31,
            31,
            30,
            31,
            30,
            31,
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
    };
    let entry = serde_json::json!({
        "timestamp": iso,
        "source": src,
        "severity": sev,
        "status": "ui",
        "message": msg,
    });
    let line = entry.to_string() + "\n";
    // Serialise this append under the same lock as delete_alerts_by_fingerprints'
    // read->filter->tmp+rename, so a concurrent delete can't drop this entry.
    let _guard = crate::alerts_admin::alerts_lock()
        .lock()
        .map_err(|e| format!("alerts write lock poisoned: {}", e))?;
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

#[cfg(test)]
mod tests {
    use super::clamp_ui_alert_fields;

    #[test]
    fn recorta_multibyte_que_cruza_los_bytes_80_y_600_sin_panic() {
        // 79 bytes ASCII + «ñ» (2 bytes): el byte 80 cae dentro de la «ñ».
        let source = format!("{}ñ-origen", "s".repeat(79));
        // 599 bytes ASCII + «á»: el byte 600 cae dentro de la «á».
        let message = format!("{}áéíóú resto del stderr", "m".repeat(599));
        assert!(!source.is_char_boundary(80));
        assert!(!message.is_char_boundary(600));

        let (src, msg) = clamp_ui_alert_fields(&source, &message);

        assert_eq!(src.chars().count(), 80);
        assert!(src.ends_with('ñ'));
        assert_eq!(msg.chars().count(), 601);
        assert!(msg.ends_with("á…"));
    }

    #[test]
    fn no_recorta_ni_marca_lo_que_cabe_y_aplana_saltos_de_linea() {
        let (src, msg) = clamp_ui_alert_fields("origen", "línea 1\r\nlínea 2");
        assert_eq!(src, "origen");
        assert_eq!(msg, "línea 1  línea 2");
    }
}
