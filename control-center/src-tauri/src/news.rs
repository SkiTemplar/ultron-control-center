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
///
/// Implementation note: we operate on the original `&str` via `char_indices`
/// so we never slice on a byte index that may fall mid-char (Spanish
/// newsletters routinely include á, é, ñ, etc.). Earlier versions sliced a
/// pre-lowercased `String` by raw byte position, which panicked on the
/// first non-ASCII char and dangled the Tauri promise.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut chars = html.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '<' {
            // Look-ahead for <script> / <style> blocks using a case-insensitive
            // ASCII match — both delimiters are pure-ASCII so we can compare
            // raw bytes safely.
            let remaining = &html[i..];
            if remaining.len() >= 7
                && remaining.as_bytes()[..7].eq_ignore_ascii_case(b"<script")
            {
                if let Some(end) = remaining.to_ascii_lowercase().find("</script>") {
                    let skip_to = i + end + "</script>".len();
                    while let Some(&(j, _)) = chars.peek() {
                        if j >= skip_to { break; }
                        chars.next();
                    }
                    continue;
                }
                break;
            }
            if remaining.len() >= 6
                && remaining.as_bytes()[..6].eq_ignore_ascii_case(b"<style")
            {
                if let Some(end) = remaining.to_ascii_lowercase().find("</style>") {
                    let skip_to = i + end + "</style>".len();
                    while let Some(&(j, _)) = chars.peek() {
                        if j >= skip_to { break; }
                        chars.next();
                    }
                    continue;
                }
                break;
            }
            // Generic tag — eat through `>`.
            for (_, ch) in chars.by_ref() {
                if ch == '>' { break; }
            }
            out.push(' ');
            continue;
        }
        out.push(c);
    }
    out.split_whitespace().collect::<Vec<&str>>().join(" ")
}

/// Pull <title>...</title> from the head if present, otherwise None.
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title>")?;
    let after = start + "<title>".len();
    let end = lower[after..].find("</title>").map(|e| after + e)?;
    Some(html[after..end].trim().to_string())
}

