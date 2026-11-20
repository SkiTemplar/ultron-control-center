// ULTRON Control Center — Settings module.
//
// Read/write ~/.claude/settings.json from the UI. Mutations are sensitive:
//   - we make a timestamped backup before every save
//   - we never serialize a partial document; only the full parsed JSON
//   - the frontend round-trips the entire object so we don't accidentally
//     drop fields we don't know about (forward compatibility)
//
// Out of scope here (intentionally): editing the raw text with arbitrary
// content. The frontend works with structured JSON only.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
pub struct SettingsSnapshot {
    pub path: String,
    pub content: serde_json::Value,
    /// Huella de los bytes leídos; el guardado la exige (concurrencia optimista).
    pub content_hash: String,
    pub modified: Option<String>,
    pub size_bytes: u64,
    pub backup_dir: String,
    pub recent_backups: Vec<String>,
}

fn claude_settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/settings.json"))
}

fn backups_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/backups/control-center-settings"))
}

fn iso_now_compact() -> String {
    let secs = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // YYYYMMDDTHHMMSS — used in filenames
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
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}",
        year,
        month + 1,
        days + 1,
        h,
        m,
        s
    )
}

fn iso_pretty(secs: u64) -> String {
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
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        days + 1,
        h,
        m,
        s
    )
}

fn list_recent_backups(dir: &Path) -> Vec<String> {
    if !dir.exists() {
        return Vec::new();
    }
    let mut entries: Vec<(SystemTime, String)> = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mt = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            entries.push((mt, name.to_string()));
        }
    }
    entries.sort_by_key(|b| std::cmp::Reverse(b.0));
    entries.into_iter().take(8).map(|(_, n)| n).collect()
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

pub fn settings_read_inner() -> Result<SettingsSnapshot, String> {
    let path = claude_settings_path().ok_or_else(|| "no HOME".to_string())?;
    let backup_dir = backups_dir().ok_or_else(|| "no HOME".to_string())?;
    read_snapshot_at(&path, &backup_dir)
}

/// Lectura de [`settings_read_inner`] sobre rutas explícitas (testeable).
fn read_snapshot_at(path: &Path, backup_dir: &Path) -> Result<SettingsSnapshot, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("read settings.json: {}", e))?;
    let content: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse settings.json: {}", e))?;
    let meta = fs::metadata(path).ok();
    let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta.and_then(|m| m.modified().ok()).and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| iso_pretty(d.as_secs()))
    });
    let recent_backups = list_recent_backups(backup_dir);

    Ok(SettingsSnapshot {
        path: path.to_string_lossy().to_string(),
        content,
        content_hash: content_hash(raw.as_bytes()),
        modified,
        size_bytes,
        backup_dir: backup_dir.to_string_lossy().to_string(),
        recent_backups,
    })
}

// ---------------------------------------------------------------------------
// Concurrencia optimista
// ---------------------------------------------------------------------------
//
// Ajustes lee settings.json al montarse y guarda el objeto entero del borrador.
// Si entretanto otro proceso (una sesión de Claude con update-config, un hook)
// edita el fichero, guardar la foto vieja revertiría esa edición sin aviso
// (auditoría 2026-11-08, hallazgo 27). La lectura devuelve la huella de los
// bytes leídos y el guardado la exige: si el fichero ya no tiene esa huella,
// se rechaza sin escribir nada. Queda una ventana mínima entre la comprobación
// y el rename: cubre el caso real (minutos con la pestaña abierta), no dos
// escritores en el mismo instante.

/// Huella de un fichero que no existe.
const MISSING_FILE_HASH: &str = "ausente";

/// Huella de los bytes de settings.json. Solo se compara dentro del mismo
/// binario (lectura y guardado), así que basta `DefaultHasher`, cuyas
/// instancias de `new()` son deterministas en una misma ejecución; la longitud
/// reduce aún más las colisiones.
fn content_hash(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}-{}", hasher.finish(), bytes.len())
}

/// Huella del contenido actual en disco ([`MISSING_FILE_HASH`] si no existe).
fn disk_hash(path: &Path) -> Result<String, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(content_hash(&bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(MISSING_FILE_HASH.to_string()),
        Err(e) => Err(format!("read settings.json: {}", e)),
    }
}

/// Huella actual de `~/.claude/settings.json`, para el llamante que guarda sin
/// haber podido leer un snapshot (fichero ausente o corrupto).
pub fn current_content_hash() -> Result<String, String> {
    let path = claude_settings_path().ok_or_else(|| "no HOME".to_string())?;
    disk_hash(&path)
}

/// Error del guardado cuando el fichero cambió en disco desde la lectura.
pub const STALE_SETTINGS_ERROR: &str = "settings.json ha cambiado en disco desde que se leyó \
     (otra sesión o un hook lo ha editado). No se ha guardado nada: descarta los cambios, \
     recarga y vuelve a aplicarlos.";

// ---------------------------------------------------------------------------
// Save (with timestamped backup)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SettingsSavePayload {
    pub content: serde_json::Value,
    /// `content_hash` del snapshot sobre el que se editó `content`.
    pub expected_hash: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SettingsSaveResult {
    pub success: bool,
    pub backup_path: Option<String>,
    pub new_size_bytes: u64,
}

