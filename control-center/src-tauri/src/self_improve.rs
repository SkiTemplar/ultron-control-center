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
pub struct SelfImproveReport {
    pub total_routes: u64,
    pub matched_routes: u64,
    pub top_intents: Vec<IntentCount>,
    pub top_skills: Vec<SkillCount>,
    pub recent_errors: Vec<ErrorEntry>,
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
    Ok(SelfImproveReport {
        total_routes,
        matched_routes,
        top_intents,
        top_skills,
        recent_errors,
    })
}

// ---------------------------------------------------------------------------
// Codex adversarial review (read-only)
// ---------------------------------------------------------------------------

pub async fn run_codex_adversarial_review_inner(
    app: &tauri::AppHandle,
) -> Result<ReviewResult, String> {
    // Codex CLI invocation routed through cmd.exe /C for PATHEXT resolution.
    // The /codex:adversarial-review slash is a Claude Code plugin command —
    // here we mimic it with a one-shot exec prompt that loads the current
    // git diff and asks Codex to attack the design.
    let cmdline = "codex exec \"Read the current git diff in this repo (run `git diff --stat HEAD~10` if needed). Challenge the most recent design decisions: name 3 risks I'm probably missing, and 1 thing I should reverse. Stay read-only.\"".to_string();
    let output = app
        .shell()
        .command("cmd.exe")
        .args(["/C", &cmdline])
        .output()
        .await
        .map_err(|e| format!("spawn cmd: {}", e))?;
    Ok(ReviewResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}