#[derive(Debug, Serialize, Clone)]
pub struct NewsGenerateResult {
    pub success: bool,
    pub path: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// Build the news-generation prompt + open a Gemini 3.1 session in wt.exe
/// with the prompt preloaded. Preferred flow: no headless Gemini
/// API call (the API mode kept failing), instead the script runs in
/// `--clipboard` mode (copies the full prompt to clipboard) and we spawn
/// an interactive Gemini wt.exe tab. The user pastes once and asks
/// Gemini to write the HTML to `~/.ultron/cockpit/news/newsletter-*.html`.
pub async fn generate_news_session_inner(
    app: &tauri::AppHandle,
    theme: Option<String>,
    days: Option<u32>,
) -> Result<NewsGenerateResult, String> {
    use tauri_plugin_shell::ShellExt;
    let script: PathBuf = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/news_html_generator.py");
    if !script.exists() {
        return Err(format!("script missing: {}", script.display()));
    }
    let script_str = script.to_string_lossy().to_string();

    // v15.2: respect the AI Router routing for the "news_generate" zone.
    // The provider is fixed to gemini (this whole pipeline is Gemini-only;
    // changing provider needs a different generator script) but the MODEL
    // dropdown is wired through end-to-end. If the user picks
    // gemini-3.1-flash for cheaper drafts, that's what we pass to both the
    // Python script and the wt.exe seed banner.
    let router_model = match crate::ai_router::read_ai_router_inner() {
        Ok(cfg) => cfg
            .zone("news_generate")
            .and_then(|z| z.model.clone())
            .filter(|m| !m.is_empty()),
        Err(_) => None,
    };
    let effective_model = router_model.unwrap_or_else(|| "gemini-3.1-pro-preview".to_string());

    // First step: build the prompt and copy to clipboard via the script's
    // --clipboard mode. No Gemini call happens here.
    let mut args: Vec<String> = vec![
        "run".into(),
        "python".into(),
        script_str,
        "--clipboard".into(),
    ];
    if let Some(d) = days {
        args.push("--days".into());
        args.push(d.clamp(1, 30).to_string());
    }
    if let Some(t) = theme.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if t.chars().any(|c| matches!(c, '\r' | '\n')) {
            return Err("theme contains line breaks".into());
        }
        args.push("--theme".into());
        args.push(t.to_string());
    }
    let str_args: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = app
        .shell()
        .command("uv")
        .args(str_args)
        .output()
        .await
        .map_err(|e| format!("spawn uv: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Second step: open an interactive Gemini session in wt.exe so the user
    // can paste the clipboard. The prompt header guides Gemini to write the
    // output HTML to a specific file path. We pass that hint via --prompt
    // so Gemini sees it before the clipboard paste.
    let today = {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0) as i64;
        let days = secs / 86_400;
        // Civil-from-days algorithm (Howard Hinnant), works for any positive day count.
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = if m <= 2 { y + 1 } else { y };
        format!("{:04}-{:02}-{:02}", year, m, d)
    };
    // v15.3.5: seed text migrated to the central button-prompts catalog
    // (key `news.generate_with_ai`) so the user can tune what Gemini sees
    // before pasting the clipboard. The template uses `{today}` and
    // `{model}` as vars. We fall back to the historical hardcoded string
    // when the catalog read fails so this code path never breaks the
    // newsletter flow on a fresh install (button-prompts.json missing).
    let seed = {
        let mut vars: std::collections::BTreeMap<String, String> =
            std::collections::BTreeMap::new();
        vars.insert("today".to_string(), today.clone());
        vars.insert("model".to_string(), effective_model.clone());
        crate::button_prompts::get_button_prompt_inner(
            "news.generate_with_ai".to_string(),
            vars,
        )
        .unwrap_or_else(|_| {
            format!(
                "El prompt completo está en tu portapapeles (pulsa Ctrl+V). Guarda el HTML final en ~/.ultron/cockpit/news/newsletter-{}.html y usa el modelo {}.",
                today, effective_model
            )
        })
    };
    // F1.8: pin Gemini to 3.1-pro explicitly. Without this the wt.exe tab
    // launches `gemini --yolo` (no -m) and falls back to whatever the user's
    // gemini CLI default model is (typically "auto"), which produces lower
    // quality newsletters than what the prompt header asks for.
    //
    // F10 fix: respect_clipboard=true so the spawn script does NOT overwrite
    // the clipboard. The Python step above already put the real (large)
    // prompt there via --clipboard; the `seed` we pass is just a short hint
    // shown as a banner in the new wt.exe tab.
    let gemini_flags = crate::sessions::SpawnFlags {
        model: Some(effective_model.clone()),
        respect_clipboard: true,
        ..Default::default()
    };
    let _spawn = crate::sessions::spawn_session_inner(
        app,
        "gemini".into(),
        Some(seed),
        None,
        Some(gemini_flags),
    )
    .await?;

    Ok(NewsGenerateResult {
        success: output.status.success(),
        path: None,
        stdout: format!("{}\n[gemini session spawned in wt.exe — paste clipboard there]", stdout.trim()),
        stderr,
        exit_code: output.status.code(),
    })
}

/// Run news_html_generator.py via uv. We invoke with --no-open so the
/// generator doesn't try to open the file in a browser — the UI handles
/// presentation. Optional `theme` flows through as --theme.
///
/// v15.2.1 (2026-05-16): redirect to the session+clipboard path. The
/// headless `gemini -p ...` subprocess hangs when OAuth cached token has
/// expired because the device-flow re-auth needs a TTY that Tauri does
/// not provide. The session path opens wt.exe interactively, refreshing
/// OAuth in-place. Costs the user one Ctrl+V; gains: it actually works.
pub async fn generate_news_inner(
    app: &tauri::AppHandle,
    theme: Option<String>,
    days: Option<u32>,
) -> Result<NewsGenerateResult, String> {
    return generate_news_session_inner(app, theme, days).await;
    // Headless body retained below (unreachable) for reference until the
    // next pass when we decide whether to drop it entirely.
    #[allow(unreachable_code)]
    {
    use tauri_plugin_shell::ShellExt;
    let script: PathBuf = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/news_html_generator.py");
    if !script.exists() {
        return Err(format!("script missing: {}", script.display()));
    }
    let script_str = script.to_string_lossy().to_string();
    // Gemini 3.1 is hard-pinned for the newsletter quality. We
    // always pass --model even if the script's DEFAULT_MODEL already matches
    // so the choice is visible in the audit trail.
    let mut args: Vec<String> = vec![
        "run".into(),
        "python".into(),
        script_str,
        "--no-open".into(),
        "--model".into(),
        "gemini-3.1-pro-preview".into(),
    ];
    if let Some(d) = days {
        args.push("--days".into());
        args.push(d.clamp(1, 30).to_string());
    }
    if let Some(t) = theme.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // Reject control characters so we don't smuggle CR/LF into argv.
        if t.chars().any(|c| matches!(c, '\r' | '\n')) {
            return Err("theme contains line breaks".into());
        }
        args.push("--theme".into());
        args.push(t.to_string());
    }
    let str_args: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = app
        .shell()
        .command("uv")
        .args(str_args)
        .output()
        .await
        .map_err(|e| format!("spawn uv: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // The generator prints `[news_html_generator] wrote <path>` on success.
    // Scrape that path so the UI can scroll to / open the new entry.
    let written = stdout
        .lines()
        .chain(stderr.lines())
        .find_map(|line| {
            line.strip_prefix("[news_html_generator] wrote ")
                .or_else(|| line.split("wrote ").nth(1))
                .map(|s| s.trim().to_string())
        });

    Ok(NewsGenerateResult {
        success: output.status.success(),
        path: written,
        stdout,
        stderr,
        exit_code: output.status.code(),
    })
    } // end unreachable block
}

/// Build a concise AI summary of a newsletter HTML. We strip the HTML
/// locally so the LLM call gets prose only (no inline CSS / scripts), then
/// route through `sessions::run_inline_inner` with provider=codex. Codex
/// is much cheaper than Claude for short throw-away summaries; the user
/// asked specifically to keep Claude tokens for interactive work.
pub async fn summarize_news_inner(
    app: &tauri::AppHandle,
    path_str: String,
) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path_str);
    let dir = news_dir().ok_or_else(|| "no HOME".to_string())?;
    let canon_p = std::fs::canonicalize(&p).map_err(|e| format!("canonicalize: {}", e))?;
    let canon_dir = std::fs::canonicalize(&dir).map_err(|e| format!("canonicalize dir: {}", e))?;
    if !canon_p.starts_with(&canon_dir) {
        return Err("path is not inside the news directory".into());
    }
    if canon_p.extension().and_then(|e| e.to_str()) != Some("html") {
        return Err("only .html newsletters can be summarised".into());
    }
    let raw = fs::read_to_string(&canon_p).map_err(|e| format!("read: {}", e))?;
    // Cap to ~200K chars (newsletters with Spanish accents have multi-byte
    // chars; slicing by byte index would panic at non-char boundaries).
    let bounded_owned: String = if raw.chars().count() > 200_000 {
        raw.chars().take(200_000).collect()
    } else {
        raw
    };
    let bounded = bounded_owned.as_str();
    let title = extract_title(bounded).unwrap_or_else(|| {
        canon_p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Newsletter")
            .to_string()
    });
    let mut plain = strip_tags(bounded);
    if plain.chars().count() > 6_000 {
        plain = plain.chars().take(6_000).collect();
    }
    let prompt = format!(
        "Resume esta newsletter en máximo 6 bullets en español, una línea cada uno, con la idea principal sin adornos. Después añade una línea final con la conclusión más relevante en una frase. No incluyas el título ni la fecha en la salida.\n\nTítulo: {}\n\nContenido:\n{}",
        title, plain
    );

