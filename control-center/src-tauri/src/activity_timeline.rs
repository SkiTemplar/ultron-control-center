// ULTRON Control Center — Activity Timeline aggregator.
//
// Reads the same six hook-signal JSONL sources as `self_improve::read_hook_signals`
// plus `~/.ultron/alerts.jsonl` (operational alerts), normalises each entry into
// a `TimelineEvent`, and builds a per-day, per-source heatmap matrix used by the
// frontend Activity Timeline view.
//
// Design choices:
//   - We tail-read up to 500 lines per source (vs. 200 in self_improve) so the
//     30d window has enough density to be meaningful for heavy sources.
//   - Timestamps are normalised lexically — ISO 8601 in UTC sorts correctly as
//     a plain string. We do NOT translate to local time: the source files are
//     written in UTC and the heatmap day buckets are UTC days. The frontend
//     can render them with the user's locale if desired.
//   - Malformed lines are skipped silently. Missing files yield empty results
//     for that source. The aggregator never fails because one source is broken.
//   - The `day` field is the first 10 chars of the ISO timestamp (YYYY-MM-DD).
//     Entries with no parseable timestamp are dropped (no day bucket → no point
//     plotting them on a timeline).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct TimelineEvent {
    pub ts: String,
    pub day: String,
    pub source: String,
    pub kind: String,
    pub summary: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct TimelineSummary {
    pub events: Vec<TimelineEvent>,
    /// Outer key: day (YYYY-MM-DD). Inner: source -> count for that day.
    pub day_counts: HashMap<String, HashMap<String, usize>>,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn ultron_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_tail_lines(path: &PathBuf, max_lines: usize) -> Vec<String> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
    let n = lines.len();
    let start = n.saturating_sub(max_lines);
    lines[start..].iter().map(|s| s.to_string()).collect()
}

fn truncate_summary(s: &str, max: usize) -> String {
    let cleaned = s.replace(['\n', '\r'], " ");
    if cleaned.chars().count() <= max {
        return cleaned;
    }
    let mut out: String = cleaned.chars().take(max).collect();
    out.push('…');
    out
}

/// Compute the UTC YYYY-MM-DD string for a given unix epoch seconds value.
fn iso_day_from_secs(secs: u64) -> String {
    let mut days = (secs / 86_400) as i64;
    let mut year: i32 = 1970;
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
    format!("{:04}-{:02}-{:02}", year, month + 1, days + 1)
}

/// Returns the cutoff day (inclusive) for the given window — events with a
/// `day` lexically >= this are kept. Lex comparison is safe because the day
/// format is fixed-width YYYY-MM-DD. For a 7-day window we keep today plus
/// the 6 previous days, matching the frontend's `buildDayList(7)` which also
/// renders 7 columns inclusive of today.
fn cutoff_day(days: u32) -> String {
    let span = (days.max(1) - 1) as u64;
    let secs = now_secs().saturating_sub(span * 86_400);
    iso_day_from_secs(secs)
}

