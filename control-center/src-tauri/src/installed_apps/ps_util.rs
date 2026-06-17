// installed_apps/ps_util.rs — PowerShell execution helpers and date utility.

#[cfg(target_os = "windows")]
use tauri_plugin_shell::ShellExt;

/// Formats the current UTC instant as an ISO-8601 string without depending
/// on external crates (e.g. `chrono`). Precision is seconds.
pub(super) fn iso_now_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
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

/// Runs a PowerShell snippet via `powershell.exe -NoProfile -NonInteractive
/// -ExecutionPolicy Bypass -Command <cmd>`. Returns (stdout, stderr,
/// exit_code, success).
#[cfg(target_os = "windows")]
pub(super) async fn run_ps_command(
    app: &tauri::AppHandle,
    command: &str,
) -> Result<(String, String, Option<i32>, bool), String> {
    let output = app
        .shell()
        .command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-OutputFormat",
            "Text",
            "-Command",
            command,
        ])
        .output()
        .await
        .map_err(|e| format!("spawn powershell: {}", e))?;
    Ok((
        decode_ps_stdout(&output.stdout),
        decode_ps_stdout(&output.stderr),
        output.status.code(),
        output.status.success(),
    ))
}

/// v15.4.13 — Windows PowerShell 5.1 emits stdout as UTF-16 LE by default
/// (the console codepage). Decoding the bytes as UTF-8 produces mojibake
/// for any non-ASCII character — that's why the Apps panel showed
/// "Aplicaci\u{00f3}n" instead of "Aplicación" and the Folder button
/// failed to resolve the path. We sniff the BOM and pick the right
/// decoder: UTF-16 LE BOM → from_utf16_lossy; UTF-8 BOM → strip + utf8;
/// no BOM → assume UTF-8 (CI / unit tests / PS 7 with explicit
/// `[Console]::OutputEncoding = UTF8` fall here).
#[cfg(target_os = "windows")]
pub(super) fn decode_ps_stdout(bytes: &[u8]) -> String {
    // UTF-16 LE BOM (FF FE)
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let pairs: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&pairs);
    }
    // UTF-8 BOM (EF BB BF)
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        return String::from_utf8_lossy(&bytes[3..]).to_string();
    }
    String::from_utf8_lossy(bytes).to_string()
}

/// Escapes a string for embedding inside a PowerShell single-quoted
/// literal. The only character we have to worry about is `'` itself,
/// which doubles. Everything else (including $, `, etc.) is literal
/// inside single quotes. PS does NOT process backslash escapes.
#[cfg(target_os = "windows")]
pub(super) fn ps_single_quote_escape(s: &str) -> String {
    s.replace('\'', "''")
}
