// installed_apps/bloatware.rs — Appx/bloatware query and removal commands.
//
// Curated bloatware list lives in the frontend (System.tsx). The frontend
// asks the backend to query whether a package is installed (so the UI can
// render an accurate "Installed" / "Already removed" / "Protected" state)
// and to remove a package by Appx package family name pattern.
//
// Security:
//   - We accept only Appx package family name patterns. Anything containing
//     characters outside [A-Za-z0-9._*-] is rejected.
//   - The pattern is embedded in PowerShell as a single-quoted literal,
//     with `'` doubled. No interpolation, no $().
//   - A small allowlist of "protected" Microsoft packages (Edge, Defender,
//     security center) is refused server-side as belt-and-suspenders: even
//     if the frontend somehow let the user click Uninstall, we won't run
//     Remove-AppxPackage on these.

use super::types::{AppxQueryResult, BloatwareUninstallResult};

/// True when `pattern` only contains characters that are valid in an Appx
/// package family name plus the `*` wildcard. We're paranoid here because
/// the pattern is then embedded in a PS single-quoted literal.
#[cfg(target_os = "windows")]
pub(super) fn is_valid_appx_pattern(pattern: &str) -> bool {
    if pattern.is_empty() || pattern.len() > 128 {
        return false;
    }
    pattern
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '*'))
}

/// Packages we refuse to uninstall server-side even if the frontend asks —
/// Windows guards these with TrustedInstaller, but the explicit refusal
/// keeps us honest. The frontend already badges them as "Protected".
#[cfg(target_os = "windows")]
const APPX_PROTECTED_PATTERNS: &[&str] = &[
    "Microsoft.MicrosoftEdge*",
    "Microsoft.Edge*",
    "Microsoft.WindowsDefender*",
    "Microsoft.SecHealthUI*",
    "Microsoft.Windows.SecHealthUI*",
];

#[cfg(target_os = "windows")]
pub async fn appx_query_inner(
    app: &tauri::AppHandle,
    pattern: String,
) -> Result<AppxQueryResult, String> {
    use super::ps_util::{ps_single_quote_escape, run_ps_command};

    if !is_valid_appx_pattern(&pattern) {
        return Err(format!("invalid Appx pattern '{}'", pattern));
    }
    let pattern_safe = ps_single_quote_escape(&pattern);
    // -AllUsers is intentionally NOT used (it requires elevation). We query
    // only the current user's appx packages — same scope used by the
    // uninstall command below.
    let command = format!(
        "Get-AppxPackage -Name '{}' -ErrorAction SilentlyContinue | \
         Select-Object -ExpandProperty PackageFullName",
        pattern_safe
    );
    let (stdout, _stderr, _code, _ok) = run_ps_command(app, &command).await?;
    let matches: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(AppxQueryResult {
        installed: !matches.is_empty(),
        matches,
    })
}

#[cfg(not(target_os = "windows"))]
pub async fn appx_query_inner(
    _app: &tauri::AppHandle,
    _pattern: String,
) -> Result<AppxQueryResult, String> {
    Ok(AppxQueryResult {
        installed: false,
        matches: Vec::new(),
    })
}

#[cfg(target_os = "windows")]
pub async fn uninstall_bloatware_app_inner(
    app: &tauri::AppHandle,
    pattern: String,
) -> Result<BloatwareUninstallResult, String> {
    use super::cache::cache_path;
    use super::ps_util::{ps_single_quote_escape, run_ps_command};

    if !is_valid_appx_pattern(&pattern) {
        return Err(format!("invalid Appx pattern '{}'", pattern));
    }
    // Server-side allowlist: refuse the small set of protected MS packages.
    let pattern_lower = pattern.to_ascii_lowercase();
    for protected in APPX_PROTECTED_PATTERNS {
        if protected.eq_ignore_ascii_case(&pattern) {
            return Err(format!(
                "'{}' is protected by Windows and cannot be removed from here",
                pattern
            ));
        }
        // Also refuse if user passes a strict prefix of a protected pattern.
        let stripped = protected.trim_end_matches('*').to_ascii_lowercase();
        if !stripped.is_empty() && pattern_lower == stripped {
            return Err(format!(
                "'{}' is protected by Windows and cannot be removed from here",
                pattern
            ));
        }
    }
    let pattern_safe = ps_single_quote_escape(&pattern);
    // Two-step: capture matched PackageFullNames first so we can report what
    // we removed (and exit cleanly when nothing matched). Then pipe to
    // Remove-AppxPackage. Suppress errors so a stale provisioned-package
    // entry doesn't tank the whole pipeline.
    let command = format!(
        "$pkgs = Get-AppxPackage -Name '{p}' -ErrorAction SilentlyContinue; \
         if (-not $pkgs) {{ Write-Output 'NO_MATCH'; exit 0 }}; \
         foreach ($pkg in $pkgs) {{ \
            Write-Output (\"REMOVE: \" + $pkg.PackageFullName); \
            try {{ Remove-AppxPackage -Package $pkg.PackageFullName -ErrorAction Stop }} \
            catch {{ Write-Output (\"FAIL: \" + $_.Exception.Message); }} \
         }}",
        p = pattern_safe
    );
    let (stdout, stderr, code, ok) = run_ps_command(app, &command).await?;
    // Best-effort parse of the REMOVE: lines for the UI.
    let removed: Vec<String> = stdout
        .lines()
        .filter_map(|l| l.trim().strip_prefix("REMOVE: "))
        .map(|s| s.trim().to_string())
        .collect();
    // Invalidate the installed-apps cache too — some bloatware shows up in
    // the Apps inventory and the user shouldn't see stale rows.
    let _ = std::fs::remove_file(cache_path().unwrap_or_default());
    Ok(BloatwareUninstallResult {
        success: ok,
        stdout,
        stderr,
        exit_code: code,
        command,
        removed,
    })
}

#[cfg(not(target_os = "windows"))]
pub async fn uninstall_bloatware_app_inner(
    _app: &tauri::AppHandle,
    _pattern: String,
) -> Result<BloatwareUninstallResult, String> {
    Err("uninstall_bloatware_app is not supported on this platform".to_string())
}
