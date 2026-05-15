// ULTRON Control Center — News (newsletter) discovery module.
//
// Surfaces the HTML newsletters produced by the news pipeline. We never
// render the HTML inside Tauri's webview to avoid exposing arbitrary
// scripts — the UI shows metadata + an "Open in browser" button.

use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct NewsEntry {
    pub filename: String,
    pub path: String,
    pub generated_at: Option<String>,
    pub size_bytes: u64,
    pub title: Option<String>,
    pub excerpt: Option<String>,
}

fn news_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/cockpit/news"))
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
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month + 1, days + 1, h, m, s
    )
}

/// Strip HTML tags and collapse whitespace to extract a readable excerpt.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut in_script = false;
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        let c = bytes[i] as char;
        if !in_tag && c == '<' {
            // Detect <script> and <style> blocks — skip everything until close.
            if lower[i..].starts_with("<script") {
                if let Some(end) = lower[i..].find("</script>") {
                    i += end + "</script>".len();
                    in_script = false;
                    continue;
                } else {
                    break;
                }
            }
            if lower[i..].starts_with("<style") {
                if let Some(end) = lower[i..].find("</style>") {
                    i += end + "</style>".len();
                    continue;
                } else {
                    break;
                }
            }
            in_tag = true;
            i += 1;
            continue;
        }
        if in_tag {
            if c == '>' {
                in_tag = false;
                out.push(' ');
            }
            i += 1;
            continue;
        }
        if !in_script {
            out.push(c);
        }
        i += 1;
    }
    let collapsed: String = out
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    collapsed
}

/// Pull <title>...</title> from the head if present, otherwise None.
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title>")?;
    let after = start + "<title>".len();
    let end = lower[after..].find("</title>").map(|e| after + e)?;
    Some(html[after..end].trim().to_string())
}

pub fn list_news_inner() -> Result<Vec<NewsEntry>, String> {
    let dir = news_dir().ok_or_else(|| "no HOME".to_string())?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let rd = fs::read_dir(&dir).map_err(|e| format!("readdir: {}", e))?;
    let mut entries: Vec<NewsEntry> = Vec::new();
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("html") {
            continue;
        }
        let filename = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let Ok(meta) = entry.metadata() else { continue };
        let size_bytes = meta.len();
        let generated_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| iso_pretty(d.as_secs()));

        // Read at most 200 KB for excerpt extraction — newsletters are
        // typically <80 KB; capping protects us from a runaway file.
        let raw = fs::read_to_string(&p).unwrap_or_default();
        let truncated = if raw.len() > 200_000 {
            raw[..200_000].to_string()
        } else {
            raw
        };
        let title = extract_title(&truncated);
        let excerpt = {
            let plain = strip_tags(&truncated);
            if plain.len() > 280 {
                Some(format!("{}…", plain[..280].trim_end()))
            } else if plain.is_empty() {
                None
            } else {
                Some(plain)
            }
        };

        entries.push(NewsEntry {
            filename,
            path: p.to_string_lossy().to_string(),
            generated_at,
            size_bytes,
            title,
            excerpt,
        });
    }
    // Newest first by name (newsletter-YYYY-MM-DD lex-sorts correctly).
    entries.sort_by(|a, b| b.filename.cmp(&a.filename));
    Ok(entries)
}
