// ULTRON Control Center — Activity Timeline aggregator.
//
// Reads the live activity sources — `~/.ultron/alerts.jsonl` (operational
// alerts), `~/.ultron/logs/route-decisions.jsonl` (AI Router decisions) and the
// per-project kanban boards (`cockpit/projects/<id>/kanban.json`) —, normalises
// each entry into a `TimelineEvent`, and builds a per-day, per-source heatmap
// matrix used by the frontend Activity Timeline view.
//
// 2026-10-17: se retiraron seis fuentes sin escritor vivo (hiper-plans-signals,
// doctor-fix-log, prompt-feedback y token-usage en `.tmp/`, auto_updater y
// mcp-audit en `cockpit/`) y `cockpit/workdays/`, que ya no existe. Routing y
// kanban entran en su lugar.
//
// Design choices:
//   - We tail-read up to 500 lines per JSONL source so the
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
use std::path::{Path, PathBuf};
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

fn read_tail_lines(path: &Path, max_lines: usize) -> Vec<String> {
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
/// already ISO 8601 in every JSONL source.
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
// Each parser appends `TimelineEvent`s into `out`. A missing or unreadable
// source yields nothing; malformed lines are skipped.
// ---------------------------------------------------------------------------

/// AI Router decisions (`logs/route-decisions.jsonl`, one line per routed
/// call). `kind` is `failed` when the whole chain failed (reason `failed`,
/// since 2026-10-23), `fallback` when a fallback answered, `primary` otherwise.
fn ingest_routing(root: &Path, out: &mut Vec<TimelineEvent>) {
    for line in read_tail_lines(&root.join("logs/route-decisions.jsonl"), 500) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(ts) = extract_ts(&v) else { continue };
        let Some(day) = ts_to_day(&ts) else { continue };
        let field = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("?");
        let fallback = v
            .get("used_fallback")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let failed = field("reason") == "failed";
        let summary = if failed {
            format!("{} · sin respuesta: {}", field("zone"), field("error"))
        } else if fallback {
            format!(
                "{} · {}/{} ({})",
                field("zone"),
                field("provider_id"),
                field("model"),
                field("reason")
            )
        } else {
            format!(
                "{} · {}/{}",
                field("zone"),
                field("provider_id"),
                field("model")
            )
        };
        let kind = match (failed, fallback) {
            (true, _) => "failed",
            (false, true) => "fallback",
            (false, false) => "primary",
        };
        out.push(TimelineEvent {
            ts,
            day,
            source: "routing".to_string(),
            kind: kind.to_string(),
            summary: truncate_summary(&summary, 160),
        });
    }
}

/// Timestamp of a kanban card: ISO 8601 as-is or the legacy `epoch:<secs>`.
fn card_ts(raw: &str) -> Option<String> {
    if raw.starts_with("epoch:") {
        return workday_ts_to_iso(raw);
    }
    ts_to_day(raw).map(|_| raw.to_string())
}

/// Kanban boards (`cockpit/projects/<id>/kanban.json`). Per card: one
/// `created` event and, when `updated_at` differs, one `updated:<role>` event
/// with the role (or name) of the column the card sits in now. `updated_at`
/// se sella tanto al mover la tarjeta como al editarla (`board_io.rs`), así
/// que el evento no distingue un movimiento de una edición. The board keeps
/// no history, so only the last change of each card is visible.
fn ingest_kanban(root: &Path, out: &mut Vec<TimelineEvent>) {
    let Ok(entries) = fs::read_dir(root.join("cockpit").join("projects")) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(text) = fs::read_to_string(entry.path().join("kanban.json")) else {
            continue;
        };
        let Ok(board) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let project = entry.file_name().to_string_lossy().to_string();
        ingest_board(&project, &board, out);
    }
}

fn ingest_board(project: &str, board: &serde_json::Value, out: &mut Vec<TimelineEvent>) {
    let str_of =
        |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let columns: HashMap<String, String> = board
        .get("columns")
        .and_then(|x| x.as_array())
        .map(|cols| {
            cols.iter()
                .filter_map(|c| {
                    let id = str_of(c, "id")?;
                    let label = str_of(c, "role")
                        .filter(|r| !r.is_empty() && r != "other")
                        .or_else(|| str_of(c, "name"))
                        .unwrap_or_else(|| "?".to_string());
                    Some((id, label))
                })
                .collect()
        })
        .unwrap_or_default();
    let Some(cards) = board.get("cards").and_then(|x| x.as_array()) else {
        return;
    };
    for card in cards {
        let title = str_of(card, "title").unwrap_or_default();
        let summary = truncate_summary(&format!("{} · {}", project, title), 160);
        let created = str_of(card, "created_at").and_then(|r| card_ts(&r));
        let updated = str_of(card, "updated_at").and_then(|r| card_ts(&r));
        if let Some(ts) = created.clone() {
            push_event(out, ts, "kanban", "created".to_string(), summary.clone());
        }
        if let Some(ts) = updated.filter(|u| Some(u) != created.as_ref()) {
            let column = str_of(card, "column_id")
                .and_then(|id| columns.get(&id).cloned())
                .unwrap_or_else(|| "?".to_string());
            push_event(out, ts, "kanban", format!("updated:{}", column), summary);
        }
    }
}