/// Extract a normalised ISO-8601-ish timestamp from a JSON value, checking
/// multiple common field names. Returns the raw string so the frontend can
/// render it as-is; we don't bother re-formatting because the original is
/// already ISO 8601 across all six telemetry sources.
fn extract_ts(v: &serde_json::Value) -> Option<String> {
    for key in ["ts", "timestamp", "time", "datetime"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Derive the day key from an ISO timestamp by taking the first 10 chars.
/// Returns None if the input is too short or doesn't look like a date.
fn ts_to_day(ts: &str) -> Option<String> {
    if ts.len() < 10 {
        return None;
    }
    let day: String = ts.chars().take(10).collect();
    // Cheap sanity check: positions 4 and 7 must be '-'.
    let bytes = day.as_bytes();
    if bytes.len() == 10 && bytes[4] == b'-' && bytes[7] == b'-' {
        Some(day)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Per-source parsers
//
// Each parser appends `TimelineEvent`s into `out`. Mirrors the shape of
// `self_improve::read_hook_signals` so the source names and `kind` fields
// align with what the user already sees in the table view.
// ---------------------------------------------------------------------------

fn ingest_hyper_plans(root: &PathBuf, out: &mut Vec<TimelineEvent>) {
    for line in read_tail_lines(&root.join(".tmp/hiper-plans-signals.jsonl"), 500) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(ts) = extract_ts(&v) else { continue };
        let Some(day) = ts_to_day(&ts) else { continue };
        let kind = v
            .get("signal")
            .and_then(|x| x.as_str())
            .unwrap_or("signal")
            .to_string();
        let mode = v.get("mode").and_then(|x| x.as_str()).unwrap_or("");
        let preview = v
            .get("prompt_preview")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let summary = if mode.is_empty() {
            preview.to_string()
        } else {
            format!("[{}] {}", mode, preview)
        };
        out.push(TimelineEvent {
            ts,
            day,
            source: "hyper-plans".to_string(),
            kind,
            summary: truncate_summary(&summary, 160),
        });
    }
}

fn ingest_doctor(root: &PathBuf, out: &mut Vec<TimelineEvent>) {
    for line in read_tail_lines(&root.join(".tmp/doctor-fix-log.jsonl"), 500) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(ts) = extract_ts(&v) else { continue };
        let Some(day) = ts_to_day(&ts) else { continue };
        let finding = v.get("finding_id").and_then(|x| x.as_str()).unwrap_or("");
        let action = v.get("fix_action").and_then(|x| x.as_str()).unwrap_or("");
        let exit_code = v.get("exit_code").and_then(|x| x.as_i64());
        let exit_part = match exit_code {
            Some(c) => format!(" (exit {})", c),
            None => String::new(),
        };
        let summary = format!("{} -> {}{}", finding, action, exit_part);
        out.push(TimelineEvent {
            ts,
            day,
            source: "doctor".to_string(),
            kind: action.to_string(),
            summary: truncate_summary(&summary, 160),
        });
    }
}

fn ingest_prompt_feedback(root: &PathBuf, out: &mut Vec<TimelineEvent>) {
    for line in read_tail_lines(&root.join(".tmp/prompt-feedback.jsonl"), 500) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(ts) = extract_ts(&v) else { continue };
        let Some(day) = ts_to_day(&ts) else { continue };
        let kind = v
            .get("kind")
            .and_then(|x| x.as_str())
            .unwrap_or("feedback")
            .to_string();
        let target = v.get("target").and_then(|x| x.as_str()).unwrap_or("");
        let chars = v.get("output_chars").and_then(|x| x.as_i64()).unwrap_or(0);
        let summary = format!("{} ({} chars)", target, chars);
        out.push(TimelineEvent {
            ts,
            day,
            source: "prompt-feedback".to_string(),
            kind,
            summary: truncate_summary(&summary, 160),
        });
    }
}

fn ingest_token_usage(root: &PathBuf, out: &mut Vec<TimelineEvent>) {
    for line in read_tail_lines(&root.join(".tmp/token-usage.jsonl"), 500) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(ts) = extract_ts(&v) else { continue };
        let Some(day) = ts_to_day(&ts) else { continue };
        let layer = v
            .get("layer")
            .and_then(|x| x.as_str())
            .unwrap_or("?")
            .to_string();
        let tokens = v.get("tokens").and_then(|x| x.as_i64()).unwrap_or(0);
        let limit = v.get("limit").and_then(|x| x.as_i64()).unwrap_or(0);
        let summary = if limit > 0 {
            format!("{} tok / {} limit", tokens, limit)
        } else {
            format!("{} tok", tokens)
        };
        out.push(TimelineEvent {
            ts,
            day,
            source: "token-usage".to_string(),
            kind: layer,
            summary: truncate_summary(&summary, 160),
        });
    }
}