    // Route via spawn_session_inner so we hit the clipboard path (the
    // newsletter body contains `⌬`, em-dashes and `'` which Codex's
    // .cmd shim rejects as "unexpected argument <body>" when passed
    // inline). spawn_session_inner copies the prompt to clipboard for
    // any payload with newlines or >1200 chars.
    //
    // v15.2 AI Router: the "summarize" zone decides BOTH provider and
    // model. Default zone provider is codex (cheap for throwaway
    // summaries), but the user can pick claude/gemini from the
    // Settings → AI Router UI and the model dropdown propagates through
    // SpawnFlags.model. On any router error we fall back to the old
    // hardcoded "codex" default so this call site never silently breaks.
    let (provider, model) = match crate::ai_router::read_ai_router_inner() {
        Ok(cfg) => cfg
            .zone("summarize")
            .map(|z| (z.provider.clone(), z.model.clone().filter(|m| !m.is_empty())))
            .unwrap_or_else(|| ("codex".to_string(), None)),
        Err(_) => ("codex".to_string(), None),
    };
    let flags = crate::sessions::SpawnFlags {
        model,
        ..Default::default()
    };
    crate::sessions::spawn_session_inner(app, provider.clone(), Some(prompt), None, Some(flags))
        .await
        .map_err(|e| e)?;
    Ok(format!(
        "Sesion {} abierta en wt.exe. El prompt (newsletter strip + instruccion) esta en tu clipboard; pulsa Ctrl+V alli.",
        provider
    ))
}

