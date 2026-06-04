// ULTRON Control Center — Auth status module.
//
// Detects whether the three CLI peers (Claude, Codex, Gemini) are logged in
// by checking for known credential files on disk. We never read or expose
// token material — only `exists`, file size, and last-modified time. The
// UI uses this to surface "logged in" / "expired" / "not configured" hints
// without forcing the user to spawn each CLI.

use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct AuthStatusEntry {
    pub provider: String,
    pub logged_in: bool,
    pub credential_path: String,
    pub last_modified: Option<String>,
    pub age_days: Option<i64>,
    pub binary_present: bool,
    pub binary_path: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AuthStatusReport {
    pub entries: Vec<AuthStatusEntry>,
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

fn modified_info(path: &PathBuf) -> (Option<String>, Option<i64>) {
    let Ok(meta) = fs::metadata(path) else {
        return (None, None);
    };
    let Ok(mt) = meta.modified() else {
        return (None, None);
    };
    let Ok(d) = mt.duration_since(std::time::UNIX_EPOCH) else {
        return (None, None);
    };
    let iso = iso_pretty(d.as_secs());
    let elapsed = SystemTime::now()
        .duration_since(mt)
        .map(|e| (e.as_secs() / 86_400) as i64)
        .ok();
    (Some(iso), elapsed)
}

/// Locate a binary by name across the well-known install locations. We do
/// not invoke any binary — just look for the file. This keeps the call
/// instant and side-effect free.
fn binary_path(name: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let candidates = match name {
        "claude" => vec![
            home.join(".local/bin/claude.exe"),
            home.join(".local/bin/claude"),
            home.join("AppData/Roaming/npm/claude.cmd"),
        ],
        "codex" => vec![
            home.join("AppData/Roaming/npm/codex.cmd"),
            home.join("AppData/Roaming/npm/codex"),
            home.join(".local/bin/codex.exe"),
        ],
        "gemini" => vec![
            home.join("AppData/Roaming/npm/gemini.cmd"),
            home.join("AppData/Roaming/npm/gemini"),
            home.join(".local/bin/gemini.exe"),
        ],
        _ => return None,
    };
    candidates.into_iter().find(|p| p.exists())
}

fn check_provider(provider: &str) -> AuthStatusEntry {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            return AuthStatusEntry {
                provider: provider.to_string(),
                logged_in: false,
                credential_path: String::new(),
                last_modified: None,
                age_days: None,
                binary_present: false,
                binary_path: None,
                note: Some("HOME not resolvable".to_string()),
            };
        }
    };

    let credential_path = match provider {
        "claude" => home.join(".claude/.credentials.json"),
        "codex" => home.join(".codex/auth.json"),
        "gemini" => home.join(".gemini/oauth_creds.json"),
        _ => home.clone(),
    };

    let logged_in = credential_path.exists();
    let (last_modified, age_days) = if logged_in {
        modified_info(&credential_path)
    } else {
        (None, None)
    };
    let bin = binary_path(provider);
    let note = if !logged_in {
        Some(match provider {
            "claude" => "Run `claude /login` (interactive session) to authenticate.".to_string(),
            "codex" => "Run `codex login` in a terminal to authenticate.".to_string(),
            "gemini" => "Run `gemini auth login` in a terminal to authenticate.".to_string(),
            _ => "Unknown provider".to_string(),
        })
    } else if age_days.map(|d| d > 60).unwrap_or(false) {
        Some(format!(
            "Credentials are {} days old — consider re-authenticating.",
            age_days.unwrap_or(0)
        ))
    } else {
        None
    };

    AuthStatusEntry {
        provider: provider.to_string(),
        logged_in,
        credential_path: credential_path.to_string_lossy().to_string(),
        last_modified,
        age_days,
        binary_present: bin.is_some(),
        binary_path: bin.map(|p| p.to_string_lossy().to_string()),
        note,
    }
}

pub fn auth_status_inner() -> AuthStatusReport {
    AuthStatusReport {
        entries: vec![
            check_provider("claude"),
            check_provider("codex"),
            check_provider("gemini"),
        ],
    }
}
