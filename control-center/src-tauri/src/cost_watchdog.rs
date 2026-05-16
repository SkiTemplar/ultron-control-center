// ULTRON Control Center — Cost Watchdog
//
// Reads ~/.ultron/.tmp/token-usage.jsonl (rolling token probe log) and
// projects daily token + USD burn from the last N hours. Surfaces a
// warning when projected daily cost crosses a safe threshold so the
// user can swap zones in the AI Router before a bill arrives.
//
// Caveats:
//   - USD figures are ROUGH averages, blending input/output rates.
//     Real pricing is per-million-input vs per-million-output, varies
//     by model+vendor, and changes over time. We deliberately publish
//     a low/high RANGE rather than a point estimate.
//   - token-usage.jsonl historically uses `layer` (L0/L1/L2) as the
//     bucket key (context probes, not API calls). We prefer `model`
//     if present, fall back to `layer`, and last-resort to "unknown".
//   - Codex and Gemini are flat $0 for the user's subscriptions.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// JSONL row shape — permissive: tokens may live under several keys, the
// bucket label may be `model` or `layer`. We tolerate missing fields and
// silently skip rows that don't parse.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Row {
    ts: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    layer: Option<String>,
    // Tokens may be `tokens`, `total_tokens`, or split input/output.
    #[serde(default)]
    tokens: Option<u64>,
    #[serde(default)]
    total_tokens: Option<u64>,
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
}

impl Row {
    fn bucket(&self) -> String {
        if let Some(m) = self.model.as_ref() {
            if !m.is_empty() {
                return m.clone();
            }
        }
        if let Some(l) = self.layer.as_ref() {
            if !l.is_empty() {
                return l.clone();
            }
        }
        "unknown".to_string()
    }

