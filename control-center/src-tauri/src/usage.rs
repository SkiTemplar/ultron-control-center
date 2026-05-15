// ULTRON Control Center — Usage module.
//
// Reads ~/.claude/stats-cache.json (Claude Code's own usage rollup) and
// reshapes it for the GUI: window aggregates (today/7d/30d/all-time),
// per-model totals, and a recent daily series for sparkline rendering.
//
// Note: Anthropic's weekly limit/remaining is NOT in this local cache;
// /usage in Claude Code fetches that interactively from the server.
// We surface the *consumption* numbers ULTRON can compute from disk.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Raw stats-cache.json shape
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct StatsCache {
    #[serde(default, rename = "lastComputedDate")]
    last_computed_date: Option<String>,
    #[serde(default, rename = "dailyActivity")]
    daily_activity: Vec<DailyActivity>,
    #[serde(default, rename = "dailyModelTokens")]
    daily_model_tokens: Vec<DailyModelTokens>,
    #[serde(default, rename = "modelUsage")]
    model_usage: BTreeMap<String, ModelUsage>,
    #[serde(default, rename = "totalSessions")]
    total_sessions: u64,
    #[serde(default, rename = "totalMessages")]
    total_messages: u64,
    #[serde(default, rename = "firstSessionDate")]
    first_session_date: Option<String>,
    #[serde(default, rename = "hourCounts")]
    hour_counts: BTreeMap<String, u64>,
}

#[derive(Debug, Deserialize)]
struct DailyActivity {
    date: String,
    #[serde(default, rename = "messageCount")]
    message_count: u64,
    #[serde(default, rename = "sessionCount")]
    session_count: u64,
    #[serde(default, rename = "toolCallCount")]
    tool_call_count: u64,
}

#[derive(Debug, Deserialize)]
struct DailyModelTokens {
    date: String,
    #[serde(default, rename = "tokensByModel")]
    tokens_by_model: BTreeMap<String, u64>,
}

#[derive(Debug, Deserialize)]
struct ModelUsage {
    #[serde(default, rename = "inputTokens")]
    input_tokens: u64,
    #[serde(default, rename = "outputTokens")]
    output_tokens: u64,
    #[serde(default, rename = "cacheReadInputTokens")]
    cache_read_input_tokens: u64,
    #[serde(default, rename = "cacheCreationInputTokens")]
    cache_creation_input_tokens: u64,
}

// ---------------------------------------------------------------------------
// Shapes returned to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct UsageReport {
    pub last_computed_date: Option<String>,
    pub cache_age_days: Option<i64>,
    pub first_session_date: Option<String>,
    pub total_sessions: u64,
    pub total_messages: u64,

    pub today: WindowStats,
    pub last_7_days: WindowStats,
    pub last_30_days: WindowStats,

    pub model_totals: Vec<ModelStat>,
    pub daily_recent: Vec<DailyPoint>,
    pub hour_counts: Vec<u64>, // 24 entries, hour 0-23
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct WindowStats {
    pub days: u32,
    pub messages: u64,
    pub sessions: u64,
    pub tool_calls: u64,
    pub tokens_total: u64,
    pub tokens_by_model: BTreeMap<String, u64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ModelStat {
    pub name: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_create: u64,
    pub total: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct DailyPoint {
    pub date: String,
    pub messages: u64,
    pub sessions: u64,
    pub tool_calls: u64,
    pub tokens: u64,
}

// ---------------------------------------------------------------------------
// Date helpers (no chrono dep — we work with ISO strings only)
// ---------------------------------------------------------------------------

fn today_utc_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    epoch_to_date(secs as i64)
}

fn epoch_to_date(secs: i64) -> String {
    // YYYY-MM-DD calculation; reused from memory.rs logic, inlined for
    // module independence.
    let mut days = secs / 86_400;
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
    format!("{:04}-{:02}-{:02}", year, month + 1, days + 1)
}

fn iso_diff_days(a: &str, b: &str) -> Option<i64> {
    // Both inputs are YYYY-MM-DD (or longer ISO that we truncate).
    let pa = a.get(..10)?;
    let pb = b.get(..10)?;
    fn parse(s: &str) -> Option<i64> {
        let mut parts = s.split('-');
        let y: i32 = parts.next()?.parse().ok()?;
        let m: u32 = parts.next()?.parse().ok()?;
        let d: u32 = parts.next()?.parse().ok()?;
        // Days since 0001-01-01 (rough — only used for diffs).
        let mut total = 0i64;
        for yy in 1..y {
            let leap = (yy % 4 == 0 && yy % 100 != 0) || yy % 400 == 0;
            total += if leap { 366 } else { 365 };
        }
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let mdays: [i64; 12] = [
            31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
        ];
        for mm in 0..(m as usize - 1) {
            total += mdays[mm];
        }
        total += d as i64 - 1;
        Some(total)
    }
    Some(parse(pa)? - parse(pb)?)
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

fn cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/stats-cache.json"))
}

fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/projects"))
}

