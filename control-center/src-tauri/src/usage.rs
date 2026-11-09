// ULTRON Control Center — Usage module.
//
// Reads ~/.claude/stats-cache.json (Claude Code's own usage rollup) and
// reshapes it for the GUI: window aggregates (today/7d/30d/all-time),
// per-model totals, and a recent daily series for sparkline rendering.
//
// Note: Anthropic's weekly limit/remaining is NOT in this local cache;
// /usage in Claude Code fetches that interactively from the server.
// We surface the *consumption* numbers ULTRON can compute from disk.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Raw stats-cache.json shape
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
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
    /// De dónde salen las cifras: `stats-cache` (el rollup de Claude Code,
    /// solo si es de hoy) o `transcripts` (recalculado desde los .jsonl).
    pub source: &'static str,
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
        for d in mdays.iter().take(m as usize - 1) {
            total += d;
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

/// Una llamada al modelo dentro de un transcript. Claude Code escribe una línea
/// por bloque de contenido, así que el mismo `message.id` aparece varias veces:
/// se guarda una sola, la de más `output_tokens` (la última del streaming).
#[derive(Debug, Clone)]
struct AssistantCall {
    date: String,
    model: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_create: u64,
}

/// Agregado de un `.jsonl`: llamadas deduplicadas por id, prompts reales del
/// usuario (sin las filas `tool_result`) y bloques `tool_use` por id.
#[derive(Debug, Default)]
struct TranscriptAgg {
    calls: HashMap<String, AssistantCall>,
    tool_uses: HashMap<String, String>,
    prompt_timestamps: Vec<String>,
    dates: BTreeSet<String>,
}

fn u64_at(usage: Option<&serde_json::Value>, key: &str) -> u64 {
    usage
        .and_then(|u| u.get(key))
        .and_then(|n| n.as_u64())
        .unwrap_or(0)
}

/// Una fila `user` es un prompt de verdad si no es meta y no trae un
/// `tool_result` (Claude Code devuelve cada resultado de herramienta como fila
/// `user`; contarlas multiplicaba los mensajes). Tampoco lo es el resumen que
/// Claude Code inserta como fila `user` al compactar (`isCompactSummary`).
fn is_human_prompt(row: &serde_json::Value) -> bool {
    let flag = |key: &str| row.get(key).and_then(|x| x.as_bool()) == Some(true);
    if flag("isMeta") || flag("isCompactSummary") {
        return false;
    }
    match row.get("message").and_then(|m| m.get("content")) {
        Some(serde_json::Value::String(s)) => !s.trim().is_empty(),
        Some(serde_json::Value::Array(blocks)) => {
            !blocks.is_empty()
                && !blocks
                    .iter()
                    .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
        }
        _ => false,
    }
}

fn absorb_assistant(agg: &mut TranscriptAgg, row: &serde_json::Value, date: &str, line_no: usize) {
    let Some(msg) = row.get("message") else {
        return;
    };
    if let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) {
        for (i, b) in blocks.iter().enumerate() {
            if b.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }
            let id = b
                .get("id")
                .and_then(|x| x.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("#{line_no}:{i}"));
            agg.tool_uses.entry(id).or_insert_with(|| date.to_string());
        }
    }
    let model = msg.get("model").and_then(|x| x.as_str()).unwrap_or("");
    let usage = msg.get("usage");
    if usage.is_none() || model.is_empty() || model == "<synthetic>" || date.is_empty() {
        return;
    }
    let id = msg
        .get("id")
        .and_then(|x| x.as_str())
        .or_else(|| row.get("uuid").and_then(|x| x.as_str()))
        .map(str::to_string)
        .unwrap_or_else(|| format!("#{line_no}"));
    let call = AssistantCall {
        date: date.to_string(),
        model: model.to_string(),
        input: u64_at(usage, "input_tokens"),
        output: u64_at(usage, "output_tokens"),
        cache_read: u64_at(usage, "cache_read_input_tokens"),
        cache_create: u64_at(usage, "cache_creation_input_tokens"),
    };
    let keep_new = agg
        .calls
        .get(&id)
        .map(|prev| call.output >= prev.output)
        .unwrap_or(true);
    if keep_new {
        agg.calls.insert(id, call);
    }
}

