// ULTRON Control Center — Full Diagnostic (v15.2 Phase 6).
//
// Replaces the old "ultron status" quick check on the dashboard. Runs ten
// subsystem probes IN PARALLEL via std::thread (we avoid pulling in a heavier
// async stack just for fan-out) and returns a flat Vec<DiagItem> the UI can
// render as a grid. Every item carries a colour ("green"|"orange"|"red"),
// a key metric and an optional `fix` link the UI can wire to apply_auto_fix.
//
// Subsystems probed:
//   1. Qdrant       — GET /collections (uses existing read_qdrant path semantics)
//   2. Brain index  — ~/.ultron/brain_index/index.db size + mtime
//   3. Vault        — ~/.ultron-vault/ note count + freshest mtime
//   4. Hooks        — count active hooks per event in ~/.claude/settings.json
//   5. MCPs         — reuse mcps::list_mcps_inner() and aggregate
//   6. Skills       — count entries in ~/.ultron/skills/registry.json
//   7. Cost watchdog — reuse cost_watchdog::compute_cost_inner(6)
//   8. Disk free   — C: drive free GB
//   9. Backup      — reuse backup_status::backup_status_inner()
//  10. Docker      — `docker ps` exit status / running flag
//
// The auto-fix layer is a tiny allowlist of script names under
// scripts/cockpit/auto-fixes/. apply_auto_fix(name) validates the name
// against the allowlist (no traversal, no arg injection) and spawns the
// script with PowerShell. We never accept full paths from the UI.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use serde::Serialize;
use tauri_plugin_shell::ShellExt;

use crate::backup_status;
use crate::cost_watchdog;
use crate::mcps;

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

