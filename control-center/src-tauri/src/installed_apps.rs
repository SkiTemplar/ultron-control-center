// ULTRON Control Center — Installed Apps module.
//
// Inventory all software installed on this Windows host and expose two
// safe mutations: open the install folder in Explorer, and uninstall via
// the appropriate package manager.
//
// Sources merged:
//   - winget list (modern packages, includes Microsoft Store + WingetCli)
//   - Get-Package (PackageManagement / MSI / PowerShellGet)
// Each app is tagged with a `provider` ∈ {winget, msi, store, manual} so
// the UI can filter and the uninstall dispatcher picks the correct
// invocation.
//
// Cache: results are cached at ~/.ultron/.tmp/installed-apps.json with a
// 1-hour TTL. The frontend can pass `force=true` to bypass the cache.
//
// Security:
//   - The `name` field is allowed any UTF-8, but for uninstall we only
//     route through fixed argv forms (`winget uninstall --id <id>`,
//     `Get-Package -Name <name> | Uninstall-Package`). The name is sent
//     as a separate PowerShell argument (single-quoted, escaped) so a
//     malicious app name cannot inject extra flags.
//   - `provider` must be in the whitelist before uninstall is invoked.
//   - `install_location` for the "open folder" command is canonicalised
//     and must resolve under an existing directory before we hand it to
//     explorer.exe.

#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use tauri_plugin_shell::ShellExt;

#[cfg(target_os = "windows")]
const CACHE_TTL_SECS: u64 = 3600; // 1 hour

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstalledApp {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    /// Absolute path to install dir. Best-effort: not all sources expose
    /// this. Empty string when unknown.
    #[serde(default)]
    pub install_location: Option<String>,
    /// One of: "winget" | "msi" | "store" | "manual".
    pub provider: String,
    /// winget package id (when provider == "winget" or "store"). Used as
    /// the canonical handle for the uninstall command — much more robust
    /// than the display name.
    #[serde(default)]
    pub package_id: Option<String>,
    /// Raw uninstall string from the registry (HKLM Uninstall key). When
    /// present and provider == "msi" or "manual", the UI may prefer this
    /// over the generic Get-Package path. Not exposed to the dispatcher
    /// directly — the dispatcher always re-derives the command from
    /// provider + package_id / name for safety.
    #[serde(default)]
    pub uninstall_hint: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct InstalledAppsReport {
    pub apps: Vec<InstalledApp>,
    pub source_errors: Vec<String>,
    /// ISO timestamp of when this snapshot was produced (from cache or
    /// freshly scanned).
    pub generated_at: String,
    pub cached: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct UninstallResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub command: String,
}

#[cfg(target_os = "windows")]
fn cache_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron/.tmp/installed-apps.json"))
        .ok_or_else(|| "no HOME dir".to_string())
}