/// Agrega las líneas de un transcript con la misma regla que
/// `scripts/lib/usage-transcripts.mjs` (dedupe por `message.id`, si falta por
/// `uuid`; fuera `<synthetic>`), para que Usage y `project-usage.mjs` cuadren.
fn aggregate_transcript<I: IntoIterator<Item = String>>(lines: I) -> TranscriptAgg {
    let mut agg = TranscriptAgg::default();
    for (line_no, line) in lines.into_iter().enumerate() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let ts = v.get("timestamp").and_then(|x| x.as_str()).unwrap_or("");
        let date = ts.get(..10).unwrap_or("").to_string();
        if !date.is_empty() {
            agg.dates.insert(date.clone());
        }
        match v.get("type").and_then(|x| x.as_str()).unwrap_or("") {
            "user" if is_human_prompt(&v) => agg.prompt_timestamps.push(ts.to_string()),
            "assistant" => absorb_assistant(&mut agg, &v, &date, line_no),
            _ => {}
        }
    }
    agg
}

/// Acumulador de todos los transcripts, con la forma de `stats-cache.json`.
#[derive(Default)]
struct LiveAcc {
    sessions: HashSet<String>,
    messages: u64,
    daily_msgs: BTreeMap<String, u64>,
    daily_sessions: BTreeMap<String, HashSet<String>>,
    daily_tools: BTreeMap<String, u64>,
    daily_model_tokens: BTreeMap<(String, String), u64>,
    model_totals: BTreeMap<String, ModelUsage>,
    hour_counts: BTreeMap<String, u64>,
    earliest: Option<String>,
}

impl LiveAcc {
    /// `session` es `Some` solo para el transcript principal de una sesión: los
    /// de `subagents/` suman tokens y tool calls, pero no sesiones ni prompts
    /// (su primer mensaje `user` lo escribe el agente padre, no una persona).
    fn absorb(&mut self, agg: TranscriptAgg, session: Option<&str>) {
        for date in &agg.dates {
            if self.earliest.as_ref().map(|e| date < e).unwrap_or(true) {
                self.earliest = Some(date.clone());
            }
        }
        if let Some(id) = session {
            self.sessions.insert(id.to_string());
            for date in &agg.dates {
                self.daily_sessions
                    .entry(date.clone())
                    .or_default()
                    .insert(id.to_string());
            }
            for ts in &agg.prompt_timestamps {
                self.messages += 1;
                if let Some(date) = ts.get(..10) {
                    *self.daily_msgs.entry(date.to_string()).or_insert(0) += 1;
                }
                if let Some(h) = ts.get(11..13) {
                    *self.hour_counts.entry(h.to_string()).or_insert(0) += 1;
                }
            }
        }
        for date in agg.tool_uses.into_values().filter(|d| !d.is_empty()) {
            *self.daily_tools.entry(date).or_insert(0) += 1;
        }
        for call in agg.calls.into_values() {
            let entry = self
                .model_totals
                .entry(call.model.clone())
                .or_insert(ModelUsage {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                });
            entry.input_tokens += call.input;
            entry.output_tokens += call.output;
            entry.cache_read_input_tokens += call.cache_read;
            entry.cache_creation_input_tokens += call.cache_create;
            *self
                .daily_model_tokens
                .entry((call.date, call.model))
                .or_insert(0) += call.input + call.output + call.cache_read + call.cache_create;
        }
    }

    fn into_stats(self) -> StatsCache {
        let mut keys: BTreeSet<String> = BTreeSet::new();
        keys.extend(self.daily_msgs.keys().cloned());
        keys.extend(self.daily_sessions.keys().cloned());
        keys.extend(self.daily_tools.keys().cloned());
        let daily_activity = keys
            .iter()
            .map(|date| DailyActivity {
                date: date.clone(),
                message_count: *self.daily_msgs.get(date).unwrap_or(&0),
                session_count: self
                    .daily_sessions
                    .get(date)
                    .map(|s| s.len() as u64)
                    .unwrap_or(0),
                tool_call_count: *self.daily_tools.get(date).unwrap_or(&0),
            })
            .collect();
        let mut by_date: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
        for ((date, model), n) in self.daily_model_tokens {
            by_date.entry(date).or_default().insert(model, n);
        }
        let daily_model_tokens = by_date
            .into_iter()
            .map(|(date, tokens_by_model)| DailyModelTokens {
                date,
                tokens_by_model,
            })
            .collect();
        StatsCache {
            last_computed_date: Some(today_utc_iso()),
            daily_activity,
            daily_model_tokens,
            model_usage: self.model_totals,
            total_sessions: self.sessions.len() as u64,
            total_messages: self.messages,
            first_session_date: self.earliest,
            hour_counts: self.hour_counts,
        }
    }
}