/// One probed subsystem. `color` mirrors the dashboard's status palette:
///   "green"  — healthy
///   "orange" — actionable warning
///   "red"    — broken / down
#[derive(Debug, Serialize, Clone)]
pub struct DiagItem {
    pub key: String,
    pub label: String,
    pub color: String,
    pub metric: String,
    pub detail: Option<String>,
    /// If the UI should expose an "auto-fix" link, this is the name (NOT
    /// path) of an entry in `scripts/cockpit/auto-fixes/`. Validated by
    /// apply_auto_fix.
    pub fix: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct FullDiagnostic {
    pub items: Vec<DiagItem>,
    pub generated_at: String,
    pub elapsed_ms_total: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct AutoFixResult {
    pub name: String,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

// ---------------------------------------------------------------------------
// Auto-fix allowlist — script name (no extension) -> file under
// scripts/cockpit/auto-fixes/<name>.ps1. Anything outside this list is
// rejected by apply_auto_fix. Keep this in sync with the .ps1 files on disk.
// ---------------------------------------------------------------------------

pub const AUTO_FIX_ALLOWLIST: &[&str] = &[
    "clear-minidumps",
    "clear-temp-30d",
    "empty-recycle-bin",
    "restart-qdrant",
    "run-weekly-backup",
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn iso_now() -> String {
    // Reuse the same approach as cost_watchdog/memory: build YYYY-MM-DDTHH:MM:SSZ
    // without pulling in chrono. Approximate is fine — the UI re-formats.
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
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
    let mdays: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month + 1, days + 1, h, m, s)
}

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

// ---------------------------------------------------------------------------
// Individual probes — each returns a DiagItem so the fan-out below stays
// uniform. Probes MUST NOT panic; they return red/orange items on error.
// ---------------------------------------------------------------------------

fn probe_qdrant() -> DiagItem {
    let t0 = now_epoch_ms();
    // 4s budget — Qdrant healthz is normally <50ms when up. If it's slower
    // we still want to surface "degraded" rather than mark the whole
    // diagnostic as failed.
    let resp = ureq::get("http://localhost:6333/collections")
        .timeout(std::time::Duration::from_secs(4))
        .call();
    let elapsed = now_epoch_ms() - t0;
    match resp {
        Err(e) => DiagItem {
            key: "qdrant".into(),
            label: "Qdrant".into(),
            color: "red".into(),
            metric: "down".into(),
            detail: Some(format!("healthz failed: {}", e)),
            fix: Some("restart-qdrant".into()),
            elapsed_ms: elapsed,
        },
        Ok(r) => {
            let body = r.into_string().unwrap_or_default();
            #[derive(serde::Deserialize)]
            struct Top {
                result: Option<Inner>,
            }
            #[derive(serde::Deserialize)]
            struct Inner {
                collections: Vec<serde_json::Value>,
            }
            let count = serde_json::from_str::<Top>(&body)
                .ok()
                .and_then(|t| t.result)
                .map(|r| r.collections.len())
                .unwrap_or(0);
            DiagItem {
                key: "qdrant".into(),
                label: "Qdrant".into(),
                color: "green".into(),
                metric: format!("{} collections", count),
                detail: Some(format!("healthz {}ms", elapsed)),
                fix: None,
                elapsed_ms: elapsed,
            }
        }
    }
}

fn probe_brain() -> DiagItem {
    let t0 = now_epoch_ms();
    let Some(home) = home_dir() else {
        return DiagItem {
            key: "brain".into(),
            label: "Brain index".into(),
            color: "red".into(),
            metric: "no HOME".into(),
            detail: None,
            fix: None,
            elapsed_ms: now_epoch_ms() - t0,
        };
    };
    let path = home.join(".ultron/brain_index/index.db");
    let Ok(meta) = std::fs::metadata(&path) else {
        return DiagItem {
            key: "brain".into(),
            label: "Brain index".into(),
            color: "red".into(),
            metric: "missing".into(),
            detail: Some(format!("{} not found", path.display())),
            fix: None,
            elapsed_ms: now_epoch_ms() - t0,
        };
    };
    let size_mb = meta.len() as f64 / (1024.0 * 1024.0);
    let age_hours = meta
        .modified()
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs_f64() / 3600.0);
    let color = match age_hours {
        Some(h) if h > 48.0 => "red",
        Some(h) if h > 24.0 => "orange",
        _ => "green",
    };
    DiagItem {
        key: "brain".into(),
        label: "Brain index".into(),
        color: color.into(),
        metric: format!("{:.1} MB", size_mb),
        detail: age_hours.map(|h| format!("{:.0}h old", h)),
        fix: None,
        elapsed_ms: now_epoch_ms() - t0,
    }
}

fn probe_vault() -> DiagItem {
    let t0 = now_epoch_ms();
    let Some(home) = home_dir() else {
        return DiagItem {
            key: "vault".into(),
            label: "Vault".into(),
            color: "red".into(),
            metric: "no HOME".into(),
            detail: None,
            fix: None,
            elapsed_ms: now_epoch_ms() - t0,
        };
    };
    let root = home.join(".ultron-vault");
    if !root.exists() {
        return DiagItem {
            key: "vault".into(),
            label: "Vault".into(),
            color: "orange".into(),
            metric: "missing".into(),
            detail: Some(format!("{} not found", root.display())),
            fix: None,
            elapsed_ms: now_epoch_ms() - t0,
        };
    }
    // One-level walk is enough for the freshness signal — note count needs
    // a full walk but we keep it cheap by skipping hidden dirs.
    let mut count = 0u64;
    let mut newest: Option<SystemTime> = None;
    walk_md(&root, &mut count, &mut newest);
    let age_hours = newest.and_then(|t| t.elapsed().ok()).map(|d| d.as_secs_f64() / 3600.0);
    let color = if count == 0 {
        "red"
    } else if age_hours.map(|h| h > 72.0).unwrap_or(false) {
        "orange"
    } else {
        "green"
    };
    DiagItem {
        key: "vault".into(),
        label: "Vault".into(),
        color: color.into(),
        metric: format!("{} notes", count),
        detail: age_hours.map(|h| format!("last edit {:.0}h ago", h)),
        fix: None,
        elapsed_ms: now_epoch_ms() - t0,
    }
}

fn walk_md(root: &Path, count: &mut u64, newest: &mut Option<SystemTime>) {
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        if meta.is_dir() {
            let Ok(rd) = std::fs::read_dir(&p) else { continue };
            for child in rd.flatten() {
                let name = child.file_name();
                let s = name.to_string_lossy();
                if s.starts_with('.') {
                    continue;
                }
                stack.push(child.path());
            }
            continue;
        }
        if p.extension().and_then(|e| e.to_str()) == Some("md") {
            *count += 1;
            if let Ok(mt) = meta.modified() {
                *newest = Some(match newest {
                    Some(cur) if *cur >= mt => *cur,
                    _ => mt,
                });
            }
        }
    }
}

fn probe_hooks() -> DiagItem {
    let t0 = now_epoch_ms();
    let Some(home) = home_dir() else {
        return DiagItem {
            key: "hooks".into(),
            label: "Hooks".into(),
            color: "red".into(),
            metric: "no HOME".into(),
            detail: None,
            fix: None,
            elapsed_ms: now_epoch_ms() - t0,
        };
    };
    let path = home.join(".claude/settings.json");
    if !path.exists() {
        return DiagItem {
            key: "hooks".into(),
            label: "Hooks".into(),
            color: "orange".into(),
            metric: "no settings".into(),
            detail: Some("~/.claude/settings.json not found".into()),
            fix: None,
            elapsed_ms: now_epoch_ms() - t0,
        };
    }
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            return DiagItem {
                key: "hooks".into(),
                label: "Hooks".into(),
                color: "red".into(),
                metric: "read error".into(),
                detail: Some(e.to_string()),
                fix: None,
                elapsed_ms: now_epoch_ms() - t0,
            };
        }
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return DiagItem {
                key: "hooks".into(),
                label: "Hooks".into(),
                color: "red".into(),
                metric: "parse error".into(),
                detail: Some(e.to_string()),
                fix: None,
                elapsed_ms: now_epoch_ms() - t0,
            };
        }
    };
    // Count active hooks (`type=="command"`) grouped by event.
    let mut by_event: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
    if let Some(hooks_obj) = parsed.get("hooks").and_then(|v| v.as_object()) {
        for (event, groups) in hooks_obj.iter() {
            let Some(arr) = groups.as_array() else { continue };
            for group in arr.iter() {
                let Some(inner) = group.get("hooks").and_then(|v| v.as_array()) else { continue };
                for entry in inner.iter() {
                    if entry.get("type").and_then(|t| t.as_str()) == Some("command") {
                        *by_event.entry(event.clone()).or_insert(0) += 1;
                    }
                }
            }
        }
    }
    let total: u64 = by_event.values().sum();
    let summary = by_event
        .iter()
        .map(|(k, v)| format!("{}:{}", k, v))
        .collect::<Vec<_>>()
        .join(" · ");
    let color = if total == 0 { "orange" } else { "green" };
    DiagItem {
        key: "hooks".into(),
        label: "Hooks".into(),
        color: color.into(),
        metric: format!("{} active", total),
        detail: if summary.is_empty() { None } else { Some(summary) },
        fix: None,
        elapsed_ms: now_epoch_ms() - t0,
    }
}

