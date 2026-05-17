// ULTRON Control Center — Gaming mode.
//
// Enumerate processes worth killing before launching a game, and kill them
// safely. Three layers of guard:
//   1. Hard blacklist of system processes we will NEVER touch.
//   2. Self-blacklist: anything that looks like our own stack (claude,
//      control-center, qdrant, the user's IDEs of choice).
//   3. The frontend gets to pick which checked candidates actually die.
//
// Heuristic for "known background app": a curated allowlist of process
// names the user tends to have running but doesn't need while gaming.
// The frontend pre-checks rows whose name matches this list; everything
// else is shown unchecked so a stray match doesn't kill something useful.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri_plugin_shell::ShellExt;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct GameProcessInfo {
    pub pid: i64,
    pub name: String,
    pub ram_mb: f64,
    /// Vendor / category tag if we recognize it (e.g. "discord", "spotify",
    /// "iobit"). Empty if generic.
    pub category: String,
    /// True when the process matches the curated "kill before gaming" list.
    /// The UI uses this to pre-check the row.
    pub suggested: bool,
    /// Tier-2 known app that we recognise but explicitly keep open by
    /// default — communication apps the user wants while gaming. UI still
    /// shows it but unchecked.
    pub keep_default: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct KillResult {
    pub killed: Vec<i64>,
    pub failed: Vec<KillFailure>,
    pub freed_mb_estimate: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct KillFailure {
    pub pid: i64,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Guard lists
// ---------------------------------------------------------------------------

/// Process names that must NEVER be killed. Lowercased.
const HARD_BLACKLIST: &[&str] = &[
    // Windows core
    "system", "idle", "registry", "memory compression",
    "csrss", "smss", "winlogon", "wininit", "services", "lsass",
    "fontdrvhost", "dwm", "explorer", "ctfmon", "sihost",
    "taskhostw", "applicationframehost", "runtimebroker",
    "searchhost", "startmenuexperiencehost", "shellexperiencehost",
    "winrt-host", "lockapp", "userinitprocess", "userinit",
    "svchost", "conhost", "wuauclt", "wuauserv", "wmiprvse",
    "winrshost", "audiodg", "spoolsv", "rdpclip",
    // Drivers / vendor stuff that crashes the host if killed
    "nvidiacontainer", "nvdisplay.container", "nvidia container",
    "nvbroadcast", "amdrsservcli", "atiesrxx", "atieclxx",
    "intelcphdcpsvc", "intelcphs",
    // Security
    "msmpeng", "smartscreen", "securityhealthservice",
    "securityhealthsystray", "windowsdefender",
    // Our own stack
    "control-center", "qdrant", "claude", "claude-code",
    // Common IDEs — assume the user wants them
    "code", "cursor", "rider64", "webstorm64", "pycharm64",
    "androidstudio64", "ue4editor", "ue5editor", "unityhub", "unity",
    // Terminals
    "windowsterminal", "powershell", "pwsh", "cmd",
    // Tauri dev / node
    "node", "vite",
];

/// Curated suggestions: processes that are typically safe to close before
/// gaming. Lowercased substring match against the process name. The `keep`
/// flag distinguishes apps the user usually wants alive *while* gaming —
/// chat clients, calls, voice — from straightforward bloat to evict.
struct Suggested {
    needles: &'static [&'static str],
    category: &'static str,
    /// When true the row is recognised but UI does NOT pre-check it. User
    /// keeps comms alive unless they explicitly opt in to kill.
    keep: bool,
}

const SUGGESTED: &[Suggested] = &[
    // ---- Communication / voice / video — KEEP ALIVE by default ----------
    Suggested { needles: &["discord", "discordcanary", "discordptb"], category: "discord", keep: true },
    Suggested { needles: &["slack"], category: "slack", keep: true },
    Suggested { needles: &["teams"], category: "teams", keep: true },
    Suggested { needles: &["telegram"], category: "telegram", keep: true },
    Suggested { needles: &["whatsapp"], category: "whatsapp", keep: true },
    Suggested { needles: &["zoom"], category: "zoom", keep: true },
    Suggested { needles: &["element"], category: "element", keep: true },
    Suggested { needles: &["signal"], category: "signal", keep: true },
    // Music players — usually kept, can stream while gaming
    Suggested { needles: &["spotify"], category: "spotify", keep: true },
    // Streaming / recording — keep, user is often deliberate about these
    Suggested { needles: &["obs"], category: "obs", keep: true },

    // ---- Dispensable / bloat — KILL by default --------------------------
    // Cloud sync clients (heavy, IO churn, user can resume after)
    Suggested { needles: &["onedrive"], category: "onedrive", keep: false },
    Suggested { needles: &["googledrivefs", "googledrive"], category: "google-drive", keep: false },
    Suggested { needles: &["dropbox"], category: "dropbox", keep: false },
    // IObit family — known fan-spinners
    Suggested { needles: &["iobit", "driverbooster", "advancedsystemcare", "imf", "iobitsoftware"], category: "iobit", keep: false },
    // OEM peripheral suites — fine to relaunch, save battery/CPU mid-game
    Suggested { needles: &["razersynapse", "razer central", "razerappengine"], category: "razer", keep: false },
    Suggested { needles: &["logitech", "lghub", "logioptions"], category: "logitech", keep: false },
    // Orphan webviews and silent updaters
    Suggested { needles: &["msedgewebview2"], category: "edge-webview-orphan", keep: false },
    Suggested { needles: &["googleupdater"], category: "google-updater", keep: false },
    Suggested { needles: &["edgeupdate"], category: "edge-updater", keep: false },
    Suggested { needles: &["adobeupdate", "adobenotificationclient", "creativecloud"], category: "adobe", keep: false },
    // Game store launchers — yes, even before launching a game, you don't
    // need ALL of them resident.
    Suggested { needles: &["epicgameslauncher", "epicwebhelper"], category: "epic", keep: false },
    Suggested { needles: &["origin", "easanticheat"], category: "origin", keep: false },
    // Cluttery Windows extras
    Suggested { needles: &["onedrivesetup"], category: "onedrive-setup", keep: false },
    Suggested { needles: &["yourphone"], category: "phone-link", keep: false },
    // Background browsers we didn't ask for
    Suggested { needles: &["chrome", "msedge"], category: "browser-bg", keep: false },
];

fn is_blacklisted(name_lower: &str) -> bool {
    HARD_BLACKLIST.iter().any(|b| name_lower == *b)
}

/// Returns `(matched, category, keep_default)`. `matched` is true when the
/// process is in our curated SUGGESTED table at all; `keep_default` tells
/// the UI to NOT pre-check it.
fn category_for(name_lower: &str) -> (bool, &'static str, bool) {
    for s in SUGGESTED {
        if s.needles.iter().any(|n| name_lower.contains(n)) {
            return (true, s.category, s.keep);
        }
    }
    (false, "", false)
}

// ---------------------------------------------------------------------------
// Enumerate processes
// ---------------------------------------------------------------------------

const MIN_RAM_MB: f64 = 50.0;

pub async fn list_killable_inner(
    app: &tauri::AppHandle,
) -> Result<Vec<GameProcessInfo>, String> {
    // Kirkardo R4 #A: Gaming features (process killer, Windows tweaks,
    // game detection) are Windows-only by design — Steam library paths,
    // MSI Afterburner, GPU OC tools all live in the Windows world. Linux
    // gets a clean empty list / error instead of a spawn crash.
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Ok(Vec::new());
    }
    #[cfg(target_os = "windows")]
    {
    // Aggregate per process-name to avoid 50 chrome.exe rows.
    // PS one-liner:
    //   Get-Process | Group-Object Name | ForEach-Object {
    //     [PSCustomObject]@{ name=$_.Name; ram=($_.Group | Measure -Sum WorkingSet64).Sum;
    //                        pids=($_.Group.Id -join ',') }
    //   } | ConvertTo-Json -Compress
    // Script extracted to scripts/cockpit/gaming-enum.ps1 so the capability
    // can pin the script by path instead of allowing arbitrary -Command up
    // to 4000 chars.
    let script = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/gaming-enum.ps1");
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
        .map_err(|e| format!("spawn ps: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "process enum failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    #[derive(serde::Deserialize)]
    struct Row {
        name: String,
        ram: i64,
        pid: i64,
    }

    let rows: Vec<Row> =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("parse: {}", e))?;

    let mut out: Vec<GameProcessInfo> = Vec::new();
    for r in rows {
        let ram_mb = r.ram as f64 / 1024.0 / 1024.0;
        if ram_mb < MIN_RAM_MB {
            continue;
        }
        let name_lower = r.name.to_lowercase();
        if is_blacklisted(&name_lower) {
            continue;
        }
        let (recognised, category, keep_default) = category_for(&name_lower);
        // `suggested` (pre-check) = recognised AND not flagged as keep.
        let suggested = recognised && !keep_default;
        out.push(GameProcessInfo {
            pid: r.pid,
            name: r.name,
            ram_mb: (ram_mb * 10.0).round() / 10.0,
            category: category.to_string(),
            suggested,
            keep_default,
        });
    }
    // Sort order:
    //   1. suggested-kill rows first (dispensables)
    //   2. then keep-default known apps (comms / spotify / OBS)
    //   3. then everything else
    // Within each group, by RAM desc.
    out.sort_by(|a, b| {
        let group = |g: &GameProcessInfo| {
            if g.suggested { 0 }
            else if g.keep_default { 1 }
            else { 2 }
        };
        group(a)
            .cmp(&group(b))
            .then_with(|| b.ram_mb.partial_cmp(&a.ram_mb).unwrap_or(std::cmp::Ordering::Equal))
    });
    Ok(out)
    } // end #[cfg(target_os = "windows")]
}

// ---------------------------------------------------------------------------
// Kill
// ---------------------------------------------------------------------------

pub async fn kill_processes_inner(
    app: &tauri::AppHandle,
    pids: Vec<i64>,
) -> Result<KillResult, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, pids);
        return Err("Process killer is Windows-only (taskkill). Use kill(1) on Linux.".to_string());
    }
    #[cfg(target_os = "windows")]
    {
    if pids.is_empty() {
        return Ok(KillResult {
            killed: Vec::new(),
            failed: Vec::new(),
            freed_mb_estimate: 0.0,
        });
    }
    if pids.len() > 200 {
        return Err("too many pids in a single kill call (max 200)".to_string());
    }

    // Re-read the process list now to (a) validate the pid still exists and
    // belongs to a non-blacklisted process, and (b) estimate freed RAM.
    let candidates = list_killable_inner(app).await?;
    let allowed: BTreeSet<i64> = candidates.iter().map(|c| c.pid).collect();

    let mut killed: Vec<i64> = Vec::new();
    let mut failed: Vec<KillFailure> = Vec::new();
    let mut freed_mb = 0.0_f64;

    // We send one PS call with all valid pids — single round-trip, taskkill
    // returns per-pid status.
    let mut safe_pids: Vec<i64> = Vec::new();
    for pid in &pids {
        if !allowed.contains(pid) {
            failed.push(KillFailure {
                pid: *pid,
                reason: "pid not in killable list (system / self / IDE / vanished)".to_string(),
            });
        } else {
            safe_pids.push(*pid);
        }
    }

    if !safe_pids.is_empty() {
        // Build taskkill args. /F = force, /T = also tree. We skip /T so that
        // killing a launcher doesn't take down a game the user just spawned.
        let mut args: Vec<String> = vec!["/F".into()];
        for pid in &safe_pids {
            args.push("/PID".into());
            args.push(pid.to_string());
        }
        let str_args: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = app
            .shell()
            .command("taskkill.exe")
            .args(str_args)
            .output()
            .await
            .map_err(|e| format!("spawn taskkill: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        // taskkill prints one line per pid: SUCCESS or ERROR with reason.
        for pid in &safe_pids {
            let pid_marker = format!("PID {}", pid);
            let line = stdout
                .lines()
                .find(|l| l.contains(&pid_marker))
                .unwrap_or("");
            if line.contains("SUCCESS") || line.is_empty() && output.status.success() {
                killed.push(*pid);
                if let Some(c) = candidates.iter().find(|c| c.pid == *pid) {
                    freed_mb += c.ram_mb;
                }
            } else {
                failed.push(KillFailure {
                    pid: *pid,
                    reason: if line.is_empty() {
                        "taskkill returned no per-pid line".to_string()
                    } else {
                        line.trim().to_string()
                    },
                });
            }
        }
    }

    Ok(KillResult {
        killed,
        failed,
        freed_mb_estimate: (freed_mb * 10.0).round() / 10.0,
    })
    } // end #[cfg(target_os = "windows")]
}

// ---------------------------------------------------------------------------
// Windows tweaks (registry + powercfg, user-level only)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct WindowsTweak {
    pub key: String,
    pub label: String,
    pub enabled: bool,
    pub description: String,
    #[serde(default)]
    pub active_guid: String,
    #[serde(default)]
    pub active_name: String,
}