/// Recompute the stats fields from `~/.claude/projects/<slug>/<id>.jsonl`.
/// One pass per session file, parsing each `type: assistant` row's
/// `message.usage` block. Returns the same shape the cache file uses so the
/// downstream rollup code stays identical.
///
/// Bounded: walks only top-level .jsonl files (skips `subagents/`) since
/// subagent transcripts already carry their tokens against the parent
/// session. Reads with `BufReader` so a 50 MB transcript doesn't allocate
/// the whole thing.
fn compute_live_usage() -> Option<StatsCache> {
    use std::io::{BufRead, BufReader};
    let dir = projects_dir()?;
    if !dir.exists() {
        return None;
    }
    let mut sessions: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut messages: u64 = 0;
    let mut daily_msgs: BTreeMap<String, u64> = BTreeMap::new();
    let mut daily_sessions_seen: BTreeMap<String, std::collections::HashSet<String>> =
        BTreeMap::new();
    let mut daily_tools: BTreeMap<String, u64> = BTreeMap::new();
    let mut daily_model_tokens: BTreeMap<(String, String), u64> = BTreeMap::new();
    let mut model_totals: BTreeMap<String, ModelUsage> = BTreeMap::new();
    let mut hour_counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut earliest: Option<String> = None;

    for project in fs::read_dir(&dir).ok()?.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        let reader = match fs::read_dir(&project_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for f in reader.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let stem = match p.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let file = match fs::File::open(&p) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let buf = BufReader::new(file);
            for line in buf.lines().flatten() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let typ = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                let ts = v
                    .get("timestamp")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let date = if ts.len() >= 10 {
                    ts[..10].to_string()
                } else {
                    String::new()
                };
                if !date.is_empty() {
                    if earliest.as_ref().map(|e| &date < e).unwrap_or(true) {
                        earliest = Some(date.clone());
                    }
                    daily_sessions_seen
                        .entry(date.clone())
                        .or_default()
                        .insert(stem.clone());
                }
                match typ {
                    "user" => {
                        messages += 1;
                        if !date.is_empty() {
                            *daily_msgs.entry(date.clone()).or_insert(0) += 1;
                        }
                        if ts.len() >= 13 {
                            let h = &ts[11..13];
                            *hour_counts.entry(h.to_string()).or_insert(0) += 1;
                        }
                    }
                    "tool_use" => {
                        if !date.is_empty() {
                            *daily_tools.entry(date.clone()).or_insert(0) += 1;
                        }
                    }
                    "assistant" => {
                        let msg = v.get("message").cloned().unwrap_or(serde_json::Value::Null);
                        let model = msg
                            .get("model")
                            .and_then(|x| x.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let usage = msg.get("usage");
                        let inp = usage
                            .and_then(|u| u.get("input_tokens"))
                            .and_then(|n| n.as_u64())
                            .unwrap_or(0);
                        let out = usage
                            .and_then(|u| u.get("output_tokens"))
                            .and_then(|n| n.as_u64())
                            .unwrap_or(0);
                        let cache_read = usage
                            .and_then(|u| u.get("cache_read_input_tokens"))
                            .and_then(|n| n.as_u64())
                            .unwrap_or(0);
                        let cache_create = usage
                            .and_then(|u| u.get("cache_creation_input_tokens"))
                            .and_then(|n| n.as_u64())
                            .unwrap_or(0);
                        let entry = model_totals.entry(model.clone()).or_insert(ModelUsage {
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_read_input_tokens: 0,
                            cache_creation_input_tokens: 0,
                        });
                        entry.input_tokens += inp;
                        entry.output_tokens += out;
                        entry.cache_read_input_tokens += cache_read;
                        entry.cache_creation_input_tokens += cache_create;
                        if !date.is_empty() {
                            *daily_model_tokens
                                .entry((date.clone(), model.clone()))
                                .or_insert(0) +=
                                inp + out + cache_read + cache_create;
                        }
                    }
                    _ => {}
                }
            }
            sessions.insert(stem);
        }
    }

    let daily_activity: Vec<DailyActivity> = {
        let mut keys: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        keys.extend(daily_msgs.keys().cloned());
        keys.extend(daily_sessions_seen.keys().cloned());
        keys.extend(daily_tools.keys().cloned());
        keys.iter()
            .map(|date| DailyActivity {
                date: date.clone(),
                message_count: *daily_msgs.get(date).unwrap_or(&0),
                session_count: daily_sessions_seen
                    .get(date)
                    .map(|s| s.len() as u64)
                    .unwrap_or(0),
                tool_call_count: *daily_tools.get(date).unwrap_or(&0),
            })
            .collect()
    };
    let daily_model_tokens_vec: Vec<DailyModelTokens> = {
        let mut by_date: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
        for ((date, model), n) in daily_model_tokens.into_iter() {
            by_date.entry(date).or_default().insert(model, n);
        }
        by_date
            .into_iter()
            .map(|(date, tokens_by_model)| DailyModelTokens {
                date,
                tokens_by_model,
            })
            .collect()
    };

    Some(StatsCache {
        last_computed_date: Some(today_utc_iso()),
        daily_activity,
        daily_model_tokens: daily_model_tokens_vec,
        model_usage: model_totals,
        total_sessions: sessions.len() as u64,
        total_messages: messages,
        first_session_date: earliest,
        hour_counts,
    })
}