pub fn settings_save_inner(payload: SettingsSavePayload) -> Result<SettingsSaveResult, String> {
    let path = claude_settings_path().ok_or_else(|| "no HOME".to_string())?;
    let backup_dir = backups_dir().ok_or_else(|| "no HOME".to_string())?;
    save_at(&path, &backup_dir, payload)
}

/// Guardado de [`settings_save_inner`] sobre rutas explícitas (testeable).
fn save_at(
    path: &Path,
    backup_dir: &Path,
    payload: SettingsSavePayload,
) -> Result<SettingsSaveResult, String> {
    // Refuse anything that isn't a JSON object at top level. settings.json
    // is an object per Claude Code's own schema; this catches accidental
    // serialization of a wrapping array or a scalar.
    if !payload.content.is_object() {
        return Err("settings.json root must be a JSON object".to_string());
    }
    // Antes de tocar nada (ni la copia): si el fichero cambió, no se escribe.
    if disk_hash(path)? != payload.expected_hash {
        return Err(STALE_SETTINGS_ERROR.to_string());
    }

    if !backup_dir.exists() {
        fs::create_dir_all(backup_dir).map_err(|e| format!("mkdir backups: {}", e))?;
    }

    // Backup current file (if any) before overwriting.
    let mut backup_path: Option<PathBuf> = None;
    if path.exists() {
        let stamp = iso_now_compact();
        let bk = backup_dir.join(format!("settings-{}.json", stamp));
        fs::copy(path, &bk).map_err(|e| format!("backup copy: {}", e))?;
        backup_path = Some(bk);
    }

    // Pretty-print with 2-space indent for human readability when the user
    // edits the file directly later.
    let serialized =
        serde_json::to_string_pretty(&payload.content).map_err(|e| format!("serialize: {}", e))?;
    // Atomic-ish write via temp + rename.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename: {}", e))?;

    let new_size_bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok(SettingsSaveResult {
        success: true,
        backup_path: backup_path.map(|p| p.to_string_lossy().to_string()),
        new_size_bytes,
    })
}

// ---------------------------------------------------------------------------
// Autostart legacy artifact purge
// ---------------------------------------------------------------------------
//
// Background. The "Start with Windows" toggle in the General section uses
// `tauri-plugin-autostart` as the single source of truth. On Windows the
// plugin reads/writes a value under
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Run
// whose name is the app's productName ("ULTRON Control Center"). Its
// `isEnabled()` only inspects that registry value.
//
// Earlier builds of ULTRON (and at least one manual debug session during
// 2026-05-14) seeded a *different* autostart mechanism: a shortcut file
// inside the user's Startup folder named
//   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ULTRON Control Center.lnk
// pointing at the built `control-center.exe` with `--from-autostart`.
// Windows honours Startup folder entries independently of the Run key, so
// the app launched on every logon while the Settings toggle (which only
// looks at the registry) reported "off". Toggling the switch on/off in
// the UI did nothing to that .lnk, and the legacy shortcut survived.
//
// To make the toggle behave like a single source of truth we delete the
// rogue .lnk on every relevant Settings interaction. We also clear the
// dangling StartupApproved record for the same display name if the Run
// value itself is gone — keeping it would not re-enable autostart (Windows
// ignores approvals for absent entries) but it confuses Task Manager's
// Startup tab.

#[derive(Debug, Serialize, Clone)]
pub struct AutostartPurgeResult {
    /// Full path of every legacy artifact that existed and was removed.
    pub removed: Vec<String>,
    /// Non-fatal warnings (file existed but could not be deleted, etc).
    pub warnings: Vec<String>,
}

