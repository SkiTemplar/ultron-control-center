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

pub fn claude_usage_inner() -> Result<UsageReport, String> {
    let path = cache_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read stats-cache.json: {}", e))?;
    let cache: StatsCache = serde_json::from_str(&raw)
        .map_err(|e| format!("parse stats-cache.json: {}", e))?;

    let today = today_utc_iso();
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