fn probe_mcps() -> DiagItem {
    let t0 = now_epoch_ms();
    match mcps::list_mcps_inner() {
        Err(e) => DiagItem {
            key: "mcps".into(),
            label: "MCPs".into(),
            color: "red".into(),
            metric: "error".into(),
            detail: Some(e),
            fix: None,
            elapsed_ms: now_epoch_ms() - t0,
        },
        Ok(list) => {
            let total = list.len();
            let ok = list.iter().filter(|m| m.status == "ok").count();
            let issues = list
                .iter()
                .filter(|m| (m.status == "degraded" || m.status == "missing") && !m.expected_offline)
                .count();
            let color = if issues > 0 { "orange" } else if ok == 0 && total == 0 { "orange" } else { "green" };
            DiagItem {
                key: "mcps".into(),
                label: "MCPs".into(),
                color: color.into(),
                metric: format!("{}/{} ok", ok, total),
                detail: if issues > 0 {
                    Some(format!("{} need attention", issues))
                } else {
                    Some("all connected".into())
                },
                fix: None,
                elapsed_ms: now_epoch_ms() - t0,
            }
        }
    }
}

fn probe_skills() -> DiagItem {
    let t0 = now_epoch_ms();
    let Some(home) = home_dir() else {
        return DiagItem {
            key: "skills".into(),
            label: "Skills".into(),
            color: "red".into(),
            metric: "no HOME".into(),
            detail: None,
            fix: None,
            elapsed_ms: now_epoch_ms() - t0,
        };
    };
    let path = home.join(".ultron/skills/registry.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            return DiagItem {
                key: "skills".into(),
                label: "Skills".into(),
                color: "orange".into(),
                metric: "no registry".into(),
                detail: Some(format!("{} missing", path.display())),
                fix: None,
                elapsed_ms: now_epoch_ms() - t0,
            };
        }
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return DiagItem {
                key: "skills".into(),
                label: "Skills".into(),
                color: "red".into(),
                metric: "invalid".into(),
                detail: Some(format!("registry parse: {}", e)),
                fix: None,
                elapsed_ms: now_epoch_ms() - t0,
            };
        }
    };
    let count = parsed
        .get("skills")
        .and_then(|s| s.as_object())
        .map(|o| o.len() as u64)
        .or_else(|| parsed.get("skills").and_then(|s| s.as_array()).map(|a| a.len() as u64))
        .unwrap_or(0);
    let manifest_valid = parsed.get("schema_version").is_some();
    let color = if count == 0 {
        "orange"
    } else if !manifest_valid {
        "orange"
    } else {
        "green"
    };
    DiagItem {
        key: "skills".into(),
        label: "Skills".into(),
        color: color.into(),
        metric: format!("{} skills", count),
        detail: Some(if manifest_valid {
            "manifest valid".into()
        } else {
            "no schema_version".into()
        }),
        fix: None,
        elapsed_ms: now_epoch_ms() - t0,
    }
}