fn ingest_auto_updater(root: &PathBuf, out: &mut Vec<TimelineEvent>) {
    for line in read_tail_lines(&root.join("cockpit/auto_updater.jsonl"), 500) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(ts) = extract_ts(&v) else { continue };
        let Some(day) = ts_to_day(&ts) else { continue };
        let action = v
            .get("action")
            .and_then(|x| x.as_str())
            .unwrap_or("update")
            .to_string();
        let target = v.get("target").and_then(|x| x.as_str()).unwrap_or("");
        let model = v.get("model").and_then(|x| x.as_str()).unwrap_or("");
        let exit_code = v.get("exit_code").and_then(|x| x.as_i64());
        let exit_part = match exit_code {
            Some(c) => format!(" exit={}", c),
            None => String::new(),
        };
        let summary = format!("{} via {}{}", target, model, exit_part);
        out.push(TimelineEvent {
            ts,
            day,
            source: "auto-updater".to_string(),
            kind: action,
            summary: truncate_summary(&summary, 160),
        });
    }
}

fn ingest_mcp_audit(root: &PathBuf, out: &mut Vec<TimelineEvent>) {
    for line in read_tail_lines(&root.join("cockpit/mcp-audit.jsonl"), 500) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(ts) = extract_ts(&v) else { continue };
        let Some(day) = ts_to_day(&ts) else { continue };
        let event = v
            .get("event")
            .and_then(|x| x.as_str())
            .unwrap_or("mutation")
            .to_string();
        let server = v.get("server").and_then(|x| x.as_str()).unwrap_or("");
        let detail = v.get("detail").and_then(|x| x.as_str()).unwrap_or("");
        let summary = if detail.is_empty() {
            server.to_string()
        } else {
            format!("{} · {}", server, detail)
        };
        out.push(TimelineEvent {
            ts,
            day,
            source: "mcp-audit".to_string(),
            kind: event,
            summary: truncate_summary(&summary, 160),
        });
    }
}

/// Convert a "epoch:<secs>" string (the workday TS format) to ISO 8601.
/// Mirrors `recall::format_iso` — duplicated here to keep the two modules
/// decoupled. Returns None when the value is not a parseable epoch.
fn workday_ts_to_iso(raw: &str) -> Option<String> {
    let stripped = raw.strip_prefix("epoch:").unwrap_or(raw);
    let secs: u64 = stripped.trim().parse().ok()?;
    Some(epoch_secs_to_iso(secs))
}

pub(crate) fn epoch_secs_to_iso(secs: u64) -> String {
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd { break; }
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
        year, month + 1, days + 1, h, m, s
    )
}

/// Workdays + kanban events live in `~/.ultron/cockpit/workdays/wd-*.json`.
/// We walk the directory, parse each file, and emit:
///   - 1 event per workday "created" (kind = "created:<status>")
///   - 1 event per workday "completed" (when end_ts is set)
///   - 1 event per kanban_move context entry (source = "kanban")
fn ingest_workdays(root: &PathBuf, out: &mut Vec<TimelineEvent>) {
    let dir = root.join("cockpit").join("workdays");
    let Ok(entries) = fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };

        let title = v
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("workday")
            .to_string();
        let status = v.get("status").and_then(|x| x.as_str()).unwrap_or("").to_string();

        // Event: workday created
        if let Some(raw) = v.get("created_at").and_then(|x| x.as_str()) {
            if let Some(ts) = workday_ts_to_iso(raw) {
                if let Some(day) = ts_to_day(&ts) {
                    out.push(TimelineEvent {
                        ts,
                        day,
                        source: "workdays".to_string(),
                        kind: if status.is_empty() {
                            "created".to_string()
                        } else {
                            format!("created:{}", status)
                        },
                        summary: truncate_summary(&title, 160),
                    });
                }
            }
        }

        // Event: workday completed (end_ts populated)
        if let Some(raw) = v.get("end_ts").and_then(|x| x.as_str()) {
            if let Some(ts) = workday_ts_to_iso(raw) {
                if let Some(day) = ts_to_day(&ts) {
                    out.push(TimelineEvent {
                        ts,
                        day,
                        source: "workdays".to_string(),
                        kind: "completed".to_string(),
                        summary: truncate_summary(&format!("done: {}", title), 160),
                    });
                }
            }
        }

        // Event(s): kanban_move entries living in the context buckets.
        let Some(context) = v.get("context") else { continue };
        let buckets = [
            "notes",
            "decisions",
            "file_changes",
            "agent_messages",
        ];
        for bname in &buckets {
            let Some(arr) = context.get(*bname).and_then(|x| x.as_array()) else {
                continue;
            };
            for ent in arr {
                let kind_field = ent
                    .get("kind")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                if !kind_field.starts_with("kanban_move") {
                    continue;
                }
                let raw_created = ent
                    .get("created_at")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let Some(ts) = workday_ts_to_iso(raw_created) else {
                    continue;
                };
                let Some(day) = ts_to_day(&ts) else { continue };
                let text = ent.get("text").and_then(|x| x.as_str()).unwrap_or("");
                out.push(TimelineEvent {
                    ts,
                    day,
                    source: "kanban".to_string(),
                    kind: kind_field.to_string(),
                    summary: truncate_summary(text, 160),
                });
            }
        }
    }
}

