// mar.ia — estado de las copias de seguridad en disco.
//
// Lee los destinos espejo bajo la raiz de copia configurada (la crea
// scripts/backup/weekly-backup.ps1, programada como tarea de Windows
// `MariaBackup-Weekly`). Devuelve una entrada por subcarpeta de primer nivel
// con la fecha de su ultima modificacion, para que la pantalla marque las
// copias viejas sin recorrer gigas de ficheros.
//
// NOMBRES: todo esto decia ULTRON — las carpetas de origen, el fichero de
// configuracion, las variables de entorno y la tarea programada. El usuario
// lo pidio el 2026-09-19 ("en los backups, todas las carpetas estan
// configuradas con lo de Ultron, debe de ser con Maria"). Las rutas se
// resuelven ahora por `maria_paths`, y las variables `ULTRON_*` se siguen
// LEYENDO como respaldo: pueden estar puestas en una tarea programada vieja y
// dejar de mirarlas cambiaria el destino de las copias sin avisar.
//
// Orden para decidir la raiz de copia:
//   1. <raiz de mar.ia>/.tmp/backup-root.txt (lo escribe esta pantalla)
//   2. $MARIA_BACKUP_ROOT, o $ULTRON_BACKUP_ROOT (heredada)
//   3. D:\BACKUP si el disco esta montado
//   4. %USERPROFILE%\BACKUP

use std::fs;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

mod root;
use root::{backup_config_lock, backup_root, backup_root_config_path, read_configured_backup_root};

#[derive(Debug, Serialize, Clone)]
pub struct BackupEntry {
    pub name: String,
    pub path: String,
    pub last_modified: Option<String>,
    pub age_hours: Option<f64>,
    pub exists: bool,
    /// `ok` (< 8 days), `stale` (8–30 days), `cold` (> 30 days).
    pub status: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct BackupStatusReport {
    pub root: String,
    pub root_exists: bool,
    pub entries: Vec<BackupEntry>,
    pub overall_status: String,
}

// ---------------------------------------------------------------------------
// v15.2 F7: read/write the configured backup root from the UI.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct BackupRootInfo {
    /// Currently active path (after resolving the four sources above).
    pub current: String,
    /// Suggested default if `current` is empty (D:\BACKUP if disk mounted,
    /// otherwise ~/BACKUP).
    pub suggested: String,
    /// True when the path resolves to an existing directory.
    pub exists: bool,
    /// True when ~/.ultron/.tmp/backup-root.txt is the source of the value
    /// (i.e. the user has explicitly configured it via the UI).
    pub user_configured: bool,
    /// Path of the config file that backs the setting.
    pub config_path: String,
}

pub fn get_backup_root_inner() -> Result<BackupRootInfo, String> {
    let current = backup_root();
    let user_configured = read_configured_backup_root().is_some();
    let suggested = {
        let d_drive = PathBuf::from(r"D:\BACKUP");
        if d_drive.exists() {
            d_drive.to_string_lossy().to_string()
        } else if let Some(home) = dirs::home_dir() {
            home.join("BACKUP").to_string_lossy().to_string()
        } else {
            r"C:\BACKUP".to_string()
        }
    };
    let config_path = backup_root_config_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(BackupRootInfo {
        current: current.to_string_lossy().to_string(),
        suggested,
        exists: current.exists(),
        user_configured,
        config_path,
    })
}

#[derive(Debug, Deserialize)]
pub struct SetBackupRootPayload {
    pub path: String,
}

pub fn set_backup_root_inner(payload: SetBackupRootPayload) -> Result<BackupRootInfo, String> {
    let trimmed = payload.path.trim().to_string();
    let cfg = backup_root_config_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = cfg.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir tmp: {}", e))?;
        }
    }
    if trimmed.is_empty() {
        // Empty = clear the override and fall back to env/D:/home defaults.
        if cfg.exists() {
            fs::remove_file(&cfg).map_err(|e| format!("rm config: {}", e))?;
        }
        // Also unset the in-process env vars so subsequent reads from the
        // same session don't keep the stale override. Se limpia tambien la
        // heredada: si quedara puesta, el camino de lectura la cogeria.
        std::env::remove_var("MARIA_BACKUP_ROOT");
        std::env::remove_var("ULTRON_BACKUP_ROOT");
    } else {
        fs::write(&cfg, &trimmed).map_err(|e| format!("write config: {}", e))?;
        // Mirror into the env var so the scheduled-task wrapper (which we
        // can't restart from here) and any in-process consumer pick it up.
        std::env::set_var("MARIA_BACKUP_ROOT", &trimmed);
        std::env::remove_var("ULTRON_BACKUP_ROOT");
    }
    get_backup_root_inner()
}