fn probe_cost() -> DiagItem {
    let t0 = now_epoch_ms();
    match cost_watchdog::compute_cost_inner(6) {
        Err(e) => DiagItem {
            key: "cost".into(),
            label: "Cost watchdog".into(),
            color: "orange".into(),
            metric: "no data".into(),
            detail: Some(e),
            fix: None,
            elapsed_ms: now_epoch_ms() - t0,
        },
        Ok(snap) => {
            let color = if snap.alert.is_some() { "orange" } else { "green" };
            DiagItem {
                key: "cost".into(),
                label: "Cost watchdog".into(),
                color: color.into(),
                metric: format!(
                    "${:.2}–${:.2}/day",
                    snap.projected_daily_usd_low, snap.projected_daily_usd_high
                ),
                detail: Some(format!(
                    "{} tok in {}h",
                    snap.total_tokens, snap.window_hours
                )),
                fix: None,
                elapsed_ms: now_epoch_ms() - t0,
            }
        }
    }
}

fn probe_disk() -> DiagItem {
    let t0 = now_epoch_ms();
    // Cheap probe: shell out to PowerShell. On Windows there's no portable
    // libc statvfs we can lean on without an extra crate, and we already
    // depend on the shell for everything else.
    let out = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-PSDrive C).Free",
        ])
        .output();
    let elapsed = now_epoch_ms() - t0;
    match out {
        Err(e) => DiagItem {
            key: "disk".into(),
            label: "Disk C:".into(),
            color: "orange".into(),
            metric: "unknown".into(),
            detail: Some(format!("probe failed: {}", e)),
            fix: None,
            elapsed_ms: elapsed,
        },
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let bytes: u64 = stdout.parse().unwrap_or(0);
            let gb = bytes as f64 / (1024.0 * 1024.0 * 1024.0);
            let color = if gb < 10.0 {
                "red"
            } else if gb < 30.0 {
                "orange"
            } else {
                "green"
            };
            let fix = if gb < 30.0 { Some("clear-temp-30d".into()) } else { None };
            DiagItem {
                key: "disk".into(),
                label: "Disk C:".into(),
                color: color.into(),
                metric: format!("{:.1} GB free", gb),
                detail: None,
                fix,
                elapsed_ms: elapsed,
            }
        }
    }
}