fn push_event(
    out: &mut Vec<TimelineEvent>,
    ts: String,
    source: &str,
    kind: String,
    summary: String,
) {
    let Some(day) = ts_to_day(&ts) else { return };
    out.push(TimelineEvent {
        ts,
        day,
        source: source.to_string(),
        kind,
        summary,
    });
}

/// Convert a "epoch:<secs>" string (legacy kanban TS format) to ISO 8601.
/// Self-contained epoch->ISO formatter. Returns None when the value is not a
/// parseable epoch.
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
}

fn ingest_alerts(root: &Path, out: &mut Vec<TimelineEvent>) {
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

/// Every live source under `root` (`~/.ultron`), unsorted and unfiltered.
fn collect_events(root: &Path) -> Vec<TimelineEvent> {
    let mut events: Vec<TimelineEvent> = Vec::new();
    ingest_alerts(root, &mut events);
    ingest_routing(root, &mut events);
    ingest_kanban(root, &mut events);
    events
}

/// Aggregate all timeline sources, clamp to the requested window, sort
/// descending, and build the day/source count matrix for the heatmap.
///
/// `days`: how many days of history to include (e.g. 7, 30). Values outside
/// 1..=365 are clamped to 30.
pub fn compute_activity_timeline_inner(days: u32) -> Result<TimelineSummary, String> {
    let root = ultron_root().ok_or_else(|| "no HOME".to_string())?;
    let window = if days == 0 || days > 365 { 30 } else { days };
    let cutoff = cutoff_day(window);

    let mut events = collect_events(&root);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn escribe(root: &Path, rel: &str, contenido: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("padre")).expect("mkdir");
        fs::write(path, contenido).expect("write");
    }

    #[test]
    fn routing_y_kanban_entran_en_la_linea_de_tiempo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        escribe(
            root,
            "logs/route-decisions.jsonl",
            concat!(
                r#"{"ts":"2026-10-17T01:03:24Z","zone":"chat","model":"m1","provider_id":"groq","used_fallback":false,"reason":"primary"}"#,
                "\n",
                "no es json\n",
                r#"{"ts":"2026-10-17T02:00:00Z","zone":"light","model":"m2","provider_id":"gemini","used_fallback":true,"reason":"groq 429"}"#,
                "\n"
            ),
        );
        escribe(
            root,
            "cockpit/projects/demo/kanban.json",
            r#"{"columns":[{"id":"c1","name":"Backlog","role":"todo"},{"id":"c4","name":"Done","role":"done"}],
               "cards":[{"id":"a","column_id":"c4","title":"Hecha","created_at":"epoch:1791000000","updated_at":"2026-10-16T10:00:00Z"},
                        {"id":"b","column_id":"c1","title":"Nueva","created_at":"2026-10-16T09:00:00Z","updated_at":"2026-10-16T09:00:00Z"}]}"#,
        );
        let events = collect_events(root);
        let routing: Vec<_> = events.iter().filter(|e| e.source == "routing").collect();
        assert_eq!(routing.len(), 2, "la línea malformada se salta");
        assert!(routing
            .iter()
            .any(|e| e.kind == "fallback" && e.summary.contains("groq 429")));
        let kanban: Vec<_> = events.iter().filter(|e| e.source == "kanban").collect();
        assert_eq!(kanban.len(), 3, "2 altas + 1 cambio (b no cambió)");
        assert!(kanban
            .iter()
            .any(|e| e.kind == "updated:done" && e.summary == "demo · Hecha"));
        assert!(kanban.iter().all(|e| e.day.len() == 10));
    }

    /// Una ruta con la cadena agotada sale como `failed`, no como `primary`.
    #[test]
    fn una_ruta_fallida_entra_como_failed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        escribe(
            root,
            "logs/route-decisions.jsonl",
            concat!(
                r#"{"ts":"2026-10-23T08:00:00Z","zone":"chat","model":"","provider_id":"","used_fallback":false,"reason":"failed","error":"all providers failed"}"#,
                "\n"
            ),
        );
        let events = collect_events(root);
        let routing: Vec<_> = events.iter().filter(|e| e.source == "routing").collect();
        assert_eq!(routing.len(), 1);
        assert_eq!(routing[0].kind, "failed");
        assert!(
            routing[0].summary.contains("sin respuesta"),
            "{}",
            routing[0].summary
        );
    }

    #[test]
    fn las_fuentes_retiradas_ya_no_se_leen() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let linea = r#"{"ts":"2026-10-17T00:00:00Z","event":"x","tool":"y"}"#;
        for rel in [
            ".tmp/hiper-plans-signals.jsonl",
            ".tmp/doctor-fix-log.jsonl",
            ".tmp/prompt-feedback.jsonl",
            ".tmp/token-usage.jsonl",
            "cockpit/auto_updater.jsonl",
            "cockpit/mcp-audit.jsonl",
        ] {
            escribe(root, rel, linea);
        }
        assert!(collect_events(root).is_empty());
    }
}
