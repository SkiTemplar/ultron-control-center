// ULTRON Control Center — Self-improvement signals.
//
// Reads three local telemetry sources:
//   - ~/.ultron/.tmp/routing-telemetry.jsonl   (intent → skill matches)
//   - ~/.ultron/skills/registry.json            (skill usage counts)
//   - ~/.ultron/alerts.jsonl                    (recent errors)
//
// All inputs are best-effort; missing files don't fail the report.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize, Clone)]
pub struct IntentCount {
    pub intent: String,
    pub count: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct SkillCount {
    pub skill: String,
    pub count: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ErrorEntry {
    pub source: String,
    pub message: String,
    pub ts: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionMetric {
    pub label: String,
    pub value: f64,
    pub unit: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct HookSignal {
    pub source: String,
    pub kind: String,
    pub ts: String,
    pub summary: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SelfImproveReport {
    pub total_routes: u64,
    pub matched_routes: u64,
    pub top_intents: Vec<IntentCount>,
    pub top_skills: Vec<SkillCount>,
    pub recent_errors: Vec<ErrorEntry>,
    /// Session usage rollups computed from ~/.claude/projects/*.jsonl.
    /// Includes counts, average session duration, top-active days.
    #[serde(default)]
    pub session_metrics: Vec<SessionMetric>,
    /// Top-N memory notes by recent access (mtime). Surfaces what the user
    /// actually reads vs. what gets indexed but never opened.
    #[serde(default)]
    pub recent_memory_paths: Vec<String>,
    /// Aggregated, normalised hook telemetry (hyper-plan signals,
    /// doctor fixes, prompt feedback, token usage, auto-updater,
    /// MCP audit). Top 30 most recent across all six sources.
    #[serde(default)]
    pub hook_signals: Vec<HookSignal>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ReviewResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

fn ultron_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn parse_iso_to_secs(iso: &str) -> Option<u64> {
    // Accept "YYYY-MM-DDTHH:MM:SS(Z|±offset)?" — we only need a rough age,
    // so an inexact parse is fine.
    let s = iso.trim_end_matches('Z');
    let s = s.split('+').next()?;
    let mut parts = s.split('T');
    let date = parts.next()?;
    let time = parts.next().unwrap_or("00:00:00");
    let d: Vec<&str> = date.split('-').collect();
    if d.len() != 3 {
        return None;
    }
    let year: i64 = d[0].parse().ok()?;
    let month: u32 = d[1].parse().ok()?;
    let day: u32 = d[2].parse().ok()?;
    let t: Vec<&str> = time.split(':').collect();
    let h: u64 = t.get(0).and_then(|x| x.parse().ok()).unwrap_or(0);
    let mi: u64 = t.get(1).and_then(|x| x.parse().ok()).unwrap_or(0);
    let se: u64 = t.get(2).and_then(|x| x.parse().ok()).unwrap_or(0);
    // Days since epoch — naive (no leap-second / DST corrections).
    let mut total_days: i64 = 0;
    for y in 1970..year {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        total_days += if leap { 366 } else { 365 };
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [u32; 12] = [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    for m in 0..(month as usize - 1).min(12) {
        total_days += mdays[m] as i64;
    }
    total_days += (day - 1) as i64;
    if total_days < 0 {
        return None;
    }
    Some(total_days as u64 * 86_400 + h * 3600 + mi * 60 + se)
}

// ---------------------------------------------------------------------------
// Routing telemetry
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RouteRow {
    #[serde(default)]
    intent: Option<String>,
    #[serde(default)]
    matched: Option<bool>,
    #[serde(default)]
    routed_to: Option<String>,
    #[serde(default)]
    skill: Option<String>,
}

fn read_routing(root: &PathBuf) -> (u64, u64, Vec<IntentCount>) {
    let path = root.join(".tmp/routing-telemetry.jsonl");
    let Ok(raw) = fs::read_to_string(&path) else {
        return (0, 0, Vec::new());
    };
    let mut total = 0u64;
    let mut matched = 0u64;
    let mut by_intent: BTreeMap<String, u64> = BTreeMap::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let row: RouteRow = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        total += 1;
        if row.matched.unwrap_or(false) {
            matched += 1;
        }
        if let Some(intent) = row.intent {
            *by_intent.entry(intent).or_insert(0) += 1;
        }
    }
    let mut top: Vec<IntentCount> = by_intent
        .into_iter()
        .map(|(intent, count)| IntentCount { intent, count })
        .collect();
    top.sort_by(|a, b| b.count.cmp(&a.count));
    top.truncate(10);
    (total, matched, top)
}

// ---------------------------------------------------------------------------
// Skill usage (registry)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RegistryRoot {
    #[serde(default)]
    skills: BTreeMap<String, RegistrySkill>,
}

#[derive(Debug, Deserialize)]
struct RegistrySkill {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    usage_count: u64,
}

fn read_skill_usage(root: &PathBuf) -> Vec<SkillCount> {
    let path = root.join("skills/registry.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let parsed: RegistryRoot = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let mut rows: Vec<SkillCount> = parsed
        .skills
        .into_iter()
        .filter_map(|(key, s)| {
            if s.usage_count == 0 {
                return None;
            }
            let name = s.name.unwrap_or_else(|| {
                key.split("::").nth(1).unwrap_or(&key).to_string()
            });
            Some(SkillCount { skill: name, count: s.usage_count })
        })
        .collect();
    rows.sort_by(|a, b| b.count.cmp(&a.count));
    rows.truncate(10);
    rows
}

// ---------------------------------------------------------------------------
// Recent errors
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct AlertRow {
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    ts: Option<String>,
}

fn read_recent_errors(root: &PathBuf) -> Vec<ErrorEntry> {
    let path = root.join("alerts.jsonl");
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let cutoff = now_secs().saturating_sub(86_400); // last 24h
    let mut rows: Vec<ErrorEntry> = Vec::new();
    for line in raw.lines().rev().take(1000) {
        if line.trim().is_empty() {
            continue;
        }
        let r: AlertRow = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let sev = r.severity.unwrap_or_default();
        if !matches!(sev.as_str(), "critical" | "blocking" | "warn") {
            continue;
        }
        let ts = r.timestamp.or(r.ts).unwrap_or_default();
        if let Some(secs) = parse_iso_to_secs(&ts) {
            if secs < cutoff {
                continue;
            }
        }
        rows.push(ErrorEntry {
            source: r.source.unwrap_or_else(|| "unknown".to_string()),
            message: r.message.unwrap_or_default(),
            ts,
        });
        if rows.len() >= 20 {
            break;
        }
    }
    rows
}

pub fn self_improve_report_inner() -> Result<SelfImproveReport, String> {
    let root = ultron_root().ok_or_else(|| "no HOME".to_string())?;
    let (total_routes, matched_routes, top_intents) = read_routing(&root);
    let top_skills = read_skill_usage(&root);
    let recent_errors = read_recent_errors(&root);
    let session_metrics = compute_session_metrics().unwrap_or_default();
    let recent_memory_paths = recent_memory_paths(10);
    let hook_signals = read_hook_signals(&root);
    Ok(SelfImproveReport {
        total_routes,
        matched_routes,
        top_intents,
        top_skills,
        recent_errors,
        session_metrics,
        recent_memory_paths,
        hook_signals,
    })
}

// ---------------------------------------------------------------------------
// Hook signals — multi-source JSONL aggregator
// ---------------------------------------------------------------------------

fn read_tail_lines(path: &PathBuf, max_lines: usize) -> Vec<String> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
    let n = lines.len();
    let start = if n > max_lines { n - max_lines } else { 0 };
    lines[start..].iter().map(|s| s.to_string()).collect()
}

fn truncate_summary(s: &str, max: usize) -> String {
    let cleaned = s.replace('\n', " ").replace('\r', " ");
    if cleaned.chars().count() <= max {
        return cleaned;
    }
    let mut out: String = cleaned.chars().take(max).collect();
    out.push('…');
    out
}

/// Aggregate the six JSONL telemetry sources into a single, normalised list.
/// Reads last 200 lines per file (so we sample recent history without
/// blowing memory on huge logs) then takes the top 30 globally by timestamp.
pub fn read_hook_signals(root: &PathBuf) -> Vec<HookSignal> {
    let mut out: Vec<HookSignal> = Vec::new();

    // 1. hyper-plan signals — { ts, signal, mode, prompt_preview }
    for line in read_tail_lines(&root.join(".tmp/hiper-plans-signals.jsonl"), 200) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let ts = v.get("ts").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let kind = v
            .get("signal")
            .and_then(|x| x.as_str())
            .unwrap_or("signal")
            .to_string();
        let mode = v.get("mode").and_then(|x| x.as_str()).unwrap_or("");
        let preview = v.get("prompt_preview").and_then(|x| x.as_str()).unwrap_or("");
        let summary = if mode.is_empty() {
            preview.to_string()
        } else {
            format!("[{}] {}", mode, preview)
        };
        out.push(HookSignal {
            source: "hyper-plans".to_string(),
            kind,
            ts,
            summary: truncate_summary(&summary, 140),
        });
    }

    // 2. doctor-fix-log — { ts, finding_id, fix_action, exit_code }
    for line in read_tail_lines(&root.join(".tmp/doctor-fix-log.jsonl"), 200) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let ts = v.get("ts").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let finding = v.get("finding_id").and_then(|x| x.as_str()).unwrap_or("");
        let action = v.get("fix_action").and_then(|x| x.as_str()).unwrap_or("");
        let exit_code = v.get("exit_code").and_then(|x| x.as_i64());
        let exit_part = match exit_code {
            Some(c) => format!(" (exit {})", c),
            None => String::new(),
        };
        let summary = format!("{} -> {}{}", finding, action, exit_part);
        out.push(HookSignal {
            source: "doctor".to_string(),
            kind: action.to_string(),
            ts,
            summary: truncate_summary(&summary, 140),
        });
    }

    // 3. prompt-feedback — { ts, session_id, kind, target, output_chars }
    for line in read_tail_lines(&root.join(".tmp/prompt-feedback.jsonl"), 200) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let ts = v.get("ts").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let kind = v
            .get("kind")
            .and_then(|x| x.as_str())
            .unwrap_or("feedback")
            .to_string();
        let target = v.get("target").and_then(|x| x.as_str()).unwrap_or("");
        let chars = v.get("output_chars").and_then(|x| x.as_i64()).unwrap_or(0);
        let summary = format!("{} ({} chars)", target, chars);
        out.push(HookSignal {
            source: "prompt-feedback".to_string(),
            kind,
            ts,
            summary: truncate_summary(&summary, 140),
        });
    }

    // 4. token-usage — { ts, layer, tokens, limit }
    for line in read_tail_lines(&root.join(".tmp/token-usage.jsonl"), 200) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let ts = v.get("ts").and_then(|x| x.as_str()).unwrap_or("").to_string();
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
        out.push(HookSignal {
            source: "token-usage".to_string(),
            kind: layer,
            ts,
            summary: truncate_summary(&summary, 140),
        });
    }

    // 5. auto_updater — { ts, action, target, model, exit_code }
    for line in read_tail_lines(&root.join("cockpit/auto_updater.jsonl"), 200) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let ts = v.get("ts").and_then(|x| x.as_str()).unwrap_or("").to_string();
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
        out.push(HookSignal {
            source: "auto-updater".to_string(),
            kind: action,
            ts,
            summary: truncate_summary(&summary, 140),
        });
    }

    // 6. mcp-audit — { event, server, detail?, ts }
    for line in read_tail_lines(&root.join("cockpit/mcp-audit.jsonl"), 200) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let ts = v.get("ts").and_then(|x| x.as_str()).unwrap_or("").to_string();
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
        out.push(HookSignal {
            source: "mcp-audit".to_string(),
            kind: event,
            ts,
            summary: truncate_summary(&summary, 140),
        });
    }