// ---------------------------------------------------------------------------
// v15.5.20: backup sources picker (backups-modular-ui plan).
// The Settings UI lists current sources + suggests other top-level $HOME
// folders the user might want to add. Resolution order mirrors the
// `weekly-backup.{ps1,sh}` scripts:
//   1. <raiz de mar.ia>/cockpit/backup-config.json -> { "sources": ["..."] }
//   2. $MARIA_BACKUP_SOURCES (o $ULTRON_BACKUP_SOURCES), separadas por comas
//   3. Por defecto: la raiz de mar.ia, su vault y `.claude`
// Todas las rutas son relativas a $HOME.
// ---------------------------------------------------------------------------

/// Carpetas que se copian si nadie dice otra cosa.
///
/// No es una constante porque los nombres dependen de la instalacion: en una
/// maquina migrada son `.maria` y `.maria-vault`, y en una que todavia no lo
/// esta, `.ultron` y `.ultron-vault`. Antes estaba escrito a mano con los
/// nombres viejos, que es lo que hacia que la pantalla de Backups siguiera
/// diciendo ULTRON despues de la migracion.
fn default_backup_sources() -> Vec<String> {
    vec![
        crate::maria_paths::nombre_en_home(),
        crate::maria_paths::nombre_vault_en_home(),
        ".claude".to_string(),
    ]
}