fn probe_backup() -> DiagItem {
    let t0 = now_epoch_ms();
    match backup_status::backup_status_inner() {
        Err(e) => DiagItem {
            key: "backup".into(),
            label: "Backup".into(),
            color: "orange".into(),
            metric: "error".into(),
            detail: Some(e),
            fix: None,
            elapsed_ms: now_epoch_ms() - t0,
        },
        Ok(rep) => {
            let color = match rep.overall_status.as_str() {
                "ok" => "green",
                "stale" => "orange",
                _ => "orange",
            };
            // v15.3.2: surface the auto-fix when the mirrors are stale or
            // cold. The user kept asking "cómo se corrige Backup stale?"
            // and the answer was buried in the Maintenance commands
            // panel. Now the diag row itself proposes the fix and the
            // user can apply it from "Auto-fix common issues".
            let fix = match rep.overall_status.as_str() {
                "ok" => None,
                _ => Some("run-weekly-backup".to_string()),
            };
            let detail = match rep.overall_status.as_str() {
                "ok" => Some(format!("status: {}", rep.overall_status)),
                "stale" => Some(
                    "Mirrors not refreshed in 8–30 days. Click \
                    'Auto-fix common issues' → run-weekly-backup to \
                    trigger the scheduled task now."
                        .into(),
                ),
                _ => Some(format!("status: {} — run weekly-backup to refresh", rep.overall_status)),
            };
            DiagItem {
                key: "backup".into(),
                label: "Backup".into(),
                color: color.into(),
                metric: format!("{} mirrors", rep.entries.len()),
                detail,
                fix,
                elapsed_ms: now_epoch_ms() - t0,
            }
        }
    }
}

// v15.2.32: probe_docker removed. ULTRON has not depended on Docker since
// v15.0.2 — Qdrant runs as a native Windows binary, and probe_qdrant
// already reports its health. Keeping a Docker probe was misleading the
// Doctor ("Docker not installed") for users who legitimately don't have
// it. If a future build re-adds container runtimes, restore this from git
// history.

// ---------------------------------------------------------------------------
// Parallel fan-out
// ---------------------------------------------------------------------------

pub fn run_full_diagnostic_inner() -> Result<FullDiagnostic, String> {
    let t0 = now_epoch_ms();
    let bucket: Arc<Mutex<Vec<DiagItem>>> = Arc::new(Mutex::new(Vec::with_capacity(10)));

    // Each thread runs one probe. Probes do their own error handling and
    // produce a DiagItem unconditionally, so we never need to propagate
    // Result<_> out of the threads.
    type Probe = fn() -> DiagItem;
    // v15.3.3: probe_cost removed from the fan-out. The user does not need
    // a cost projection in their daily Doctor view ("no funciona por
    // coste" — they pay per subscription, not per token). The probe and
    // the cost_watchdog module stay defined in case a future build re-
    // exposes them as an opt-in (Settings feature flag).
    let probes: Vec<Probe> = vec![
        probe_qdrant,
        probe_brain,
        probe_vault,
        probe_hooks,
        probe_mcps,
        probe_skills,
        probe_disk,
        probe_backup,
    ];

    let mut handles = Vec::with_capacity(probes.len());
    for probe in probes {
        let bucket_cl = Arc::clone(&bucket);
        handles.push(thread::spawn(move || {
            let item = probe();
            if let Ok(mut g) = bucket_cl.lock() {
                g.push(item);
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }

    let items = bucket
        .lock()
        .map_err(|e| format!("bucket lock poisoned: {}", e))?
        .clone();
    Ok(FullDiagnostic {
        items,
        generated_at: iso_now(),
        elapsed_ms_total: now_epoch_ms() - t0,
    })
}

// ---------------------------------------------------------------------------
// Auto-fix runner
// ---------------------------------------------------------------------------

pub async fn apply_auto_fix_inner(
    app: &tauri::AppHandle,
    name: String,
) -> Result<AutoFixResult, String> {
    // Defensive: refuse anything not in the allowlist BEFORE building a
    // path. The allowlist guarantees no path traversal, no shell injection.
    if !AUTO_FIX_ALLOWLIST.contains(&name.as_str()) {
        return Err(format!("auto-fix '{}' is not in the allowlist", name));
    }
    // Extra paranoid: name must be safe filename chars only.
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(format!("auto-fix name '{}' has invalid chars", name));
    }
    let Some(home) = home_dir() else {
        return Err("no HOME".to_string());
    };
    let script = home
        .join(".ultron/scripts/cockpit/auto-fixes")
        .join(format!("{}.ps1", name));
    if !script.exists() {
        return Err(format!("auto-fix script not found: {}", script.display()));
    }
    let script_str = script.to_string_lossy().to_string();
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
        ])
        .output()
        .await
        .map_err(|e| format!("spawn powershell: {}", e))?;

    Ok(AutoFixResult {
        name,
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
}