    // Sort descending by timestamp lexically — ISO 8601 sorts correctly as
    // string. Entries with empty ts go to the bottom.
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out.truncate(30);
    out
}

/// Scan ~/.claude/projects/*.jsonl to compute aggregate session metrics:
/// total sessions, total messages, avg session duration (between first and
/// last timestamp in a transcript), and last-7-days activity. All bounded
/// reads — we only peek first/last line per file.
fn compute_session_metrics() -> Option<Vec<SessionMetric>> {
    let dir = dirs::home_dir()?.join(".claude/projects");
    if !dir.exists() {
        return None;
    }
    let mut sessions: u64 = 0;
    let mut total_messages: u64 = 0;
    let mut total_minutes: f64 = 0.0;
    let mut sessions_with_duration: u64 = 0;
    let now_iso = chrono_today_iso();
    let week_ago = days_ago_iso(7);
    let mut last_week_sessions: u64 = 0;

    for project in std::fs::read_dir(&dir).ok()?.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&project_path) else { continue };
        for f in rd.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if p.parent()
                .and_then(|x| x.file_name())
                .map(|n| n == "subagents")
                .unwrap_or(false)
            {
                continue;
            }
            sessions += 1;
            // Count lines = upper bound on messages. Bounded read at 5MB
            // for big transcripts.
            let raw = match std::fs::read_to_string(&p) {
                Ok(s) if s.len() <= 5_000_000 => s,
                Ok(s) => s.chars().take(2_000_000).collect(),
                Err(_) => continue,
            };
            let mut first_ts: Option<String> = None;
            let mut last_ts: Option<String> = None;
            let mut msg_count: u64 = 0;
            for line in raw.lines() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    let typ = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                    if typ == "user" || typ == "assistant" {
                        msg_count += 1;
                    }
                    if let Some(ts) = v.get("timestamp").and_then(|x| x.as_str()) {
                        if first_ts.is_none() {
                            first_ts = Some(ts.to_string());
                        }
                        last_ts = Some(ts.to_string());
                    }
                }
            }
            total_messages += msg_count;
            if let (Some(a), Some(b)) = (first_ts.as_deref(), last_ts.as_deref()) {
                if let (Some(ta), Some(tb)) = (parse_iso_secs(a), parse_iso_secs(b)) {
                    let mins = ((tb.saturating_sub(ta)) as f64) / 60.0;
                    if mins > 0.0 && mins < 24.0 * 60.0 {
                        total_minutes += mins;
                        sessions_with_duration += 1;
                    }
                }
                if a.starts_with(&week_ago[..10]) || a > week_ago.as_str() {
                    last_week_sessions += 1;
                }
            }
        }
    }
    let avg_dur = if sessions_with_duration > 0 {
        total_minutes / sessions_with_duration as f64
    } else {
        0.0
    };
    let avg_msgs = if sessions > 0 {
        total_messages as f64 / sessions as f64
    } else {
        0.0
    };
    Some(vec![
        SessionMetric {
            label: "Total sessions".into(),
            value: sessions as f64,
            unit: "".into(),
        },
        SessionMetric {
            label: "Sessions last 7d".into(),
            value: last_week_sessions as f64,
            unit: "".into(),
        },
        SessionMetric {
            label: "Total messages".into(),
            value: total_messages as f64,
            unit: "".into(),
        },
        SessionMetric {
            label: "Avg messages per session".into(),
            value: (avg_msgs * 10.0).round() / 10.0,
            unit: "msgs".into(),
        },
        SessionMetric {
            label: "Avg session duration".into(),
            value: (avg_dur * 10.0).round() / 10.0,
            unit: "min".into(),
        },
        SessionMetric {
            label: "Today".into(),
            value: now_iso[..10].parse::<f64>().unwrap_or(0.0),
            unit: "".into(),
        },
    ])
}

