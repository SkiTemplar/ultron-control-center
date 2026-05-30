//! Control Center 2.0 — Native PC diagnostic checks.
//!
//! Replaces the legacy Python `run_doctor` shell-out. Uses `sysinfo`
//! cross-platform for system/disk/process info and `wmi` on Windows
//! for Event Log queries. Network is a TCP connect to 1.1.1.1:443.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sysinfo::{Disks, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Ok,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,
    pub kernel: String,
    pub hostname: String,
    pub uptime_seconds: u64,
    pub cpu_brand: String,
    pub cpu_cores: usize,
    pub cpu_usage_percent: f32,
    pub ram_total_mb: u64,
    pub ram_used_mb: u64,
    pub ram_usage_percent: f32,
    pub severity: Severity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    pub mount: String,
    pub total_gb: f64,
    pub free_gb: f64,
    pub used_percent: f32,
    pub severity: Severity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub mem_mb: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventLogEntry {
    pub log_name: String,
    pub source: String,
    pub level: String,
    pub event_id: u32,
    pub message: String,
    pub time_generated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkStatus {
    pub reachable: bool,
    pub latency_ms: Option<u64>,
    pub severity: Severity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppHealth {
    pub projects_json_ok: bool,
    pub claude_in_path: bool,
    pub codex_in_path: bool,
    pub gemini_in_path: bool,
    pub mem0_configured: bool,
    pub severity: Severity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticReport {
    pub timestamp: String,
    pub system: SystemInfo,
    pub disks: Vec<DiskInfo>,
    pub top_processes: Vec<ProcessInfo>,
    pub event_log: Vec<EventLogEntry>,
    pub network: NetworkStatus,
    pub app: AppHealth,
    pub max_severity: Severity,
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

pub fn check_system_info() -> SystemInfo {
    let mut sys = System::new_all();
    sys.refresh_all();
    // sysinfo requires two refreshes for accurate CPU%.
    std::thread::sleep(Duration::from_millis(200));
    sys.refresh_cpu_usage();

    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().to_string())
        .unwrap_or_default();
    let cpu_usage_percent =
        sys.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>() / sys.cpus().len().max(1) as f32;
    let ram_total_mb = sys.total_memory() / 1024 / 1024;
    let ram_used_mb = sys.used_memory() / 1024 / 1024;
    let ram_usage_percent = if ram_total_mb > 0 {
        (ram_used_mb as f32 / ram_total_mb as f32) * 100.0
    } else {
        0.0
    };
    let severity = match ram_usage_percent {
        p if p >= 90.0 => Severity::Error,
        p if p >= 75.0 => Severity::Warn,
        _ => Severity::Ok,
    };
    SystemInfo {
        os: System::name().unwrap_or_else(|| "unknown".to_string()),
        kernel: System::kernel_version().unwrap_or_default(),
        hostname: System::host_name().unwrap_or_default(),
        uptime_seconds: System::uptime(),
        cpu_brand,
        cpu_cores: sys.cpus().len(),
        cpu_usage_percent,
        ram_total_mb,
        ram_used_mb,
        ram_usage_percent,
        severity,
    }
}

pub fn check_disks() -> Vec<DiskInfo> {
    let disks = Disks::new_with_refreshed_list();
    disks
        .iter()
        .map(|d| {
            let total = d.total_space() as f64 / 1_073_741_824.0; // 1024^3
            let free = d.available_space() as f64 / 1_073_741_824.0;
            let used_percent = if total > 0.0 {
                ((total - free) / total * 100.0) as f32
            } else {
                0.0
            };
            let severity = match used_percent {
                p if p >= 95.0 => Severity::Error,
                p if p >= 85.0 => Severity::Warn,
                _ => Severity::Ok,
            };
            DiskInfo {
                mount: d.mount_point().display().to_string(),
                total_gb: total,
                free_gb: free,
                used_percent,
                severity,
            }
        })
        .collect()
}

pub fn check_top_processes(n: usize) -> Vec<ProcessInfo> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, ProcessRefreshKind::everything());
    // Two refreshes ~200ms apart so cpu_usage() returns deltas, not zero.
    std::thread::sleep(Duration::from_millis(200));
    sys.refresh_processes_specifics(ProcessesToUpdate::All, ProcessRefreshKind::everything());
    let mut procs: Vec<ProcessInfo> = sys
        .processes()
        .iter()
        .map(|(pid, p)| ProcessInfo {
            pid: pid.as_u32(),
            name: p.name().to_string_lossy().to_string(),
            cpu_percent: p.cpu_usage(),
            mem_mb: p.memory() / 1024 / 1024,
        })
        .collect();
    procs.sort_by(|a, b| {
        b.cpu_percent
            .partial_cmp(&a.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    procs.truncate(n);
    procs
}

#[cfg(target_os = "windows")]
pub fn check_event_log_windows(hours: u32) -> Vec<EventLogEntry> {
    use wmi::{COMLibrary, Variant, WMIConnection};
    let mut out = Vec::new();
    let com = match COMLibrary::new() {
        Ok(c) => c,
        Err(_) => return out,
    };
    let wmi = match WMIConnection::new(com) {
        Ok(c) => c,
        Err(_) => return out,
    };
    let cutoff_minutes = hours as i64 * 60;
    let query = format!(
        "SELECT LogFile, SourceName, Type, EventCode, Message, TimeGenerated FROM Win32_NTLogEvent \
         WHERE (LogFile='System' OR LogFile='Application') AND \
         (Type='Error' OR Type='Warning') AND \
         TimeGenerated > '{}'",
        wmi_cutoff_string(cutoff_minutes)
    );
    let results: Result<Vec<std::collections::HashMap<String, Variant>>, _> = wmi.raw_query(&query);
    if let Ok(rows) = results {
        for row in rows.into_iter().take(50) {
            out.push(EventLogEntry {
                log_name: string_of(&row, "LogFile"),
                source: string_of(&row, "SourceName"),
                level: string_of(&row, "Type"),
                event_id: u32_of(&row, "EventCode"),
                message: string_of(&row, "Message"),
                time_generated: string_of(&row, "TimeGenerated"),
            });
        }
    }
    out
}

#[cfg(not(target_os = "windows"))]
pub fn check_event_log_windows(_hours: u32) -> Vec<EventLogEntry> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn wmi_cutoff_string(minutes_back: i64) -> String {
    use chrono::Utc;
    let dt = Utc::now() - chrono::Duration::minutes(minutes_back);
    dt.format("%Y%m%d%H%M%S.000000+000").to_string()
}

#[cfg(target_os = "windows")]
fn string_of(row: &std::collections::HashMap<String, wmi::Variant>, k: &str) -> String {
    match row.get(k) {
        Some(wmi::Variant::String(s)) => s.clone(),
        Some(other) => format!("{:?}", other),
        None => String::new(),
    }
}

#[cfg(target_os = "windows")]
fn u32_of(row: &std::collections::HashMap<String, wmi::Variant>, k: &str) -> u32 {
    match row.get(k) {
        Some(wmi::Variant::UI4(n)) => *n,
        Some(wmi::Variant::I4(n)) => *n as u32,
        Some(wmi::Variant::I2(n)) => *n as u32,
        _ => 0,
    }
}

/// Cloudflare DNS resolver — used for the network reachability check.
/// Defined as a const so the parse cannot panic at runtime.
const NETWORK_CHECK_HOST: &str = "1.1.1.1:443";

pub fn check_network() -> NetworkStatus {
    use std::net::{SocketAddr, TcpStream};

    let addr: SocketAddr = match NETWORK_CHECK_HOST.parse() {
        Ok(a) => a,
        Err(e) => {
            // Should never happen with the compile-time literal above, but
            // returning a diagnostic failure is safer than panicking.
            eprintln!("[diagnostics] failed to parse network check addr: {e}");
            return NetworkStatus {
                reachable: false,
                latency_ms: None,
                severity: Severity::Error,
            };
        }
    };

    let start = std::time::Instant::now();
    let res = TcpStream::connect_timeout(&addr, Duration::from_secs(2));
    match res {
        Ok(_) => NetworkStatus {
            reachable: true,
            latency_ms: Some(start.elapsed().as_millis() as u64),
            severity: Severity::Ok,
        },
        Err(_) => NetworkStatus {
            reachable: false,
            latency_ms: None,
            severity: Severity::Error,
        },
    }
}

pub fn check_app_specific() -> AppHealth {
    let projects_json = projects_json_path();
    let projects_json_ok = projects_json
        .as_ref()
        .map(|p| {
            std::fs::read_to_string(p)
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .is_some()
        })
        .unwrap_or(false);
    let claude_in_path = which::which("claude").is_ok();
    let codex_in_path = which::which("codex").is_ok();
    let gemini_in_path = which::which("gemini").is_ok();
    let mem0_configured = mem0_configured();

    let severity = if !claude_in_path {
        Severity::Error
    } else if !projects_json_ok || !mem0_configured {
        Severity::Warn
    } else {
        Severity::Ok
    };
    AppHealth {
        projects_json_ok,
        claude_in_path,
        codex_in_path,
        gemini_in_path,
        mem0_configured,
        severity,
    }
}

fn projects_json_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".ultron").join("cockpit").join("projects.json"))
}

fn mem0_configured() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let p = home.join(".claude").join("settings.json");
    let Ok(txt) = std::fs::read_to_string(&p) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&txt) else {
        return false;
    };
    json.get("mcpServers")
        .and_then(|m| m.get("mem0"))
        .is_some()
        || json.get("mem0").is_some()
}

pub fn run_full_diagnostic_native() -> DiagnosticReport {
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%SZ").to_string();
    let system = check_system_info();
    let disks = check_disks();
    let top_processes = check_top_processes(10);
    let event_log = check_event_log_windows(24);
    let network = check_network();
    let app = check_app_specific();
    let max_severity = [
        system.severity,
        disks
            .iter()
            .map(|d| d.severity)
            .max()
            .unwrap_or(Severity::Ok),
        network.severity,
        app.severity,
    ]
    .into_iter()
    .max()
    .unwrap_or(Severity::Ok);
    DiagnosticReport {
        timestamp,
        system,
        disks,
        top_processes,
        event_log,
        network,
        app,
        max_severity,
    }
}