pub fn claude_usage_inner() -> Result<UsageReport, String> {
    let path = cache_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read stats-cache.json: {}", e))?;
    let mut cache: StatsCache = serde_json::from_str(&raw)
        .map_err(|e| format!("parse stats-cache.json: {}", e))?;

    let today = today_utc_iso();
    let cache_age_days = cache
        .last_computed_date
        .as_ref()
        .and_then(|d| iso_diff_days(&today, d));

    // Fallback: when the cache is older than 24h (Claude Code stopped
    // maintaining it in recent versions), scan ~/.claude/projects/*.jsonl
    // and recompute the rollups from scratch. The shape mirrors stats-cache
    // so the downstream code stays unchanged.
    if cache_age_days.map(|d| d > 0).unwrap_or(true) {
        if let Some(live) = compute_live_usage() {
            cache.daily_activity = live.daily_activity;
            cache.daily_model_tokens = live.daily_model_tokens;
            cache.model_usage = live.model_usage;
            cache.total_sessions = live.total_sessions;
            cache.total_messages = live.total_messages;
            cache.hour_counts = live.hour_counts;
            cache.last_computed_date = Some(today.clone());
        }
    }
    let cache_age_days = cache
        .last_computed_date
        .as_ref()
        .and_then(|d| iso_diff_days(&today, d));

    let mut report = UsageReport {
        last_computed_date: cache.last_computed_date.clone(),
        cache_age_days,
        first_session_date: cache.first_session_date.clone(),
        total_sessions: cache.total_sessions,
        total_messages: cache.total_messages,
        today: WindowStats {
            days: 1,
            ..Default::default()
        },
        last_7_days: WindowStats {
            days: 7,
            ..Default::default()
        },
        last_30_days: WindowStats {
            days: 30,
            ..Default::default()
        },
        model_totals: Vec::new(),
        daily_recent: Vec::new(),
        hour_counts: vec![0u64; 24],
    };

    // Aggregate dailyActivity into the 3 windows.
    for d in &cache.daily_activity {
        let age = iso_diff_days(&today, &d.date).unwrap_or(i64::MAX);
        if age == 0 {
            report.today.messages += d.message_count;
            report.today.sessions += d.session_count;
            report.today.tool_calls += d.tool_call_count;
        }
        if age >= 0 && age < 7 {
            report.last_7_days.messages += d.message_count;
            report.last_7_days.sessions += d.session_count;
            report.last_7_days.tool_calls += d.tool_call_count;
        }
        if age >= 0 && age < 30 {
            report.last_30_days.messages += d.message_count;
            report.last_30_days.sessions += d.session_count;
            report.last_30_days.tool_calls += d.tool_call_count;
        }
    }

    // Aggregate dailyModelTokens into the 3 windows, build daily_recent.
    let mut activity_by_date: BTreeMap<&str, &DailyActivity> = BTreeMap::new();
    for d in &cache.daily_activity {
        activity_by_date.insert(d.date.as_str(), d);
    }
    let mut tokens_by_date: BTreeMap<&str, &DailyModelTokens> = BTreeMap::new();
    for t in &cache.daily_model_tokens {
        tokens_by_date.insert(t.date.as_str(), t);
    }

    for t in &cache.daily_model_tokens {
        let age = iso_diff_days(&today, &t.date).unwrap_or(i64::MAX);
        let total: u64 = t.tokens_by_model.values().sum();
        if age == 0 {
            report.today.tokens_total += total;
            for (m, v) in &t.tokens_by_model {
                *report.today.tokens_by_model.entry(m.clone()).or_insert(0) += v;
            }
        }
        if age >= 0 && age < 7 {
            report.last_7_days.tokens_total += total;
            for (m, v) in &t.tokens_by_model {
                *report.last_7_days.tokens_by_model.entry(m.clone()).or_insert(0) += v;
            }
        }
        if age >= 0 && age < 30 {
            report.last_30_days.tokens_total += total;
            for (m, v) in &t.tokens_by_model {
                *report.last_30_days.tokens_by_model.entry(m.clone()).or_insert(0) += v;
            }
        }
    }

    // Build daily_recent: last 14 days, oldest first, joining activity + tokens.
    let mut all_dates: Vec<String> = activity_by_date.keys().map(|s| s.to_string()).collect();
    all_dates.sort();
    let recent = all_dates.iter().rev().take(14).collect::<Vec<_>>();
    let mut recent_sorted: Vec<&String> = recent.iter().cloned().collect();
    recent_sorted.sort();
    for date in recent_sorted {
        let act = activity_by_date.get(date.as_str());
        let tok = tokens_by_date.get(date.as_str());
        let tokens: u64 = tok
            .map(|t| t.tokens_by_model.values().sum())
            .unwrap_or(0);
        report.daily_recent.push(DailyPoint {
            date: date.clone(),
            messages: act.map(|a| a.message_count).unwrap_or(0),
            sessions: act.map(|a| a.session_count).unwrap_or(0),
            tool_calls: act.map(|a| a.tool_call_count).unwrap_or(0),
            tokens,
        });
    }

    // Per-model totals across all-time.
    for (name, mu) in &cache.model_usage {
        let total = mu.input_tokens
            + mu.output_tokens
            + mu.cache_read_input_tokens
            + mu.cache_creation_input_tokens;
        report.model_totals.push(ModelStat {
            name: name.clone(),
            input_tokens: mu.input_tokens,
            output_tokens: mu.output_tokens,
            cache_read: mu.cache_read_input_tokens,
            cache_create: mu.cache_creation_input_tokens,
            total,
        });
    }
    report.model_totals.sort_by(|a, b| b.total.cmp(&a.total));

    // Hour counts: keys are strings "0".."23"; some may be missing for hours
    // never used. We materialize a dense 24-slot vec.
    for (k, v) in &cache.hour_counts {
        if let Ok(h) = k.parse::<usize>() {
            if h < 24 {
                report.hour_counts[h] = *v;
            }
        }
    }

    Ok(report)
}