fn tweaks_script() -> Result<PathBuf, String> {
    let p = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/windows-tweaks.ps1");
    if !p.exists() {
        return Err(format!("script missing: {}", p.display()));
    }
    Ok(p)
}

async fn run_tweaks(
    app: &tauri::AppHandle,
    action: &str,
    key: Option<&str>,
) -> Result<Vec<WindowsTweak>, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, action, key);
        return Err("Windows tweaks (registry + powercfg) are Windows-only.".to_string());
    }
    #[cfg(target_os = "windows")]
    {
    let script = tweaks_script()?;
    let script_str = script.to_string_lossy().to_string();
    let mut args: Vec<String> = vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        script_str,
        "-Action".into(),
        action.to_string(),
    ];
    if let Some(k) = key {
        if !matches!(k, "game-dvr" | "game-mode" | "power-plan" | "focus-assist") {
            return Err(format!("invalid tweak key '{}'", k));
        }
        args.push("-Key".into());
        args.push(k.to_string());
    }
    let str_args: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = app
        .shell()
        .command("powershell.exe")
        .args(str_args)
        .output()
        .await
        .map_err(|e| format!("spawn ps: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("windows-tweaks failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    serde_json::from_str::<Vec<WindowsTweak>>(stdout.trim())
        .map_err(|e| format!("parse output: {} (raw={})", e, stdout))
    } // end #[cfg(target_os = "windows")]
}