fn recent_memory_paths(limit: usize) -> Vec<String> {
    let dir = match dirs::home_dir().map(|h| h.join(".ultron-vault")) {
        Some(d) if d.exists() => d,
        _ => return Vec::new(),
    };
    let mut entries: Vec<(SystemTime, PathBuf)> = Vec::new();
    fn walk(root: &PathBuf, vault: &PathBuf, out: &mut Vec<(SystemTime, PathBuf)>) {
        let Ok(rd) = std::fs::read_dir(root) else { return };
        for f in rd.flatten() {
            let p = f.path();
            // Skip dotfile children of the vault.
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') && p != *vault {
                    continue;
                }
            }
            if p.is_dir() {
                walk(&p, vault, out);
            } else if p.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Ok(meta) = f.metadata() {
                    if let Ok(t) = meta.modified() {
                        out.push((t, p));
                    }
                }
            }
        }
    }
    walk(&dir, &dir, &mut entries);
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries
        .into_iter()
        .take(limit)
        .filter_map(|(_, p)| {
            p.strip_prefix(&dir)
                .ok()
                .map(|rel| rel.to_string_lossy().to_string())
        })
        .collect()
}

fn chrono_today_iso() -> String {
    let secs = now_secs();
    iso_from_secs(secs)
}

fn days_ago_iso(days: u64) -> String {
    let secs = now_secs().saturating_sub(days * 86_400);
    iso_from_secs(secs)
}

