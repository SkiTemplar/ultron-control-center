//! Control Center 2.0 — Windows Event Log recent-events command.
//!
//! Provides a leaner, focused query over the Windows Event Log than the
//! full PC Diagnostic. Used by:
//!   - System -> Diagnostics      (full list of recent critical/error events)
//!   - Dashboard CrashEventsCard  (crashes / unexpected shutdowns only)
//!
//! Implementation note: we shell out to `wevtutil.exe` rather than going
//! through WMI here. `wevtutil` is the modern, supported tooling for
//! Windows Event Log queries (Win32_NTLogEvent has been deprecated since
//! Win8) and avoids dragging COM/WMI initialization into a hot UI path.
//! The full diagnostic (`diagnostics_native::check_event_log_windows`)
//! continues to use WMI because it runs in a different context already.

use serde::{Deserialize, Serialize};

/// Severity coming out of wevtutil. Mirrors the standard Windows Event
/// Log levels:
///   1 = Critical, 2 = Error, 3 = Warning, 4 = Information, 5 = Verbose.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EventLogLevel {
    Critical,
    Error,
    Warning,
    Information,
    Verbose,
    Unknown,
}

impl EventLogLevel {
    fn from_code(code: u8) -> Self {
        match code {
            1 => EventLogLevel::Critical,
            2 => EventLogLevel::Error,
            3 => EventLogLevel::Warning,
            4 => EventLogLevel::Information,
            5 => EventLogLevel::Verbose,
            _ => EventLogLevel::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventLogEntry {
    pub event_id: u32,
    pub source: String,
    pub log_name: String,
    pub level: EventLogLevel,
    pub time_created: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventLogScope {
    /// Critical + Error (Level=1 or Level=2). Used by the System
    /// Diagnostics panel — surfaces anything bad in the last N events.
    CriticalAndError,
    /// Only event IDs that indicate a crash / unexpected shutdown.
    /// Used by the Dashboard CrashEventsCard.
    CrashOnly,
}

const CRASH_EVENT_IDS: &[u32] = &[41, 1001, 6008];

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

/// Returns the latest Windows Event Log entries.
///
/// `limit` is capped at 200 to keep wevtutil snappy.
/// `scope` controls the wevtutil XPath filter.
///
/// On non-Windows targets this returns an empty list — the rest of the
/// app simply renders "No events" in that case (the Control Center is
/// Windows-first but the rest of the codebase stays portable).
#[tauri::command]
pub async fn event_log_recent(
    limit: Option<u32>,
    scope: Option<EventLogScope>,
) -> Result<Vec<EventLogEntry>, String> {
    let limit = limit.unwrap_or(50).min(200);
    let scope = scope.unwrap_or(EventLogScope::CriticalAndError);
    tauri::async_runtime::spawn_blocking(move || query_event_log(limit, scope))
        .await
        .map_err(|e| format!("join: {e}"))?
}

/// Launches the Windows Event Viewer MMC snap-in (`eventvwr.msc`) so the
/// user can drill into raw events with the native UI.
#[tauri::command]
pub async fn open_event_viewer() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        tauri::async_runtime::spawn_blocking(|| {
            let mut cmd = std::process::Command::new("cmd.exe");
            cmd.args(["/C", "start", "", "eventvwr.msc"]);
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            cmd.spawn().map_err(|e| format!("spawn eventvwr: {e}"))
        })
        .await
        .map_err(|e| format!("join: {e}"))??;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Event Viewer is Windows-only".to_string())
    }
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn query_event_log(limit: u32, scope: EventLogScope) -> Result<Vec<EventLogEntry>, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let xpath = build_xpath(scope);

    // `wevtutil qe System /c:<N> /f:xml /q:"<xpath>" /rd:true`
    //   /c   -> max event count
    //   /f   -> output format (XML is easiest to parse robustly)
    //   /q   -> XPath query
    //   /rd  -> reverse direction (newest first)
    let mut cmd = Command::new("wevtutil.exe");
    cmd.args([
        "qe",
        "System",
        &format!("/c:{limit}"),
        "/f:xml",
        "/rd:true",
        &format!("/q:{xpath}"),
    ]);
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let out = cmd.output().map_err(|e| format!("wevtutil spawn: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "wevtutil exited {:?}: {}",
            out.status.code(),
            stderr.trim()
        ));
    }

    // wevtutil with /f:xml prints one <Event>...</Event> document per event,
    // concatenated. We split on the closing tag and parse each chunk.
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let events = parse_event_xml(&stdout);

    Ok(match scope {
        EventLogScope::CrashOnly => events
            .into_iter()
            .filter(|e| CRASH_EVENT_IDS.contains(&e.event_id))
            .collect(),
        EventLogScope::CriticalAndError => events,
    })
}

#[cfg(target_os = "windows")]
fn build_xpath(scope: EventLogScope) -> String {
    match scope {
        EventLogScope::CriticalAndError => {
            // Level=1 (Critical) OR Level=2 (Error).
            "*[System[Level=1 or Level=2]]".to_string()
        }
        EventLogScope::CrashOnly => {
            // Event IDs 41 (Kernel-Power unexpected shutdown), 6008
            // (previous shutdown unexpected), 1001 (WER bucket — only the
            // System log variants surface here). WER also fires in
            // Application log but we'd need a separate query for that —
            // System log alone catches the bulk of real crashes.
            let ids = CRASH_EVENT_IDS
                .iter()
                .map(|id| format!("EventID={id}"))
                .collect::<Vec<_>>()
                .join(" or ");
            format!("*[System[{ids}]]")
        }
    }
}

#[cfg(target_os = "windows")]
fn parse_event_xml(xml: &str) -> Vec<EventLogEntry> {
    // wevtutil's XML is one event per top-level <Event>...</Event>. We
    // intentionally do a string-based extraction rather than pulling in
    // a full XML parser dependency for this single use site — every
    // field we need is well-formed and on a single line.
    let mut out = Vec::new();
    let mut cursor = 0;
    while let Some(rel_start) = xml[cursor..].find("<Event ") {
        let start = cursor + rel_start;
        let Some(rel_end) = xml[start..].find("</Event>") else {
            break;
        };
        let end = start + rel_end + "</Event>".len();
        let chunk = &xml[start..end];
        if let Some(entry) = parse_one_event(chunk) {
            out.push(entry);
        }
        cursor = end;
    }
    out
}

#[cfg(target_os = "windows")]
fn parse_one_event(chunk: &str) -> Option<EventLogEntry> {
    let event_id_str = extract_between(chunk, "<EventID", "</EventID>").unwrap_or_default();
    // <EventID Qualifiers="...">41</EventID> or <EventID>41</EventID>.
    let event_id_value = event_id_str
        .rsplit('>')
        .next()
        .unwrap_or("0")
        .trim()
        .parse::<u32>()
        .unwrap_or(0);

    let level_code = extract_between(chunk, "<Level>", "</Level>")
        .and_then(|s| s.trim().parse::<u8>().ok())
        .unwrap_or(0);

    // <Provider Name="Foo" ... />
    let source = extract_attr(chunk, "<Provider ", "Name=").unwrap_or_default();

    // <Channel>System</Channel>
    let log_name =
        extract_between(chunk, "<Channel>", "</Channel>").unwrap_or_else(|| "System".to_string());

    // <TimeCreated SystemTime="2024-..." />
    let time_created = extract_attr(chunk, "<TimeCreated ", "SystemTime=").unwrap_or_default();

    // wevtutil sometimes embeds a rendered message; if not, the EventData
    // is the best we have. Both are best-effort — the frontend never relies
    // on the message being human-readable, it leans on KNOWN_ERRORS.
    let message = extract_between(chunk, "<RenderingInfo Culture=", "</RenderingInfo>")
        .and_then(|rest| extract_between(&rest, "<Message>", "</Message>"))
        .or_else(|| extract_between(chunk, "<Data>", "</Data>"))
        .unwrap_or_default();

    Some(EventLogEntry {
        event_id: event_id_value,
        source,
        log_name,
        level: EventLogLevel::from_code(level_code),
        time_created,
        message: message.trim().to_string(),
    })
}

#[cfg(target_os = "windows")]
fn extract_between(haystack: &str, open: &str, close: &str) -> Option<String> {
    let start = haystack.find(open)? + open.len();
    let rest = &haystack[start..];
    let end = rest.find(close)?;
    Some(rest[..end].to_string())
}

#[cfg(target_os = "windows")]
fn extract_attr(haystack: &str, tag_prefix: &str, attr_prefix: &str) -> Option<String> {
    let tag_start = haystack.find(tag_prefix)? + tag_prefix.len();
    let after_tag = &haystack[tag_start..];
    // Look for `Name="..."` between the tag opening and the next `/>` or `>`.
    let tag_end = after_tag.find('>').unwrap_or(after_tag.len());
    let tag_body = &after_tag[..tag_end];
    let attr_start = tag_body.find(attr_prefix)? + attr_prefix.len();
    let rest = &tag_body[attr_start..];
    let first_quote = rest.chars().next()?;
    if first_quote != '"' && first_quote != '\'' {
        return None;
    }
    let inner = &rest[1..];
    let close_pos = inner.find(first_quote)?;
    Some(inner[..close_pos].to_string())
}

#[cfg(not(target_os = "windows"))]
fn query_event_log(_limit: u32, _scope: EventLogScope) -> Result<Vec<EventLogEntry>, String> {
    Ok(Vec::new())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_event_xml() {
        let xml = r#"<Event xmlns="http://...">
<System>
<Provider Name="Microsoft-Windows-Kernel-Power" />
<EventID>41</EventID>
<Level>2</Level>
<Channel>System</Channel>
<TimeCreated SystemTime="2024-01-15T10:30:00.000Z" />
</System>
</Event>"#;
        let events = parse_event_xml(xml);
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.event_id, 41);
        assert!(matches!(e.level, EventLogLevel::Error));
        assert_eq!(e.source, "Microsoft-Windows-Kernel-Power");
        assert_eq!(e.log_name, "System");
        assert!(e.time_created.starts_with("2024-01-15"));
    }
}