fn ingest_alerts(root: &PathBuf, out: &mut Vec<TimelineEvent>) {
    for line in read_tail_lines(&root.join("alerts.jsonl"), 500) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(ts) = extract_ts(&v) else { continue };
        let Some(day) = ts_to_day(&ts) else { continue };
        let severity = v
            .get("severity")
            .and_then(|x| x.as_str())
            .unwrap_or("info")
            .to_string();
        let source_field = v.get("source").and_then(|x| x.as_str()).unwrap_or("alert");
        let message = v.get("message").and_then(|x| x.as_str()).unwrap_or("");
        let summary = if source_field.is_empty() {
            message.to_string()
        } else {
            format!("{} · {}", source_field, message)
        };
        out.push(TimelineEvent {
            ts,
            day,
            source: "alerts".to_string(),
            kind: severity,
            summary: truncate_summary(&summary, 160),
        });
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Aggregate all timeline sources, clamp to the requested window, sort
/// descending, and build the day/source count matrix for the heatmap.
///
/// `days`: how many days of history to include (e.g. 7, 30). Values outside
/// 1..=365 are clamped to 30.
pub fn compute_activity_timeline_inner(days: u32) -> Result<TimelineSummary, String> {
    let root = ultron_root().ok_or_else(|| "no HOME".to_string())?;
    let window = if days == 0 || days > 365 { 30 } else { days };
    let cutoff = cutoff_day(window);

    let mut events: Vec<TimelineEvent> = Vec::new();
    ingest_hyper_plans(&root, &mut events);
    ingest_doctor(&root, &mut events);
    ingest_prompt_feedback(&root, &mut events);
    ingest_token_usage(&root, &mut events);
    ingest_auto_updater(&root, &mut events);
    ingest_mcp_audit(&root, &mut events);
    ingest_alerts(&root, &mut events);
    // 2026-05-27 — workday lifecycle + kanban_move events. These give the
    // timeline a "what the user actually did" signal alongside the hook
    // telemetry, so Backlog/Investigar items that already shipped show up
    // visibly instead of staying invisible.
    ingest_workdays(&root, &mut events);

    // Drop anything older than the cutoff day. Lexical comparison is safe
    // because both sides are fixed-width YYYY-MM-DD strings.
    events.retain(|e| e.day.as_str() >= cutoff.as_str());

    // Sort descending by ts (ISO 8601 sorts correctly as string). Empty
    // timestamps would land at the bottom but we already dropped those.
    events.sort_by(|a, b| b.ts.cmp(&a.ts));

    // Build the per-day, per-source count matrix from the filtered events.
    let mut day_counts: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for ev in &events {
        let day_entry = day_counts.entry(ev.day.clone()).or_default();
        *day_entry.entry(ev.source.clone()).or_insert(0) += 1;
    }

    Ok(TimelineSummary { events, day_counts })
}