fn iso_from_secs(secs: u64) -> String {
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
    let mdays: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] { days -= mdays[month]; month += 1; }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month + 1, days + 1, h, m, s)
}

fn parse_iso_secs(s: &str) -> Option<u64> {
    // Minimal YYYY-MM-DDTHH:MM:SS parser. Tolerant to fractional seconds
    // and Z suffix.
    if s.len() < 19 { return None; }
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let mo: i64 = s.get(5..7)?.parse().ok()?;
    let d: i64 = s.get(8..10)?.parse().ok()?;
    let hh: i64 = s.get(11..13)?.parse().ok()?;
    let mm: i64 = s.get(14..16)?.parse().ok()?;
    let ss: i64 = s.get(17..19)?.parse().ok()?;
    // Days since 1970-01-01
    let mut days: i64 = 0;
    for year in 1970..y {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        days += if leap { 366 } else { 365 };
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let mdays: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 0..(mo as usize - 1).min(11) {
        days += mdays[m];
    }
    days += d - 1;
    let secs = (days as u64) * 86_400 + (hh as u64) * 3600 + (mm as u64) * 60 + ss as u64;
    Some(secs)
}

// ---------------------------------------------------------------------------
// Codex adversarial review (read-only)
// ---------------------------------------------------------------------------

pub async fn run_codex_adversarial_review_inner(
    app: &tauri::AppHandle,
) -> Result<ReviewResult, String> {
    // Route through run-inline.ps1 so the prompt isn't subject to cmd.exe
    // quoting weirdness. Codex needs to run with cwd = ~/.ultron so
    // `git diff` sees the actual repo (previously inherited the Tauri exe
    // cwd which is the WindowsApps install dir → "not a git repository").
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let ultron_repo = home.join(".ultron");
    let script = home.join(".ultron/scripts/cockpit/run-inline.ps1");
    let prompt = "Read the current git diff in this repo (run `git diff --stat HEAD~10` if needed). Challenge the most recent design decisions: name 3 risks I'm probably missing, and 1 thing I should reverse. Stay read-only.";
    let payload_json = serde_json::json!({
        "provider": "codex",
        "prompt": prompt,
        "model": "",
    })
    .to_string();
    let payload = crate::sessions::base64_encode(&payload_json);
    let script_str = script.to_string_lossy().to_string();
    let ultron_str = ultron_repo.to_string_lossy().to_string();

    let output = app
        .shell()
        .command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_str,
            "-Payload",
            &payload,
        ])
        .current_dir(&ultron_str)
        .output()
        .await
        .map_err(|e| format!("spawn powershell: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // run-inline.ps1 emits a JSON object; if parsing fails fall back to the
    // raw text so the user still sees something.
    #[derive(serde::Deserialize)]
    struct Inner { success: bool, stdout: String, stderr: String }
    match serde_json::from_str::<Inner>(stdout.trim()) {
        Ok(i) => Ok(ReviewResult {
            success: i.success,
            stdout: i.stdout,
            stderr: i.stderr,
        }),
        Err(_) => Ok(ReviewResult {
            success: output.status.success(),
            stdout,
            stderr,
        }),
    }
}