fn backup_sources_config_path() -> Option<PathBuf> {
    Some(crate::maria_paths::home().join("cockpit/backup-config.json"))
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct BackupSourcesConfig {
    #[serde(default)]
    sources: Vec<String>,
    /// v2.5.2 (backups-redesign): persisted weekly schedule. The
    /// `set_backup_schedule` command also registers a `MariaBackup-Weekly`
    /// Windows Task Scheduler entry; this field is the durable record the
    /// UI reads back to pre-fill the day/time dropdowns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    schedule: Option<BackupScheduleConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BackupScheduleConfig {
    /// Three-letter uppercase weekday (MON, TUE, WED, THU, FRI, SAT, SUN).
    pub day: String,
    /// 24-hour HH:MM (e.g. "03:00").
    pub time: String,
}

fn read_full_config() -> Option<BackupSourcesConfig> {
    let path = backup_sources_config_path()?;
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_configured_sources() -> Option<Vec<String>> {
    let parsed = read_full_config()?;
    let cleaned: Vec<String> = parsed
        .sources
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn read_configured_schedule() -> Option<BackupScheduleConfig> {
    read_full_config()?.schedule
}

fn resolved_sources() -> Vec<String> {
    if let Some(configured) = read_configured_sources() {
        return configured;
    }
    for var in ["MARIA_BACKUP_SOURCES", "ULTRON_BACKUP_SOURCES"] {
        let Ok(env_val) = std::env::var(var) else {
            continue;
        };
        let from_env: Vec<String> = env_val
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !from_env.is_empty() {
            return from_env;
        }
    }
    default_backup_sources()
}

#[derive(Debug, Serialize, Clone)]
pub struct BackupSourceCandidate {
    /// $HOME-relative folder name (e.g. "Documents", ".ultron").
    pub name: String,
    /// Absolute path used to display + verify existence.
    pub absolute: String,
    /// True when the folder currently exists on disk.
    pub exists: bool,
    /// True when this source is in the active list (config / env / defaults).
    pub selected: bool,
    /// True when this source is a default (la raiz de mar.ia, su vault, `.claude`).
    pub is_default: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct BackupSourcesInfo {
    pub configured: Vec<String>,
    pub defaults: Vec<String>,
    pub active: Vec<String>,
    pub candidates: Vec<BackupSourceCandidate>,
    pub config_path: String,
    pub user_configured: bool,
}

fn list_home_top_level() -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let Ok(rd) = fs::read_dir(&home) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort_by_key(|a| a.to_lowercase());
    names
}

pub fn get_backup_sources_inner() -> Result<BackupSourcesInfo, String> {
    let configured = read_configured_sources().unwrap_or_default();
    let active = resolved_sources();
    let defaults: Vec<String> = default_backup_sources();
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;

    let mut candidates: Vec<BackupSourceCandidate> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Active sources first (whether they live on disk or not — keep the row visible).
    for name in active.iter() {
        if seen.contains(name) {
            continue;
        }
        seen.insert(name.clone());
        let abs = home.join(name);
        candidates.push(BackupSourceCandidate {
            name: name.clone(),
            absolute: abs.to_string_lossy().to_string(),
            exists: abs.exists(),
            selected: true,
            is_default: defaults.iter().any(|d| d == name),
        });
    }
    // Then any default that's not already in the active list.
    for d in defaults.iter() {
        if seen.contains(d) {
            continue;
        }
        seen.insert(d.clone());
        let abs = home.join(d);
        candidates.push(BackupSourceCandidate {
            name: d.clone(),
            absolute: abs.to_string_lossy().to_string(),
            exists: abs.exists(),
            selected: false,
            is_default: true,
        });
    }
    // Finally, populate with $HOME top-level folders so the user can pick more.
    for name in list_home_top_level() {
        if seen.contains(&name) {
            continue;
        }
        // Skip noisy system folders that nobody would back up.
        if matches!(
            name.as_str(),
            "AppData"
                | "NTUSER.DAT"
                | "Application Data"
                | "Local Settings"
                | "Cookies"
                | "Recent"
                | "SendTo"
                | "NetHood"
                | "PrintHood"
                | "Templates"
                | "Datos de programa"
                | "Entorno de red"
                | "Configuración local"
                | "Mis documentos"
                | "Menú Inicio"
                | "Reciente"
        ) {
            continue;
        }
        seen.insert(name.clone());
        let abs = home.join(&name);
        candidates.push(BackupSourceCandidate {
            name: name.clone(),
            absolute: abs.to_string_lossy().to_string(),
            exists: abs.exists(),
            selected: false,
            is_default: false,
        });
    }

    Ok(BackupSourcesInfo {
        configured,
        defaults,
        active,
        candidates,
        config_path: backup_sources_config_path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        user_configured: read_configured_sources().is_some(),
    })
}

#[derive(Debug, Deserialize)]
pub struct SetBackupSourcesPayload {
    pub sources: Vec<String>,
}

pub fn set_backup_sources_inner(
    payload: SetBackupSourcesPayload,
) -> Result<BackupSourcesInfo, String> {
    let cleaned: Vec<String> = payload
        .sources
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let cfg = backup_sources_config_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = cfg.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir cockpit: {}", e))?;
        }
    }

    // Acquire the write lock before the read-modify-write so a concurrent
    // `set_backup_schedule_inner` call cannot clobber the schedule field (or
    // vice versa) by reading stale data and re-serialising over our changes.
    let _guard = backup_config_lock()
        .lock()
        .map_err(|e| format!("backup-config lock poisoned: {}", e))?;

    // v2.5.2 (backups-redesign): preserve any existing `schedule` field
    // when rewriting the config. Without this, saving the sources list
    // would silently drop the weekly schedule the user already set.
    let existing_schedule = read_configured_schedule();
    if cleaned.is_empty() && existing_schedule.is_none() {
        if cfg.exists() {
            fs::remove_file(&cfg).map_err(|e| format!("rm config: {}", e))?;
        }
        std::env::remove_var("MARIA_BACKUP_SOURCES");
        std::env::remove_var("ULTRON_BACKUP_SOURCES");
    } else {
        let payload_out = BackupSourcesConfig {
            sources: cleaned.clone(),
            schedule: existing_schedule,
        };
        let json = serde_json::to_string_pretty(&payload_out)
            .map_err(|e| format!("serialize config: {}", e))?;
        // Atomic write: serialise to a sibling tmp file then rename over the
        // target. A crash between write and rename leaves the original intact.
        // The tmp lives in the same directory as the target (same volume) so
        // the rename is a single-syscall atomic replace (POSIX) / MoveFileEx
        // (Windows) — never a cross-device copy+delete.
        let tmp = cfg.with_extension("json.tmp");
        {
            let file =
                fs::File::create(&tmp).map_err(|e| format!("create backup-config tmp: {}", e))?;
            let mut writer = BufWriter::new(file);
            writer
                .write_all(json.as_bytes())
                .map_err(|e| format!("write backup-config tmp: {}", e))?;
            writer
                .flush()
                .map_err(|e| format!("flush backup-config tmp: {}", e))?;
        }
        fs::rename(&tmp, &cfg).map_err(|e| format!("rename backup-config.json: {}", e))?;
        // Mirror into the env var so any in-process script reads it without
        // re-reading the JSON.
        std::env::remove_var("ULTRON_BACKUP_SOURCES");
        if cleaned.is_empty() {
            std::env::remove_var("MARIA_BACKUP_SOURCES");
        } else {
            std::env::set_var("MARIA_BACKUP_SOURCES", cleaned.join(","));
        }
    }
    get_backup_sources_inner()
}

// ---------------------------------------------------------------------------
// v2.5.2 (backups-redesign): weekly schedule read/write + Windows Task
// Scheduler integration.
//
// The schedule lives in two places:
//   - The durable record: backup-config.json (`schedule: { day, time }`).
//   - The Windows scheduled task `MariaBackup-Weekly` (created via
//     `schtasks /Create /SC WEEKLY ...`). Non-Windows hosts skip the
//     schtasks call and only persist the preference — the existing weekly
//     backup script is Windows-only anyway.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct BackupScheduleInfo {
    pub day: String,
    pub time: String,
    /// True when a `MariaBackup-Weekly` task is registered with the OS.
    /// Non-Windows always reports false.
    pub task_registered: bool,
    /// True when the user has explicitly saved a schedule (vs. the
    /// "Mon 09:00" default that the UI uses to pre-fill the form).
    pub user_configured: bool,
}

