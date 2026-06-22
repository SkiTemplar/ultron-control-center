//! Control Center 2.0 — Tauri command wrappers for native diagnostics.
//!
//! Wires `crate::diagnostics_native` to the frontend. Provides:
//!   - `run_diagnostic_native`         — runs all checks + persists JSON
//!   - `analyze_diagnostic_with_ai`    — `claude --print` over the report
//!   - `diagnostic_history_list/read`  — past runs
//!   - `diagnostic_schedule_get/set`   — Windows Task Scheduler integration

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri_plugin_shell::ShellExt;

use crate::diagnostics_native as dn;

const ANALYZE_PROMPT_PREFIX: &str = "You are an expert SRE. Given the following Windows desktop diagnostic JSON, identify the top 3-5 problems and propose concrete fixes (commands or settings). Use concise markdown with H3 headings per issue. Diagnostic JSON:\n\n";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn diagnostics_dir() -> Result<PathBuf, String> {
    Ok(crate::ultron_root()?.join("cockpit").join("diagnostics"))
}

fn write_atomic(path: &Path, body: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn run_diagnostic_native() -> Result<dn::DiagnosticReport, String> {
    let report = tauri::async_runtime::spawn_blocking(dn::run_full_diagnostic_native)
        .await
        .map_err(|e| format!("join: {e}"))?;
    persist_report(&report)?;
    Ok(report)
}

fn persist_report(report: &dn::DiagnosticReport) -> Result<(), String> {
    let dir = diagnostics_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let path = dir.join(format!("{}.json", report.timestamp));
    let body = serde_json::to_vec_pretty(report).map_err(|e| format!("ser: {e}"))?;
    write_atomic(&path, &body)?;
    prune_history(&dir, 30).ok();
    Ok(())
}

fn prune_history(dir: &Path, keep: usize) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    entries.sort_by_key(|b| std::cmp::Reverse(b.file_name()));
    for stale in entries.into_iter().skip(keep) {
        let _ = std::fs::remove_file(stale.path());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Analyze with AI
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn analyze_diagnostic_with_ai(
    app: tauri::AppHandle,
    report_json: String,
) -> Result<String, String> {
    let prompt = format!("{}{}", ANALYZE_PROMPT_PREFIX, report_json);
    let shell = app.shell();
    let output = shell
        .command("claude")
        .args(["--print", "--", &prompt])
        .output()
        .await
        .map_err(|e| format!("claude spawn: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "claude exited {:?}: {}",
            output.status.code(),
            stderr
        ));
    }
    let md = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(md)
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub timestamp: String,
    pub max_severity: dn::Severity,
    pub path: String,
}

#[tauri::command]
pub fn diagnostic_history_list(limit: Option<usize>) -> Result<Vec<HistoryEntry>, String> {
    let dir = diagnostics_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<HistoryEntry> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read_dir: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .filter_map(|e| {
            let path = e.path();
            let stem = path.file_stem()?.to_string_lossy().to_string();
            let txt = std::fs::read_to_string(&path).ok()?;
            let report: dn::DiagnosticReport = serde_json::from_str(&txt).ok()?;
            Some(HistoryEntry {
                timestamp: stem,
                max_severity: report.max_severity,
                path: path.display().to_string(),
            })
        })
        .collect();
    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    if let Some(n) = limit {
        entries.truncate(n);
    }
    Ok(entries)
}

#[tauri::command]
pub fn diagnostic_history_read(timestamp: String) -> Result<dn::DiagnosticReport, String> {
    let dir = diagnostics_dir()?;
    let path = dir.join(format!("{}.json", timestamp));
    let txt = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&txt).map_err(|e| format!("parse: {e}"))
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleConfig {
    pub enabled: bool,
    pub time_hhmm: String, // "08:30"
}

const TASK_NAME: &str = "ULTRON-Daily-Diagnostic";

fn schedule_config_path() -> Result<PathBuf, String> {
    Ok(crate::ultron_root()?
        .join("cockpit")
        .join("diagnostic-schedule.json"))
}

#[tauri::command]
pub fn diagnostic_schedule_get() -> Result<ScheduleConfig, String> {
    let p = schedule_config_path()?;
    if !p.exists() {
        return Ok(ScheduleConfig {
            enabled: false,
            time_hhmm: "08:30".to_string(),
        });
    }
    let txt = std::fs::read_to_string(&p).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&txt).map_err(|e| format!("parse: {e}"))
}

#[tauri::command]
pub fn diagnostic_schedule_set(enabled: bool, time_hhmm: String) -> Result<ScheduleConfig, String> {
    if !time_hhmm_valid(&time_hhmm) {
        return Err("invalid time format, expected HH:MM".to_string());
    }
    let cfg = ScheduleConfig {
        enabled,
        time_hhmm: time_hhmm.clone(),
    };
    let p = schedule_config_path()?;
    let body = serde_json::to_vec_pretty(&cfg).map_err(|e| format!("ser: {e}"))?;
    write_atomic(&p, &body)?;

    if enabled {
        register_task(&time_hhmm)?;
    } else {
        unregister_task()?;
    }
    Ok(cfg)
}