/// Remove legacy autostart artifacts that compete with the
/// `tauri-plugin-autostart` registry entry. Idempotent and safe to call
/// on every Settings mount and after every autostart toggle.
pub fn purge_legacy_autostart_inner() -> Result<AutostartPurgeResult, String> {
    let mut removed: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // --- 1. Startup folder .lnk -------------------------------------------
    // Resolve %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup. We
    // intentionally use the env var rather than SHGetKnownFolderPath so we
    // do not pull in winapi just for one path.
    if let Ok(appdata) = std::env::var("APPDATA") {
        let startup = PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup");
        // Match the legacy display name(s) we know about. Keep this list
        // narrow — we must never delete a shortcut the user installed for
        // an unrelated program.
        let candidates = ["ULTRON Control Center.lnk", "ULTRON.lnk"];
        for name in candidates {
            let p = startup.join(name);
            if p.exists() {
                match fs::remove_file(&p) {
                    Ok(_) => removed.push(p.to_string_lossy().into_owned()),
                    Err(e) => warnings.push(format!("delete {}: {}", p.display(), e)),
                }
            }
        }
    } else {
        warnings.push("APPDATA env var missing; skipped Startup folder scan".to_string());
    }

    // --- 2. Dangling StartupApproved\Run record ---------------------------
    // Only meaningful on Windows. We shell out to `reg.exe` rather than
    // pulling in `winreg` for a single one-shot delete — the binary ships
    // with every Windows install and the call is well-scoped.
    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW (0x08000000) prevents reg.exe from flashing a
        // console window. Without this flag, every Settings tab visit
        // re-spawned 2-3 visible terminals for ~10-50ms each — that was
        // the "flicker raro" the user reported.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let approved_path =
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
        let app_name = "ULTRON Control Center";

        // Check whether the Run value is absent (we should only clean
        // approvals that no longer correspond to a live Run entry — the
        // plugin's own value lives at the same name, so deleting it when
        // present would break the user's current preference).
        let run_present = std::process::Command::new("reg.exe")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                app_name,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !run_present {
            let approved_present = std::process::Command::new("reg.exe")
                .args(["query", approved_path, "/v", app_name])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if approved_present {
                let out = std::process::Command::new("reg.exe")
                    .args(["delete", approved_path, "/v", app_name, "/f"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                match out {
                    Ok(o) if o.status.success() => {
                        removed.push(format!("{}\\{}", approved_path, app_name));
                    }
                    Ok(o) => warnings.push(format!(
                        "reg delete StartupApproved: exit {} stderr={}",
                        o.status.code().unwrap_or(-1),
                        String::from_utf8_lossy(&o.stderr)
                    )),
                    Err(e) => warnings.push(format!("reg.exe spawn: {}", e)),
                }
            }
        }
    }

    Ok(AutostartPurgeResult { removed, warnings })
}

// LIB_RS_WIRING:
//   Register the new command in `src-tauri/src/lib.rs` so the frontend
//   can call it via `invoke("purge_legacy_autostart")`.
//
//   1. Add a Tauri command wrapper next to `settings_save` (around line 387):
//
//        #[tauri::command]
//        async fn purge_legacy_autostart() -> Result<settings::AutostartPurgeResult, String> {
//            settings::purge_legacy_autostart_inner()
//        }
//
//   2. Add `purge_legacy_autostart` to the `tauri::generate_handler![...]`
//      list (same list that already contains `settings_read` /
//      `settings_save`).
//
//   No other wiring is needed: the frontend Settings.tsx already calls
//   `invoke("purge_legacy_autostart")` on mount and after every toggle.

#[cfg(test)]
mod tests {
    use super::*;

    /// settings.json y carpeta de copias en un directorio temporal.
    fn fixture(initial: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        fs::write(&path, initial).expect("escribir settings.json");
        let backups = dir.path().join("backups");
        (dir, path, backups)
    }

    fn payload(content: serde_json::Value, expected_hash: &str) -> SettingsSavePayload {
        SettingsSavePayload {
            content,
            expected_hash: expected_hash.to_string(),
        }
    }

    #[test]
    fn guardar_con_la_huella_de_la_lectura_escribe() {
        let (_dir, path, backups) = fixture(r#"{"model":"a"}"#);
        let snap = read_snapshot_at(&path, &backups).expect("lectura");

        let res = save_at(
            &path,
            &backups,
            payload(serde_json::json!({"model":"b"}), &snap.content_hash),
        )
        .expect("el guardado con la huella vigente tiene que pasar");

        assert!(res.success);
        assert!(res.backup_path.is_some(), "deja copia del fichero anterior");
        let disco: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(disco, serde_json::json!({"model":"b"}));
    }

    // Caso negativo: el fichero cambió en disco tras la lectura (otra sesión
    // añadió un permiso). El guardado se rechaza con el error en español y no
    // escribe nada: ni el fichero ni la copia.
    #[test]
    fn guardar_con_una_huella_vieja_se_rechaza_y_no_escribe_nada() {
        let (_dir, path, backups) = fixture(r#"{"model":"a"}"#);
        let snap = read_snapshot_at(&path, &backups).expect("lectura");
        let ajeno = r#"{"model":"a","permissions":{"allow":["Bash(git:*)"]}}"#;
        fs::write(&path, ajeno).unwrap();

        let err = save_at(
            &path,
            &backups,
            payload(serde_json::json!({"model":"b"}), &snap.content_hash),
        )
        .expect_err("la foto vieja no puede pisar la edición ajena");

        assert_eq!(err, STALE_SETTINGS_ERROR);
        assert_eq!(fs::read_to_string(&path).unwrap(), ajeno);
        assert!(!backups.exists(), "el rechazo no deja copia");
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn la_huella_distingue_contenido_y_el_fichero_ausente() {
        assert_eq!(content_hash(b"{}"), content_hash(b"{}"));
        assert_ne!(content_hash(b"{}"), content_hash(b"{ }"));
        let dir = tempfile::tempdir().unwrap();
        let ausente = dir.path().join("settings.json");
        assert_eq!(disk_hash(&ausente).unwrap(), MISSING_FILE_HASH);
        // Guardar sobre un fichero ausente exige la huella de «ausente».
        let backups = dir.path().join("backups");
        assert!(save_at(&ausente, &backups, payload(serde_json::json!({}), "otra")).is_err());
        assert!(save_at(
            &ausente,
            &backups,
            payload(serde_json::json!({}), MISSING_FILE_HASH)
        )
        .is_ok());
    }
}