    fn tokens(&self) -> u64 {
        if let Some(t) = self.tokens {
            return t;
        }
        if let Some(t) = self.total_tokens {
            return t;
        }
        self.input_tokens.unwrap_or(0) + self.output_tokens.unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// Output shape consumed by CostWatchdog.tsx
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct CostSnapshot {
    pub window_hours: u32,
    pub total_tokens: u64,
    pub projected_daily_tokens: u64,
    pub projected_daily_usd_low: f64,
    pub projected_daily_usd_high: f64,
    pub top_models: Vec<(String, u64)>,
    pub alert: Option<String>,
}

// ---------------------------------------------------------------------------
// Pricing table — rough averages in USD per 1M tokens, blending input and
// output rates (output is usually 4-5x input). Documented in module header.
// Returns (low, high) so the UI can show a range and we never claim more
// precision than we have.
// ---------------------------------------------------------------------------

fn usd_per_million(model: &str) -> (f64, f64) {
    let m = model.to_ascii_lowercase();
    // Subscription-paid models: $0 to the user.
    if m.contains("codex") || m.contains("gpt-5") || m.contains("gpt5") {
        return (0.0, 0.0);
    }
    if m.contains("gemini") {
        return (0.0, 0.0);
    }
    // Claude family — blended averages. Real cost depends on i/o mix.
    if m.contains("opus") {
        // input $15/M, output $75/M -> blended ~$30/M (low) to $45/M (high)
        return (30.0, 45.0);
    }
    if m.contains("sonnet") {
        // input $3/M, output $15/M -> blended ~$5/M (low) to $9/M (high)
        return (5.0, 9.0);
    }
    if m.contains("haiku") {
        // input $0.80/M, output $4/M -> blended ~$1.5/M (low) to $2.5/M (high)
        return (1.5, 2.5);
    }
    // Layer buckets (L0/L1/L2) are context-window probes, not API calls.
    // They shouldn't be billed but we surface them so the watchdog still
    // reports volume; treat as free.
    if m == "l0" || m == "l1" || m == "l2" {
        return (0.0, 0.0);
    }
    // Unknown bucket — assume mid-tier so we don't under-warn.
    (3.0, 7.0)
}

// ---------------------------------------------------------------------------
// Time helpers — ts is ISO-8601 UTC (e.g. "2026-05-15T23:58:46Z").
// We parse just enough to get epoch seconds. No chrono dep on purpose.
// ---------------------------------------------------------------------------

fn parse_iso_to_epoch(ts: &str) -> Option<i64> {
    // Expect YYYY-MM-DDTHH:MM:SSZ (length >= 20). Be tolerant of fractional
    // seconds and missing Z.
    let bytes = ts.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i64 = ts.get(0..4)?.parse().ok()?;
    let month: i64 = ts.get(5..7)?.parse().ok()?;
    let day: i64 = ts.get(8..10)?.parse().ok()?;
    let hour: i64 = ts.get(11..13)?.parse().ok()?;
    let minute: i64 = ts.get(14..16)?.parse().ok()?;
    let second: i64 = ts.get(17..19)?.parse().ok()?;
    if month < 1 || month > 12 || day < 1 || day > 31 {
        return None;
    }
    // Days from 1970-01-01 to start of `year`
    let mut days: i64 = 0;
    for y in 1970..year {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        days += if leap { 366 } else { 365 };
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 0..(month as usize - 1) {
        days += mdays[m];
    }
    days += day - 1;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

fn token_usage_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron/.tmp/token-usage.jsonl"))
        .ok_or_else(|| "No HOME dir".to_string())
}

fn read_tail_rows(path: PathBuf, max_lines: usize) -> Result<Vec<Row>, String> {
    let file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return Ok(Vec::new()), // missing file = no cost data yet
    };
    let reader = BufReader::new(file);
    let mut lines: Vec<String> = Vec::new();
    for line in reader.lines().flatten() {
        if !line.trim().is_empty() {
            lines.push(line);
        }
    }
    let n = lines.len();
    let start = if n > max_lines { n - max_lines } else { 0 };
    let mut out: Vec<Row> = Vec::with_capacity(n - start);
    for l in &lines[start..] {
        if let Ok(r) = serde_json::from_str::<Row>(l) {
            out.push(r);
        }
    }
    Ok(out)
}

pub fn compute_cost_inner(window_hours: u32) -> Result<CostSnapshot, String> {
    let hours = window_hours.clamp(1, 168);
    let path = token_usage_path()?;
    let rows = read_tail_rows(path, 1000)?;

    let now = now_epoch();
    let cutoff = now - (hours as i64) * 3600;

    // Aggregate tokens per bucket inside the window
    let mut by_bucket: HashMap<String, u64> = HashMap::new();
    let mut total: u64 = 0;
    for r in &rows {
        let ts = match r.ts.as_ref().and_then(|s| parse_iso_to_epoch(s)) {
            Some(t) => t,
            None => continue,
        };
        if ts < cutoff {
            continue;
        }
        let t = r.tokens();
        if t == 0 {
            continue;
        }
        let b = r.bucket();
        *by_bucket.entry(b).or_insert(0) += t;
        total += t;
    }

    // Project to a full 24h day — straight-line extrapolation.
    // Caveat: assumes uniform usage; bursty days will under-project from a
    // quiet window and over-project from a peak window. The user-selectable
    // window mitigates this.
    let projected_daily_tokens: u64 = if hours == 0 {
        0
    } else {
        ((total as f64 / hours as f64) * 24.0).round() as u64
    };

    // USD range — sum per-bucket, weighted by that bucket's share of
    // total tokens (so unknown models get a fair-ish guess).
    let mut usd_low = 0.0_f64;
    let mut usd_high = 0.0_f64;
    for (bucket, tokens) in &by_bucket {
        let share = *tokens as f64 / total.max(1) as f64;
        let projected_for_bucket = projected_daily_tokens as f64 * share;
        let (lo, hi) = usd_per_million(bucket);
        usd_low += (projected_for_bucket / 1_000_000.0) * lo;
        usd_high += (projected_for_bucket / 1_000_000.0) * hi;
    }

    // Top 5 buckets, sorted by tokens desc
    let mut top: Vec<(String, u64)> = by_bucket.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1));
    top.truncate(5);

    let alert = if usd_high > 20.0 {
        Some(format!(
            "Projected daily cost above $20 (high estimate ${:.2}). Consider switching some zones to Codex or Gemini in Settings → AI Router.",
            usd_high
        ))
    } else {
        None
    };

    Ok(CostSnapshot {
        window_hours: hours,
        total_tokens: total,
        projected_daily_tokens,
        projected_daily_usd_low: round2(usd_low),
        projected_daily_usd_high: round2(usd_high),
        top_models: top,
        alert,
    })
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}