#[derive(Debug, Deserialize)]
pub struct SetBackupSchedulePayload {
    pub day: String,
    pub time: String,
}

const VALID_DAYS: &[&str] = &["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

fn validate_day(day: &str) -> Result<String, String> {
    let up = day.trim().to_uppercase();
    if VALID_DAYS.iter().any(|d| *d == up) {
        Ok(up)
    } else {
        Err(format!(
            "invalid day '{}' (expected one of MON/TUE/WED/THU/FRI/SAT/SUN)",
            day
        ))
    }
}

fn validate_time(time: &str) -> Result<String, String> {
    let trimmed = time.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return Err(format!("invalid time '{}' (expected HH:MM)", time));
    }
    let h: u32 = trimmed[0..2]
        .parse()
        .map_err(|_| format!("invalid hour in '{}'", time))?;
    let m: u32 = trimmed[3..5]
        .parse()
        .map_err(|_| format!("invalid minute in '{}'", time))?;
    if h > 23 || m > 59 {
        return Err(format!("invalid time '{}' (out of range)", time));
    }
    Ok(trimmed.to_string())
}

/// Nombre de la tarea programada de Windows.
///
/// El nombre viejo se sigue mirando: si alguien tiene registrada la tarea de
/// antes, decirle "no hay copia programada" seria mentira. Al guardar un
/// horario nuevo se borra (ver `register_weekly_task`), para que no corran las
/// dos.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const TAREA: &str = "MariaBackup-Weekly";
#[cfg(target_os = "windows")]
const TAREA_HEREDADA: &str = "UltronBackup-Weekly";