/// Read the full HTML body of a newsletter for inline rendering in the
/// webview. Strict: only `.html` files inside the news directory are
/// accepted (same canonicalize-then-starts_with check used by delete).
///
/// We cap the payload at 500 KB so a runaway file can't lock the webview
/// when the iframe parses it. Newsletters in production sit around 80 KB
/// (CSS inline + base64 image stubs), so 500 KB leaves generous headroom.
pub fn read_news_html_inner(path_str: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 500 * 1024;
    let p = std::path::PathBuf::from(&path_str);
    let dir = news_dir().ok_or_else(|| "no HOME".to_string())?;
    let canon_p = std::fs::canonicalize(&p).map_err(|e| format!("canonicalize: {}", e))?;
    let canon_dir = std::fs::canonicalize(&dir).map_err(|e| format!("canonicalize dir: {}", e))?;
    if !canon_p.starts_with(&canon_dir) {
        return Err("path is not inside the news directory".into());
    }
    if canon_p.extension().and_then(|e| e.to_str()) != Some("html") {
        return Err("only .html newsletters can be rendered".into());
    }
    let meta = fs::metadata(&canon_p).map_err(|e| format!("stat: {}", e))?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "newsletter is {} bytes (>{}); open in browser instead",
            meta.len(),
            MAX_BYTES
        ));
    }
    fs::read_to_string(&canon_p).map_err(|e| format!("read: {}", e))
}

/// Delete a single newsletter HTML file. Strict: only files inside the news
/// directory with a .html extension are accepted.
pub fn delete_news_inner(path_str: String) -> Result<bool, String> {
    let p = std::path::PathBuf::from(&path_str);
    let dir = news_dir().ok_or_else(|| "no HOME".to_string())?;
    let canon_p = std::fs::canonicalize(&p).map_err(|e| format!("canonicalize: {}", e))?;
    let canon_dir = std::fs::canonicalize(&dir).map_err(|e| format!("canonicalize dir: {}", e))?;
    if !canon_p.starts_with(&canon_dir) {
        return Err("path is not inside the news directory".into());
    }
    if canon_p.extension().and_then(|e| e.to_str()) != Some("html") {
        return Err("only .html newsletters can be deleted from here".into());
    }
    std::fs::remove_file(&canon_p).map_err(|e| format!("remove: {}", e))?;
    Ok(true)
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

        // Read at most ~200K chars for excerpt extraction — newsletters are
        // typically <80K chars; capping protects us from a runaway file.
        // Char-aware truncation so Spanish accents don't crash the slice.
        let raw = fs::read_to_string(&p).unwrap_or_default();
        let truncated = if raw.chars().count() > 200_000 {
            raw.chars().take(200_000).collect()
        } else {
            raw
        };
        let title = extract_title(&truncated);
        let excerpt = {
            let plain = strip_tags(&truncated);
            if plain.is_empty() {
                None
            } else if plain.chars().count() > 280 {
                // Char-aware truncation to avoid splitting Spanish accents.
                let cut: String = plain.chars().take(280).collect();
                Some(format!("{}…", cut.trim_end()))
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