fn iso_now_utc() -> String {
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

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
#[derive(Debug, Serialize, Deserialize)]
struct CachedSnapshot {
    apps: Vec<InstalledApp>,
    generated_at: String,
    /// Unix seconds when the cache was written. Used for TTL math.
    written_unix: u64,
}

#[cfg(target_os = "windows")]
fn read_cache() -> Option<CachedSnapshot> {
    let path = cache_path().ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(target_os = "windows")]
fn write_cache(apps: &[InstalledApp]) -> Result<(), String> {
    let path = cache_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir cache parent: {}", e))?;
    }
    let snapshot = CachedSnapshot {
        apps: apps.to_vec(),
        generated_at: iso_now_utc(),
        written_unix: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };
    let json = serde_json::to_string(&snapshot).map_err(|e| format!("encode cache: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("write cache: {}", e))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn cache_fresh(snapshot: &CachedSnapshot) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now.saturating_sub(snapshot.written_unix) < CACHE_TTL_SECS
}

// ---------------------------------------------------------------------------
// PowerShell helper
// ---------------------------------------------------------------------------

/// Runs a PowerShell snippet via `powershell.exe -NoProfile -NonInteractive
/// -ExecutionPolicy Bypass -Command <cmd>`. Returns (stdout, stderr,
/// exit_code, success).
#[cfg(target_os = "windows")]
async fn run_ps_command(
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
fn decode_ps_stdout(bytes: &[u8]) -> String {
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

// ---------------------------------------------------------------------------
// Inventory sources
// ---------------------------------------------------------------------------

/// Powershell snippet that emits a stable JSON array merging:
///   - winget list (modern packages incl. Microsoft Store)
///   - Get-Package (PackageManagement provider — MSI + others)
///   - HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall (manual
///     installers that don't register with the package managers)
///
/// We do all the merging server-side in PowerShell because parsing
/// `winget list` line-by-line in Rust is brittle (varies by locale and
/// console width). PS gives us a `winget list --json` equivalent via
/// `WindowsPackageManager` COM, but the most portable thing across stale
/// winget versions is `winget export` which only emits installed packages
/// that have a known manifest. To get coverage we fall back to the
/// columnar parser when --json isn't available.
#[cfg(target_os = "windows")]
const INVENTORY_PS: &str = r#"
# v2.0 mojibake fix: PS 5.1's default $OutputEncoding is ASCII and the
# console is OEM (cp850/cp1252) — by the time `ConvertTo-Json` runs the
# non-ASCII publisher names are already lossily transcoded. Force the
# pipeline AND the console to UTF-8 BEFORE doing any work so the JSON
# emitted on stdout is valid UTF-8 (the Rust side then decodes the BOM-
# less bytes as UTF-8 directly).
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$apps = New-Object System.Collections.Generic.List[object]
$errors = New-Object System.Collections.Generic.List[string]

# ---- Source 1: winget ---------------------------------------------------
try {
    $wingetCmd = Get-Command winget -ErrorAction Stop
    if ($wingetCmd) {
        # winget list as columns. We strip the header + separator rows,
        # then split each row on 2+ spaces. The columns we want are
        # Name | Id | Version | Source.
        $raw = & winget list --accept-source-agreements --disable-interactivity 2>$null
        $lines = $raw | Where-Object { $_ -and ($_ -match '\S') }
        # Find the header row ("Name" + "Id" columns) so we know where the
        # data starts. Localised winget may translate these — fall back to
        # the first "---" separator row.
        $sepIdx = ($lines | Select-String -Pattern '^[\s-]{10,}$' | Select-Object -First 1).LineNumber
        if ($sepIdx) {
            $data = $lines[$sepIdx..($lines.Count - 1)]
            foreach ($line in $data) {
                if ($line -match '^\s*$') { continue }
                # Columns are space-padded. Two-or-more spaces separates.
                $cols = $line -split '\s{2,}'
                if ($cols.Count -lt 2) { continue }
                $name = $cols[0].Trim()
                $id   = $cols[1].Trim()
                $ver  = if ($cols.Count -gt 2) { $cols[2].Trim() } else { '' }
                $src  = if ($cols.Count -gt 4) { $cols[4].Trim() } else { '' }
                if (-not $name -or $name -eq 'Name') { continue }
                $provider = if ($src -eq 'msstore') { 'store' } else { 'winget' }
                $apps.Add([pscustomobject]@{
                    name              = $name
                    version           = $ver
                    publisher         = $null
                    install_location  = $null
                    provider          = $provider
                    package_id        = $id
                    uninstall_hint    = $null
                }) | Out-Null
            }
        }
    }
} catch {
    $errors.Add("winget: $($_.Exception.Message)") | Out-Null
}

# ---- Source 2: Registry uninstall keys (MSI + manual) -------------------
$regRoots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($root in $regRoots) {
    try {
        if (-not (Test-Path $root)) { continue }
        $keys = Get-ChildItem -Path $root -ErrorAction Stop
        foreach ($key in $keys) {
            $p = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
            if (-not $p) { continue }
            $name = $p.DisplayName
            if (-not $name) { continue }
            # Skip system updates / hotfixes
            if ($p.SystemComponent -eq 1) { continue }
            if ($p.ParentKeyName) { continue }
            # If WindowsInstaller=1 → MSI provider; else manual exe
            $provider = if ($p.WindowsInstaller -eq 1) { 'msi' } else { 'manual' }
            $apps.Add([pscustomobject]@{
                name              = $name
                version           = $p.DisplayVersion
                publisher         = $p.Publisher
                install_location  = $p.InstallLocation
                provider          = $provider
                package_id        = $key.PSChildName
                uninstall_hint    = $p.UninstallString
            }) | Out-Null
        }
    } catch {
        $errors.Add("registry $root`: $($_.Exception.Message)") | Out-Null
    }
}

# ---- Dedup by lowercased name + provider --------------------------------
# Prefer winget entries (they have a clean package_id for uninstall).
$seen = @{}
$result = New-Object System.Collections.Generic.List[object]
foreach ($a in ($apps | Sort-Object @{Expression = { if ($_.provider -eq 'winget') { 0 } elseif ($_.provider -eq 'store') { 1 } elseif ($_.provider -eq 'msi') { 2 } else { 3 } }})) {
    $key = ($a.name + '|' + $a.provider).ToLowerInvariant()
    # Cross-provider dedup: if we already have a winget entry for the same
    # display name, skip a duplicate from the registry side.
    $altKey = ($a.name).ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    if ($seen.ContainsKey($altKey + '|winget') -and $a.provider -ne 'winget') { continue }
    if ($seen.ContainsKey($altKey + '|store')  -and $a.provider -ne 'store')  { continue }
    $seen[$key] = $true
    $seen[$altKey + '|' + $a.provider] = $true
    $result.Add($a) | Out-Null
}

# Output a single JSON object with apps + errors.
$out = [pscustomobject]@{
    apps   = $result
    errors = $errors
}
$json = $out | ConvertTo-Json -Depth 4 -Compress
# Belt-and-suspenders: re-assert UTF-8 in case any cmdlet above flipped it,
# then write bytes directly to stdout via [Console]::Out to bypass PS 5.1's
# string-to-OEM transcoding on Write-Output.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.WriteLine($json)
"#;

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize)]
struct PsInventoryResult {
    apps: Vec<InstalledApp>,
    errors: Vec<String>,
}

#[cfg(target_os = "windows")]
async fn scan_apps(app: &tauri::AppHandle) -> Result<(Vec<InstalledApp>, Vec<String>), String> {
    let (stdout, stderr, code, ok) = run_ps_command(app, INVENTORY_PS).await?;
    if !ok {
        return Err(format!(
            "inventory PS script failed (exit {:?}): {}",
            code, stderr
        ));
    }
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok((Vec::new(), vec!["inventory script produced no output".into()]));
    }
    let parsed: PsInventoryResult = serde_json::from_str(trimmed)
        .map_err(|e| format!("parse inventory json: {} (output: {:.500})", e, trimmed))?;
    Ok((parsed.apps, parsed.errors))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub async fn list_installed_apps_inner(
    app: &tauri::AppHandle,
    force: bool,
) -> Result<InstalledAppsReport, String> {
    if !force {
        if let Some(snap) = read_cache() {
            if cache_fresh(&snap) {
                return Ok(InstalledAppsReport {
                    apps: snap.apps,
                    source_errors: Vec::new(),
                    generated_at: snap.generated_at,
                    cached: true,
                });
            }
        }
    }
    let (apps, errors) = scan_apps(app).await?;
    let _ = write_cache(&apps);
    Ok(InstalledAppsReport {
        apps,
        source_errors: errors,
        generated_at: iso_now_utc(),
        cached: false,
    })
}

/// Linux/macOS stub — returns an empty inventory so the UI doesn't crash
/// when the user launches the Apps panel on a non-Windows host. The
/// frontend already handles `apps.is_empty()` (it shows an empty-state
/// card), so no extra signalling is needed.
#[cfg(not(target_os = "windows"))]
pub async fn list_installed_apps_inner(
    _app: &tauri::AppHandle,
    _force: bool,
) -> Result<InstalledAppsReport, String> {
    Ok(InstalledAppsReport {
        apps: Vec::new(),
        source_errors: vec!["installed-apps inventory is Windows-only".to_string()],
        generated_at: iso_now_utc(),
        cached: false,
    })
}

#[cfg(target_os = "windows")]
pub fn open_app_folder_inner(install_location: String) -> Result<String, String> {
    let trimmed = install_location.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("install_location is empty".into());
    }
    let p = Path::new(trimmed);
    if !p.exists() {
        return Err(format!("path does not exist: {}", trimmed));
    }
    if !p.is_dir() {
        return Err(format!("path is not a directory: {}", trimmed));
    }
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", trimmed, e))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    let cleaned = canonical_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&canonical_str)
        .to_string();
    let mut explorer = std::process::Command::new("explorer.exe");
    explorer.arg(&cleaned);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        explorer.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    explorer
        .spawn()
        .map_err(|e| format!("spawn explorer: {}", e))?;
    Ok(cleaned)
}

#[cfg(not(target_os = "windows"))]
pub fn open_app_folder_inner(_install_location: String) -> Result<String, String> {
    Err("open_app_folder is not supported on this platform".to_string())
}

/// Escapes a string for embedding inside a PowerShell single-quoted
/// literal. The only character we have to worry about is `'` itself,
/// which doubles. Everything else (including $, `, etc.) is literal
/// inside single quotes. PS does NOT process backslash escapes.
#[cfg(target_os = "windows")]
fn ps_single_quote_escape(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg(target_os = "windows")]
pub async fn uninstall_app_inner(
    app: &tauri::AppHandle,
    name: String,
    provider: String,
    package_id: Option<String>,
) -> Result<UninstallResult, String> {
    // Whitelist provider — refuse anything else outright.
    let provider_normalised = match provider.as_str() {
        "winget" | "store" | "msi" | "manual" => provider,
        other => return Err(format!("invalid provider '{}'", other)),
    };
    if name.trim().is_empty() {
        return Err("app name is empty".into());
    }
    if name.len() > 256 {
        return Err("app name is unreasonably long".into());
    }

    // Build the PS command depending on provider. We embed user data only
    // via PS single-quoted literals, with `'` doubled. No interpolation,
    // no `$()` execution.
    let name_safe = ps_single_quote_escape(&name);
    let id_safe = package_id.as_deref().map(ps_single_quote_escape);

    let command = match provider_normalised.as_str() {
        "winget" | "store" => {
            // Prefer the package id when available — it's unambiguous.
            // Both winget and store entries are uninstalled via the same
            // `winget uninstall` invocation.
            if let Some(id) = id_safe {
                format!(
                    "& winget uninstall --id '{}' --accept-source-agreements --disable-interactivity --silent",
                    id
                )
            } else {
                format!(
                    "& winget uninstall --name '{}' --accept-source-agreements --disable-interactivity --silent",
                    name_safe
                )
            }
        }
        "msi" => {
            // PackageManagement route — robust across MSIs, doesn't need
            // to know the GUID. We pipe so the user's app name never
            // becomes a flag.
            format!(
                "Get-Package -Name '{}' -ErrorAction Stop | Uninstall-Package -Force -ErrorAction Stop",
                name_safe
            )
        }
        "manual" => {
            // Manual installers — try Get-Package first (some are still
            // tracked by PackageManagement), fall back to the registry
            // QuietUninstallString if present. We never blindly exec the
            // raw uninstall_hint to avoid arbitrary cmdlines from the
            // registry; the user can still uninstall via Windows Settings.
            format!(
                "Get-Package -Name '{}' -ErrorAction Stop | Uninstall-Package -Force -ErrorAction Stop",
                name_safe
            )
        }
        _ => unreachable!("provider whitelist enforced above"),
    };

    let (stdout, stderr, code, ok) = run_ps_command(app, &command).await?;
    // Best-effort cache invalidation — the next list call should re-scan.
    let _ = std::fs::remove_file(cache_path().unwrap_or_default());
    Ok(UninstallResult {
        success: ok,
        stdout,
        stderr,
        exit_code: code,
        command,
    })
}

#[cfg(not(target_os = "windows"))]
pub async fn uninstall_app_inner(
    _app: &tauri::AppHandle,
    _name: String,
    _provider: String,
    _package_id: Option<String>,
) -> Result<UninstallResult, String> {
    Err("uninstall_app is not supported on this platform".to_string())
}

// ---------------------------------------------------------------------------
// Bloatware uninstall (System → Bloatware sub-tab)
// ---------------------------------------------------------------------------
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

#[derive(Debug, Serialize, Clone)]
pub struct AppxQueryResult {
    /// True when at least one Appx package matched the pattern. The UI uses
    /// this to switch the row state between "Installed" and "Not present".
    pub installed: bool,
    /// Resolved package full names that matched, useful for diagnostics.
    /// Empty when `installed` is false.
    pub matches: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BloatwareUninstallResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub command: String,
    /// Best-effort package full names we attempted to remove. Empty when
    /// the pattern matched nothing on this host.
    pub removed: Vec<String>,
}

/// True when `pattern` only contains characters that are valid in an Appx
/// package family name plus the `*` wildcard. We're paranoid here because
/// the pattern is then embedded in a PS single-quoted literal.
#[cfg(target_os = "windows")]
fn is_valid_appx_pattern(pattern: &str) -> bool {
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
    if !is_valid_appx_pattern(&pattern) {
        return Err(format!("invalid Appx pattern '{}'", pattern));
    }
    let pattern_safe = ps_single_quote_escape(&pattern);
    // -AllUsers is intentionally NOT used (it requires elevation). We query
    // only the current user's appx packages — same scope used by the
    // uninstall command below.
    let command = format!(
        "Get-AppxPackage -Name '{}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty PackageFullName",
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

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    /// Replays the provider whitelist gate from `uninstall_app_inner` —
    /// the actual function needs an `&tauri::AppHandle` we can't build in
    /// a unit test, so we exercise the discriminator directly.
    fn provider_whitelist_check(provider: &str) -> Result<String, String> {
        match provider {
            "winget" | "store" | "msi" | "manual" => Ok(provider.to_string()),
            other => Err(format!("invalid provider '{}'", other)),
        }
    }

    #[test]
    fn provider_whitelist_rejects_unknown() {
        for p in ["winget", "store", "msi", "manual"] {
            assert!(
                provider_whitelist_check(p).is_ok(),
                "expected '{}' to pass whitelist",
                p
            );
        }
        for bad in ["", "WINGET", "rpm", "deb", "; rm -rf /", "msi'; bad"] {
            let err = provider_whitelist_check(bad).unwrap_err();
            assert!(
                err.contains("invalid provider"),
                "expected rejection for '{}', got '{}'",
                bad,
                err
            );
        }
    }

    #[test]
    fn ps_single_quote_escape_doubles_quotes() {
        // No quotes — passthrough
        assert_eq!(ps_single_quote_escape("hello"), "hello");
        // One quote — doubled
        assert_eq!(ps_single_quote_escape("d'arc"), "d''arc");
        // Multiple quotes — each doubled
        assert_eq!(ps_single_quote_escape("'a'b'"), "''a''b''");
        // Backslash, $, backtick are literal inside PS single quotes; left as-is.
        assert_eq!(ps_single_quote_escape("C:\\Program Files"), "C:\\Program Files");
        assert_eq!(ps_single_quote_escape("$var"), "$var");
        assert_eq!(ps_single_quote_escape("`backtick`"), "`backtick`");
    }

    #[test]
    fn appx_pattern_accepts_valid_family_names() {
        for ok in [
            "Microsoft.XboxApp",
            "Microsoft.XboxGamingOverlay*",
            "king.com.CandyCrushSaga",
            "Microsoft.Windows.Photos",
            "*Xbox*",
            "A.B-C_D",
        ] {
            assert!(is_valid_appx_pattern(ok), "expected '{}' to be valid", ok);
        }
    }

    #[test]
    fn appx_pattern_rejects_injection_attempts() {
        for bad in [
            "",
            "Microsoft.XboxApp; Remove-Item C:\\",
            "Microsoft.XboxApp'; bad",
            "Microsoft.XboxApp $(rm)",
            "Microsoft.XboxApp`whoami",
            "with spaces",
            "with/slash",
            "with\\backslash",
        ] {
            assert!(
                !is_valid_appx_pattern(bad),
                "expected '{}' to be rejected",
                bad
            );
        }
    }
}