pub async fn windows_tweaks_status_inner(
    app: &tauri::AppHandle,
) -> Result<Vec<WindowsTweak>, String> {
    run_tweaks(app, "status", None).await
}

pub async fn windows_tweak_set_inner(
    app: &tauri::AppHandle,
    key: String,
    enabled: bool,
) -> Result<Vec<WindowsTweak>, String> {
    let action = if enabled { "apply" } else { "revert" };
    run_tweaks(app, action, Some(&key)).await
}

// ---------------------------------------------------------------------------
// gaming.detected — detect known game processes and emit info alerts
// ---------------------------------------------------------------------------
//
// Heuristic: process names that strongly signal a game session is active
// (storefront foreground processes, popular launchers, anti-cheat
// runtimes). We deliberately keep this list small and unambiguous to
// avoid false positives (no generic "Unity*" / "UE5*" — too noisy with
// dev builds and editors). Add entries here as needed.
const GAME_PROCESS_NEEDLES: &[(&str, &str)] = &[
    // (needle (lowercase substring), human label)
    ("steam.exe", "Steam"),
    ("riotclientservices", "Riot Client"),
    ("leagueoflegends", "League of Legends"),
    ("valorant-win64-shipping", "Valorant"),
    ("vanguard.exe", "Valorant Vanguard"),
    ("eldenring", "Elden Ring"),
    ("cyberpunk2077", "Cyberpunk 2077"),
    ("starcraft", "StarCraft"),
    ("overwatch", "Overwatch"),
    ("battle.net", "Battle.net"),
    ("rocketleague", "Rocket League"),
    ("dota2", "Dota 2"),
    ("csgo.exe", "CS:GO"),
    ("cs2.exe", "Counter-Strike 2"),
    ("fortniteclient-win64-shipping", "Fortnite"),
];

