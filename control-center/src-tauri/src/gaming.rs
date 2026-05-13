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
// names that USER tends to have running but doesn't need while gaming.
// The frontend pre-checks rows whose name matches this list; everything
// else is shown unchecked so a stray match doesn't kill something useful.

use std::collections::BTreeSet;

use serde::Serialize;
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
/// gaming. Lowercased substring match against the process name.
struct Suggested {
    needles: &'static [&'static str],
    category: &'static str,
}

const SUGGESTED: &[Suggested] = &[
    Suggested { needles: &["discord", "discordcanary", "discordptb"], category: "discord" },
    Suggested { needles: &["spotify"], category: "spotify" },
    Suggested { needles: &["slack"], category: "slack" },
    Suggested { needles: &["teams"], category: "teams" },
    Suggested { needles: &["onedrive"], category: "onedrive" },
    Suggested { needles: &["googledrivefs", "googledrive"], category: "google-drive" },
    Suggested { needles: &["dropbox"], category: "dropbox" },
    Suggested { needles: &["telegram"], category: "telegram" },
    Suggested { needles: &["whatsapp"], category: "whatsapp" },
    Suggested { needles: &["zoom"], category: "zoom" },
    Suggested { needles: &["obs"], category: "obs" },
    // IObit family
    Suggested { needles: &["iobit", "driverbooster", "advancedsystemcare", "imf", "iobitsoftware"], category: "iobit" },
    // OEM bloat / updaters
    Suggested { needles: &["razersynapse", "razer central", "razerappengine"], category: "razer" },
    Suggested { needles: &["logitech", "lghub", "logioptions"], category: "logitech" },
    Suggested { needles: &["msedgewebview2"], category: "edge-webview-orphan" },
    Suggested { needles: &["googleupdater"], category: "google-updater" },
    Suggested { needles: &["edgeupdate"], category: "edge-updater" },
    Suggested { needles: &["adobeupdate", "adobenotificationclient", "creativecloud"], category: "adobe" },
    Suggested { needles: &["epicgameslauncher", "epicwebhelper"], category: "epic" },
    Suggested { needles: &["origin", "easanticheat"], category: "origin" },
    // Cluttery Windows extras
    Suggested { needles: &["onedrivesetup"], category: "onedrive-setup" },
    Suggested { needles: &["yourphone"], category: "phone-link" },
    // Background browsers we didn't ask for
    Suggested { needles: &["chrome", "msedge"], category: "browser-bg" },
];

fn is_blacklisted(name_lower: &str) -> bool {
    HARD_BLACKLIST.iter().any(|b| name_lower == *b)
}

fn category_for(name_lower: &str) -> (bool, &'static str) {
    for s in SUGGESTED {
        if s.needles.iter().any(|n| name_lower.contains(n)) {
            return (true, s.category);
        }
    }
    (false, "")
}

// ---------------------------------------------------------------------------
// Enumerate processes
// ---------------------------------------------------------------------------

const MIN_RAM_MB: f64 = 50.0;

pub async fn list_killable_inner(
    app: &tauri::AppHandle,
) -> Result<Vec<GameProcessInfo>, String> {
    // Aggregate per process-name to avoid 50 chrome.exe rows.
    // PS one-liner:
    //   Get-Process | Group-Object Name | ForEach-Object {
    //     [PSCustomObject]@{ name=$_.Name; ram=($_.Group | Measure -Sum WorkingSet64).Sum;
    //                        pids=($_.Group.Id -join ',') }
    //   } | ConvertTo-Json -Compress
    let cmd = r#"
$rows = Get-Process -ErrorAction SilentlyContinue | Group-Object ProcessName | ForEach-Object {
    $totalRam = ($_.Group | Measure-Object -Property WorkingSet64 -Sum).Sum
    [PSCustomObject]@{
        name = $_.Name
        ram  = [int64]$totalRam
        pid  = ($_.Group | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 1).Id
    }
}
if ($rows.Count -eq 0) { '[]' }
elseif ($rows.Count -eq 1) { ConvertTo-Json @($rows) -Compress }
else { ConvertTo-Json $rows -Compress }
"#;
    let output = app
        .shell()
        .command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            cmd,
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
        let (suggested, category) = category_for(&name_lower);
        out.push(GameProcessInfo {
            pid: r.pid,
            name: r.name,
            ram_mb: (ram_mb * 10.0).round() / 10.0,
            category: category.to_string(),
            suggested,
        });
    }
    // Suggested first, then by RAM desc
    out.sort_by(|a, b| {
        b.suggested
            .cmp(&a.suggested)
            .then_with(|| b.ram_mb.partial_cmp(&a.ram_mb).unwrap_or(std::cmp::Ordering::Equal))
    });
    Ok(out)
}

// ---------------------------------------------------------------------------
// Kill
// ---------------------------------------------------------------------------

pub async fn kill_processes_inner(
    app: &tauri::AppHandle,
    pids: Vec<i64>,
) -> Result<KillResult, String> {
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
}