#[cfg(target_os = "windows")]
fn existe_tarea(nombre: &str) -> bool {
    // `proc::oculto` ya trae CREATE_NO_WINDOW: sin el, cada sondeo abriria una
    // consola negra en la cara del usuario.
    crate::proc::oculto("schtasks.exe")
        .args(["/Query", "/TN", nombre])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn task_registered() -> bool {
    existe_tarea(TAREA) || existe_tarea(TAREA_HEREDADA)
}

#[cfg(not(target_os = "windows"))]
fn task_registered() -> bool {
    false
}

pub fn get_backup_schedule_inner() -> Result<BackupScheduleInfo, String> {
    let configured = read_configured_schedule();
    let user_configured = configured.is_some();
    let (day, time) = configured
        .map(|s| (s.day, s.time))
        .unwrap_or_else(|| ("MON".to_string(), "09:00".to_string()));
    Ok(BackupScheduleInfo {
        day,
        time,
        task_registered: task_registered(),
        user_configured,
    })
}

#[cfg(target_os = "windows")]
fn register_weekly_task(day: &str, time: &str) -> Result<(), String> {
    
    let script_path = crate::maria_paths::home().join("scripts\\backup\\weekly-backup.ps1");
    if !script_path.is_file() {
        return Err(format!(
            "weekly-backup.ps1 missing at {}",
            script_path.display()
        ));
    }
    let tr = format!(
        "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\"",
        script_path.display()
    );
    // schtasks /F overwrites any existing task with the same name, which
    // is exactly the upsert semantics the UI wants.
    let mut cmd = crate::proc::oculto("schtasks.exe");
    cmd.args([
        "/Create",
        "/SC",
        "WEEKLY",
        "/D",
        day,
        "/ST",
        time,
        "/TN",
        TAREA,
        "/TR",
        &tr,
        "/RL",
        "LIMITED",
        "/F",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().map_err(|e| format!("spawn schtasks: {}", e))?;
    // Fuera la tarea con el nombre viejo: si se quedara, la copia correria dos
    // veces y con el horario antiguo.
    if output.status.success() && existe_tarea(TAREA_HEREDADA) {
        let _ = crate::proc::oculto("schtasks.exe")
            .args(["/Delete", "/TN", TAREA_HEREDADA, "/F"])
            .output();
    }
    if !output.status.success() {
        return Err(format!(
            "schtasks /Create failed (exit {:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

pub fn set_backup_schedule_inner(
    payload: SetBackupSchedulePayload,
) -> Result<BackupScheduleInfo, String> {
    let day = validate_day(&payload.day)?;
    let time = validate_time(&payload.time)?;

    // Persist preference first so the UI reflects the saved state even if
    // the schtasks call later fails on a non-Windows host.
    let cfg_path = backup_sources_config_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = cfg_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir cockpit: {}", e))?;
        }
    }

    // Acquire the write lock before the read-modify-write so a concurrent
    // `set_backup_sources_inner` call cannot clobber the sources list (or
    // vice versa) by reading stale data and re-serialising over our changes.
    let _guard = backup_config_lock()
        .lock()
        .map_err(|e| format!("backup-config lock poisoned: {}", e))?;

    let mut cfg = read_full_config().unwrap_or_default();
    cfg.schedule = Some(BackupScheduleConfig {
        day: day.clone(),
        time: time.clone(),
    });
    let json =
        serde_json::to_string_pretty(&cfg).map_err(|e| format!("serialize config: {}", e))?;
    // Atomic write: serialise to a sibling tmp file then rename over the
    // target. Same pattern as `set_backup_sources_inner` and the rest of the
    // codebase (kanban, kg, sessions-tags). Guarantees the on-disk file is
    // never in a partial state if the process is killed mid-write.
    let tmp = cfg_path.with_extension("json.tmp");
    {
        let file =
            fs::File::create(&tmp).map_err(|e| format!("create backup-config tmp: {}", e))?;
        let mut writer = BufWriter::new(file);
        writer
            .write_all(json.as_bytes())
            .map_err(|e| format!("write backup-config tmp: {}", e))?;
        writer
            .flush()
            .map_err(|e| format!("flush backup-config tmp: {}", e))?;
    }
    fs::rename(&tmp, &cfg_path).map_err(|e| format!("rename backup-config.json: {}", e))?;

    // Register the Windows scheduled task. On Linux/macOS we just store the
    // preference — the weekly-backup script doesn't ship a Unix entry point
    // yet (TODO: systemd timer / launchd plist).
    #[cfg(target_os = "windows")]
    {
        register_weekly_task(&day, &time)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&day, &time);
    }

    get_backup_schedule_inner()
}

fn iso_from_systime(t: SystemTime) -> Option<String> {
    let secs = t.duration_since(UNIX_EPOCH).ok()?.as_secs();
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
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        days + 1,
        h,
        m,
        s
    ))
}

fn classify(age_hours: Option<f64>) -> &'static str {
    match age_hours {
        Some(h) if h < 8.0 * 24.0 => "ok",
        Some(h) if h < 30.0 * 24.0 => "stale",
        Some(_) => "cold",
        None => "unknown",
    }
}

/// Walks one level deep so we don't du gigabytes. Mtime of the top-level
/// subdir is what robocopy /MIR touches on every run, so this is a faithful
/// proxy for "when was the backup last refreshed".
pub fn backup_status_inner() -> Result<BackupStatusReport, String> {
    let root = backup_root();
    let root_str = root.to_string_lossy().to_string();
    let root_exists = root.exists();
    if !root_exists {
        return Ok(BackupStatusReport {
            root: root_str,
            root_exists: false,
            entries: Vec::new(),
            overall_status: "missing".into(),
        });
    }

    let mut entries: Vec<BackupEntry> = Vec::new();
    let now = SystemTime::now();
    let dir = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for ent in dir.flatten() {
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        let meta = ent.metadata().ok();
        let mtime = meta.as_ref().and_then(|m| m.modified().ok());
        let age_hours =
            mtime.and_then(|t| now.duration_since(t).ok().map(|d| d.as_secs_f64() / 3600.0));
        let last_iso = mtime.and_then(iso_from_systime);
        let status = classify(age_hours).to_string();
        entries.push(BackupEntry {
            name,
            path: path.to_string_lossy().to_string(),
            last_modified: last_iso,
            age_hours,
            exists: true,
            status,
        });
    }
    // Most-recently-modified first.
    entries.sort_by(|a, b| {
        a.age_hours
            .unwrap_or(f64::INFINITY)
            .partial_cmp(&b.age_hours.unwrap_or(f64::INFINITY))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let overall_status = if entries.is_empty() {
        "empty"
    } else if entries.iter().any(|e| e.status == "cold") {
        "cold"
    } else if entries.iter().any(|e| e.status == "stale") {
        "stale"
    } else {
        "ok"
    }
    .into();

    Ok(BackupStatusReport {
        root: root_str,
        root_exists,
        entries,
        overall_status,
    })
}

// LIB_RS_WIRING (v15.2 F7):
//   Register two new commands in `src-tauri/src/lib.rs` so the Backups
//   sub-tab can read/write the configured backup root.
//
//   1. Add Tauri command wrappers next to `backup_status`:
//
//        #[tauri::command]
//        async fn get_backup_root() -> Result<backup_status::BackupRootInfo, String> {
//            backup_status::get_backup_root_inner()
//        }
//
//        #[tauri::command]
//        async fn set_backup_root(path: String) -> Result<backup_status::BackupRootInfo, String> {
//            backup_status::set_backup_root_inner(backup_status::SetBackupRootPayload { path })
//        }
//
//   2. Add `get_backup_root` and `set_backup_root` to the
//      `tauri::generate_handler![...]` list (same list that already
//      contains `backup_status`).
//
//   The existing `backup_status` command already calls `backup_root()`
//   internally, which now resolves the user-configured override first —
//   no change needed to that wrapper.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn las_carpetas_por_defecto_llevan_el_nombre_de_maria() {
        // El usuario lo reporto asi (2026-09-19): "en los backups, todas las
        // carpetas estan configuradas con lo de Ultron. Debe de ser con
        // Maria". En una maquina migrada (la suya) no puede salir ni un
        // `.ultron`: la raiz se llama `.maria` y el vault `.maria-vault`.
        //
        // En una maquina SIN migrar los nombres viejos son los correctos, asi
        // que lo que se exige es coherencia con lo que hay en el disco, no un
        // literal.
        let d = default_backup_sources();
        assert_eq!(d.len(), 3, "raiz, vault y .claude: {d:?}");
        assert_eq!(d[0], crate::maria_paths::nombre_en_home());
        assert!(d[1].ends_with("-vault"), "{d:?}");
        assert_eq!(d[2], ".claude");
        // Y los dos primeros a juego: raiz `.maria` con vault `.maria-vault`,
        // no una de cada.
        let raiz = d[0].trim_start_matches('.');
        assert!(d[1].contains(raiz), "raiz y vault descuadrados: {d:?}");
    }

    #[test]
    fn la_tarea_programada_ya_no_se_llama_ultron() {
        assert_eq!(TAREA, "MariaBackup-Weekly");
    }

    #[test]
    fn la_configuracion_vive_bajo_la_raiz_de_maria() {
        // Caso negativo del fallo: estas dos rutas se construian a mano con
        // `.ultron` y por eso la pantalla seguia mostrando el nombre viejo.
        let raiz = crate::maria_paths::home();
        let cfg = backup_sources_config_path().expect("ruta de configuracion");
        assert!(cfg.starts_with(&raiz), "{} no cuelga de {}", cfg.display(), raiz.display());
    }
}