static SEEN_GAMES: once_cell::sync::Lazy<std::sync::Mutex<std::collections::BTreeSet<String>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::BTreeSet::new()));

/// Scan the currently running processes once and emit a gaming.detected
/// alert for every game we recognise that we haven't seen before in this
/// process lifetime. Cheap (single PS one-liner) so it's safe to call
/// from a periodic frontend tick.
///
/// The per-source rate-limiter in `toast_emit` is bypassed-on-source
/// (each game has a unique label) but our local SEEN_GAMES set makes
/// sure we only fire once per game per CC session — when you alt-tab
/// out of and back into a game we don't re-spam.
pub async fn detect_running_games_inner(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Ok(Vec::new());
    }
    #[cfg(target_os = "windows")]
    {
    let script = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/gaming-enum.ps1");
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
        .map_err(|e| format!("spawn ps: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "process enum failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    #[derive(serde::Deserialize)]
    struct Row {
        name: String,
    }
    let rows: Vec<Row> =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("parse: {}", e))?;
    let names_lower: Vec<String> = rows
        .into_iter()
        .map(|r| r.name.to_lowercase())
        .collect();

    let mut newly_detected: Vec<String> = Vec::new();
    let mut seen = match SEEN_GAMES.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    // Drop entries from the seen set for games no longer running so they
    // can re-fire when launched again. This keeps the alert behaviour
    // intuitive: "I closed CS2, then reopened it — I expect a new toast".
    let still_running: std::collections::BTreeSet<String> = GAME_PROCESS_NEEDLES
        .iter()
        .filter(|(needle, _)| names_lower.iter().any(|n| n.contains(needle)))
        .map(|(_, label)| label.to_string())
        .collect();
    seen.retain(|label| still_running.contains(label));

    for (needle, label) in GAME_PROCESS_NEEDLES.iter() {
        let running = names_lower.iter().any(|n| n.contains(needle));
        if running && !seen.contains(*label) {
            seen.insert(label.to_string());
            newly_detected.push(label.to_string());
            crate::toast_emit::record_alert_and_maybe_toast(
                app,
                "gaming.detected",
                "info",
                &format!("Game running: {}", label),
            );
        }
    }
    Ok(newly_detected)
    } // end #[cfg(target_os = "windows")]
}

// LIB_RS_WIRING:
//   Expose the detector as a Tauri command so the frontend (or a
//   periodic tick from setup()) can poll it:
//
//     #[tauri::command]
//     async fn detect_running_games(
//         app: tauri::AppHandle,
//     ) -> Result<Vec<String>, String> {
//         gaming::detect_running_games_inner(&app).await
//     }
//
//   And inside .invoke_handler(tauri::generate_handler![...]):
//     detect_running_games,