fn time_hhmm_valid(s: &str) -> bool {
    let mut parts = s.split(':');
    let (Some(h), Some(m)) = (parts.next(), parts.next()) else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    let Ok(hh) = h.parse::<u32>() else {
        return false;
    };
    let Ok(mm) = m.parse::<u32>() else {
        return false;
    };
    hh < 24 && mm < 60
}

#[cfg(target_os = "windows")]
fn register_task(time_hhmm: &str) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let tr = format!("\"{}\" --run-diagnostic", exe.display());
    let status = std::process::Command::new("schtasks.exe")
        .args([
            "/create", "/tn", TASK_NAME, "/tr", &tr, "/sc", "daily", "/st", time_hhmm, "/f",
        ])
        .status()
        .map_err(|e| format!("schtasks: {e}"))?;
    if !status.success() {
        return Err(format!("schtasks exited {:?}", status.code()));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn unregister_task() -> Result<(), String> {
    let _ = std::process::Command::new("schtasks.exe")
        .args(["/delete", "/tn", TASK_NAME, "/f"])
        .status();
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn register_task(_time_hhmm: &str) -> Result<(), String> {
    Err("scheduling only supported on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
fn unregister_task() -> Result<(), String> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Per-error-id diagnostic checks (FIX 3)
//
// The frontend `Diagnostics.tsx` calls `invoke("diagnostics_run", { errorId })`
// for each entry in `COMMON_ERRORS`. Previously this command did not exist,
// causing every Diagnose button to fall into the catch-block and render "fail".
// Now each known `checkId` runs a real, minimal check. Unknown IDs return
// `{ ok: false, status: "unknown", detail: "no check registered for …" }`.
// ---------------------------------------------------------------------------

/// Result returned to the frontend for a single diagnostic check.
#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticCheckResult {
    /// `"ok"`, `"fail"`, `"warn"`, or `"unknown"` (no check registered /
    /// check not applicable on this platform).
    pub status: String,
    /// Human-readable detail shown under the check title.
    pub details: String,
    /// Optional fix suggestion surfaced in the UI.
    pub suggested_fix: Option<String>,
}

/// Run the check registered for `error_id` and return the result.
///
/// Every path MUST return — never panic, never return `Err`. Returning
/// `Err` from a Tauri command causes the frontend catch-block to fire,
/// which would again paint the card red. So we always return `Ok(result)`
/// and embed any error in `result.details`.
#[tauri::command]
pub fn diagnostics_run(error_id: String) -> DiagnosticCheckResult {
    match error_id.as_str() {
        // ------------------------------------------------------------------
        // AI / Claude checks
        // ------------------------------------------------------------------
        "claude-login-expired" => {
            // Check: `claude` binary is on PATH.
            match which::which("claude") {
                Ok(p) => DiagnosticCheckResult {
                    status: "ok".into(),
                    details: format!("claude binary found at {}", p.display()),
                    suggested_fix: None,
                },
                Err(_) => DiagnosticCheckResult {
                    status: "fail".into(),
                    details: "claude not found on PATH.".into(),
                    suggested_fix: Some(
                        "Install Claude Code: npm install -g @anthropic-ai/claude-code".into(),
                    ),
                },
            }
        }

        "ai-router-no-keys" => {
            // Check: at least one cloud provider has a usable API key.
            let has_any = [
                "ANTHROPIC_API_KEY",
                "OPENAI_API_KEY",
                "GEMINI_API_KEY",
                "GROQ_API_KEY",
                "DEEPSEEK_API_KEY",
            ]
            .iter()
            .any(|k| {
                std::env::var(k)
                    .map(|v| {
                        !v.trim().is_empty() && !v.contains("your-key") && !v.starts_with("xxx")
                    })
                    .unwrap_or(false)
            });
            if has_any {
                DiagnosticCheckResult {
                    status: "ok".into(),
                    details: "At least one AI provider API key is configured.".into(),
                    suggested_fix: None,
                }
            } else {
                DiagnosticCheckResult {
                    status: "warn".into(),
                    details: "No cloud provider API keys detected in the environment.".into(),
                    suggested_fix: Some(
                        "Set ANTHROPIC_API_KEY (or GROQ/GEMINI/OPENAI) in Settings > API Keys."
                            .into(),
                    ),
                }
            }
        }

        "node-not-found" => match which::which("node") {
            Ok(p) => DiagnosticCheckResult {
                status: "ok".into(),
                details: format!("Node.js found at {}", p.display()),
                suggested_fix: None,
            },
            Err(_) => DiagnosticCheckResult {
                status: "fail".into(),
                details: "node not found on PATH.".into(),
                suggested_fix: Some("Download Node.js from https://nodejs.org".into()),
            },
        },

        "qdrant-binary-missing" => {
            let found = which::which("qdrant").is_ok()
                || dirs::home_dir()
                    .map(|h| h.join(".ultron").join("qdrant.exe").exists())
                    .unwrap_or(false);
            if found {
                DiagnosticCheckResult {
                    status: "ok".into(),
                    details: "qdrant binary found.".into(),
                    suggested_fix: None,
                }
            } else {
                DiagnosticCheckResult {
                    status: "warn".into(),
                    details: "qdrant not found on PATH or in ~/.ultron/".into(),
                    suggested_fix: Some(
                        "Download from https://github.com/qdrant/qdrant/releases and place qdrant.exe in ~/.ultron/".into(),
                    ),
                }
            }
        }

        // ------------------------------------------------------------------
        // Network checks
        // ------------------------------------------------------------------
        "network-unreachable" => {
            use std::net::TcpStream;
            use std::time::Duration;
            let addr = "1.1.1.1:443";
            match TcpStream::connect_timeout(
                &addr.parse().expect("static addr"),
                Duration::from_secs(3),
            ) {
                Ok(_) => DiagnosticCheckResult {
                    status: "ok".into(),
                    details: "1.1.1.1:443 reachable — network looks healthy.".into(),
                    suggested_fix: None,
                },
                Err(e) => DiagnosticCheckResult {
                    status: "fail".into(),
                    details: format!("Cannot reach 1.1.1.1:443 — {e}"),
                    suggested_fix: Some(
                        "Try flushing DNS (ipconfig /flushdns) or renewing your IP lease.".into(),
                    ),
                },
            }
        }

        // ------------------------------------------------------------------
        // System checks
        // ------------------------------------------------------------------
        "port-1420-in-use" => {
            use std::net::TcpListener;
            match TcpListener::bind("127.0.0.1:1420") {
                Ok(_) => DiagnosticCheckResult {
                    status: "ok".into(),
                    details: "Port 1420 is free.".into(),
                    suggested_fix: None,
                },
                Err(_) => DiagnosticCheckResult {
                    status: "warn".into(),
                    details: "Port 1420 is already in use.".into(),
                    suggested_fix: Some(
                        "Another Control Center instance may be running. Open Task Manager and end the duplicate process.".into(),
                    ),
                },
            }
        }

        "gh-cli-missing" => match which::which("gh") {
            Ok(p) => DiagnosticCheckResult {
                status: "ok".into(),
                details: format!("gh CLI found at {}", p.display()),
                suggested_fix: None,
            },
            Err(_) => DiagnosticCheckResult {
                status: "warn".into(),
                details: "gh not found on PATH.".into(),
                suggested_fix: Some(
                    "Install with: scoop install gh  OR  winget install GitHub.cli".into(),
                ),
            },
        },

        "tauri-capabilities-denied" => {
            // Check: capabilities/default.json exists and is parseable.
            let cap_path = std::env::current_exe().ok().and_then(|e| {
                e.parent()
                    .map(|p| p.join("..").join("capabilities").join("default.json"))
            });
            let detail = cap_path
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .map(|_| "capabilities/default.json found and valid.".to_string())
                .unwrap_or_else(|| {
                    "capabilities/default.json not found or unreadable.".to_string()
                });
            // We can't definitively determine if permissions are blocked from inside,
            // so we report "unknown" unless we can confirm the file is intact.
            let status = if detail.contains("found and valid") {
                "ok"
            } else {
                "unknown"
            };
            DiagnosticCheckResult {
                status: status.into(),
                details: detail,
                suggested_fix: Some(
                    "Review src-tauri/capabilities/default.json for missing shell/fs scopes."
                        .into(),
                ),
            }
        }

        // ------------------------------------------------------------------
        // Plugin checks
        // ------------------------------------------------------------------
        "plugins-out-of-date" => {
            // Check: ECC plugin cache directory exists.
            let cache_exists = dirs::home_dir()
                .map(|h| {
                    h.join(".claude")
                        .join("plugins")
                        .join("cache")
                        .join("ecc")
                        .exists()
                })
                .unwrap_or(false);
            if cache_exists {
                DiagnosticCheckResult {
                    status: "ok".into(),
                    details: "ECC plugin cache found at ~/.claude/plugins/cache/ecc/.".into(),
                    suggested_fix: None,
                }
            } else {
                DiagnosticCheckResult {
                    status: "warn".into(),
                    details: "ECC plugin cache not found at ~/.claude/plugins/cache/ecc/.".into(),
                    suggested_fix: Some(
                        "Run /plugin install ecc@ecc in a Claude Code session.".into(),
                    ),
                }
            }
        }

        "hooks-misconfigured" => {
            // Check: ~/.claude/settings.json has a `hooks` section.
            let configured = dirs::home_dir()
                .and_then(|h| std::fs::read_to_string(h.join(".claude").join("settings.json")).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .map(|v| v.get("hooks").is_some())
                .unwrap_or(false);
            if configured {
                DiagnosticCheckResult {
                    status: "ok".into(),
                    details: "~/.claude/settings.json has a `hooks` section.".into(),
                    suggested_fix: None,
                }
            } else {
                DiagnosticCheckResult {
                    status: "warn".into(),
                    details: "No `hooks` section found in ~/.claude/settings.json.".into(),
                    suggested_fix: Some(
                        "Add PostToolUse / Stop hooks via Settings > Hooks or edit ~/.claude/settings.json.".into(),
                    ),
                }
            }
        }

        // ------------------------------------------------------------------
        // Storage checks
        // ------------------------------------------------------------------
        "ultron-disk-usage" => {
            let size_mb = dirs::home_dir()
                .map(|h| dir_size_mb(&h.join(".ultron")))
                .unwrap_or(0);
            let (status, detail) = if size_mb > 500 {
                (
                    "warn",
                    format!("~/.ultron is {size_mb} MB — consider cleaning old logs/sessions."),
                )
            } else {
                (
                    "ok",
                    format!("~/.ultron is {size_mb} MB — within normal range."),
                )
            };
            DiagnosticCheckResult {
                status: status.into(),
                details: detail,
                suggested_fix: if size_mb > 500 {
                    Some(
                        "Clear %TEMP% and old diagnostics under ~/.ultron/cockpit/diagnostics/."
                            .into(),
                    )
                } else {
                    None
                },
            }
        }

        "projects-json-missing" => {
            let ok = dirs::home_dir()
                .and_then(|h| {
                    std::fs::read_to_string(h.join(".ultron").join("cockpit").join("projects.json"))
                        .ok()
                })
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .is_some();
            if ok {
                DiagnosticCheckResult {
                    status: "ok".into(),
                    details: "projects.json exists and is valid JSON.".into(),
                    suggested_fix: None,
                }
            } else {
                DiagnosticCheckResult {
                    status: "fail".into(),
                    details: "~/.ultron/cockpit/projects.json missing or corrupt.".into(),
                    suggested_fix: Some(
                        "Open ~/.ultron/cockpit/ and inspect or recreate projects.json.".into(),
                    ),
                }
            }
        }

        // ------------------------------------------------------------------
        // Git checks
        // ------------------------------------------------------------------
        "git-uncommitted-cockpit" => {
            let cockpit = dirs::home_dir().map(|h| h.join(".ultron").join("cockpit"));
            let (status, detail) = if let Some(path) = cockpit {
                let output = std::process::Command::new("git")
                    .args(["-C", &path.display().to_string(), "status", "--porcelain"])
                    .output();
                match output {
                    Ok(o) if o.status.success() => {
                        let changes = String::from_utf8_lossy(&o.stdout);
                        let n = changes.lines().filter(|l| !l.trim().is_empty()).count();
                        if n == 0 {
                            (
                                "ok",
                                "No uncommitted changes in ~/.ultron/cockpit/.".to_string(),
                            )
                        } else {
                            (
                                "warn",
                                format!("{n} uncommitted change(s) in ~/.ultron/cockpit/."),
                            )
                        }
                    }
                    _ => (
                        "unknown",
                        "Could not run git status in ~/.ultron/cockpit/.".to_string(),
                    ),
                }
            } else {
                ("unknown", "Cannot resolve home directory.".to_string())
            };
            DiagnosticCheckResult {
                status: status.into(),
                details: detail,
                suggested_fix: if status == "warn" {
                    Some("Open a terminal in ~/.ultron/ and run: git add -A && git commit -m 'chore: save cockpit state'".into())
                } else {
                    None
                },
            }
        }

        // ------------------------------------------------------------------
        // Unknown check id — return honest "unknown" instead of fake fail
        // ------------------------------------------------------------------
        other => DiagnosticCheckResult {
            status: "unknown".into(),
            details: format!("No backend check registered for id '{other}'."),
            suggested_fix: None,
        },
    }
}

/// Approximate size of a directory tree in megabytes. Best-effort — skips
/// unreadable entries silently so a permission error doesn't crash the check.
fn dir_size_mb(root: &std::path::Path) -> u64 {
    fn recurse(path: &std::path::Path, acc: &mut u64) {
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                recurse(&p, acc);
            } else if let Ok(m) = p.metadata() {
                *acc += m.len();
            }
        }
    }
    let mut total_bytes = 0u64;
    recurse(root, &mut total_bytes);
    total_bytes / (1024 * 1024)
}