/// Todos los `.jsonl` bajo `dir`, recursivo (incluye `<sesión>/subagents/`).
fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(reader) = fs::read_dir(dir) else {
        return;
    };
    for entry in reader.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_jsonl(&p, out);
        } else if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(p);
        }
    }
}

/// Recalcula los campos de `stats-cache.json` a partir de
/// `<projects>/<slug>/**/*.jsonl`.
///
/// Recorre también `subagents/`: el transcript padre solo guarda el
/// `tool_result` del agente, no sus tokens, así que saltarlos dejaba invisible
/// el gasto de los subagentes. Lee con `BufReader` para no cargar entero un
/// transcript de 50 MB.
fn compute_live_usage_in(dir: &Path) -> Option<StatsCache> {
    use std::io::{BufRead, BufReader};
    if !dir.is_dir() {
        return None;
    }
    let mut acc = LiveAcc::default();
    for project in fs::read_dir(dir).ok()?.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        collect_jsonl(&project_path, &mut files);
        for p in files {
            let is_main = p.parent() == Some(project_path.as_path());
            let stem = p.file_stem().and_then(|s| s.to_str()).map(str::to_string);
            let Ok(file) = fs::File::open(&p) else {
                continue;
            };
            let agg = aggregate_transcript(BufReader::new(file).lines().map_while(Result::ok));
            let session = if is_main { stem.as_deref() } else { None };
            acc.absorb(agg, session);
        }
    }
    Some(acc.into_stats())
}

fn compute_live_usage() -> Option<StatsCache> {
    compute_live_usage_in(&projects_dir()?)
}

const SOURCE_STATS_CACHE: &str = "stats-cache";
const SOURCE_TRANSCRIPTS: &str = "transcripts";

/// `stats-cache.json` es opcional: Claude Code dejó de mantenerlo y una instalación
/// nueva no lo tiene. Ausente equivale a una caché vacía y sin fecha, lo que fuerza
/// el recálculo desde los transcripts. Un fichero corrupto sí es un error.
fn read_stats_cache(path: &std::path::Path) -> Result<StatsCache, String> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("parse stats-cache.json: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StatsCache::default()),
        Err(e) => Err(format!("read stats-cache.json: {e}")),
    }
}

pub fn claude_usage_inner() -> Result<UsageReport, String> {
    let path = cache_path().ok_or_else(|| "no HOME".to_string())?;
    let mut cache = read_stats_cache(&path)?;

    let today = today_utc_iso();
    let cache_age_days = cache
        .last_computed_date
        .as_ref()
        .and_then(|d| iso_diff_days(&today, d));

    // Fallback: when the cache is older than 24h (Claude Code stopped
    // maintaining it in recent versions), scan ~/.claude/projects/*.jsonl
    // and recompute the rollups from scratch. The shape mirrors stats-cache
    // so the downstream code stays unchanged.
    let mut source = SOURCE_STATS_CACHE;
    if cache_age_days.map(|d| d > 0).unwrap_or(true) {
        if let Some(live) = compute_live_usage() {
            source = SOURCE_TRANSCRIPTS;
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
        source,
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
        if (0..7).contains(&age) {
            report.last_7_days.messages += d.message_count;
            report.last_7_days.sessions += d.session_count;
            report.last_7_days.tool_calls += d.tool_call_count;
        }
        if (0..30).contains(&age) {
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
        if (0..7).contains(&age) {
            report.last_7_days.tokens_total += total;
            for (m, v) in &t.tokens_by_model {
                *report
                    .last_7_days
                    .tokens_by_model
                    .entry(m.clone())
                    .or_insert(0) += v;
            }
        }
        if (0..30).contains(&age) {
            report.last_30_days.tokens_total += total;
            for (m, v) in &t.tokens_by_model {
                *report
                    .last_30_days
                    .tokens_by_model
                    .entry(m.clone())
                    .or_insert(0) += v;
            }
        }
    }

    // Build daily_recent: last 14 days, oldest first, joining activity + tokens.
    let mut all_dates: Vec<String> = activity_by_date.keys().map(|s| s.to_string()).collect();
    all_dates.sort();
    let recent = all_dates.iter().rev().take(14).collect::<Vec<_>>();
    let mut recent_sorted: Vec<&String> = recent.to_vec();
    recent_sorted.sort();
    for date in recent_sorted {
        let act = activity_by_date.get(date.as_str());
        let tok = tokens_by_date.get(date.as_str());
        let tokens: u64 = tok.map(|t| t.tokens_by_model.values().sum()).unwrap_or(0);
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
    report
        .model_totals
        .sort_by_key(|b| std::cmp::Reverse(b.total));

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

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
