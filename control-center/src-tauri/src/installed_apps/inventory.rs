// installed_apps/inventory.rs — PowerShell-based software inventory scan.

use serde::Deserialize;

use super::types::InstalledApp;

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
pub(super) async fn scan_apps(
    app: &tauri::AppHandle,
) -> Result<(Vec<InstalledApp>, Vec<String>), String> {
    use super::ps_util::run_ps_command;

    let (stdout, stderr, code, ok) = run_ps_command(app, INVENTORY_PS).await?;
    if !ok {
        return Err(format!(
            "inventory PS script failed (exit {:?}): {}",
            code, stderr
        ));
    }
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok((
            Vec::new(),
            vec!["inventory script produced no output".into()],
        ));
    }
    let parsed: PsInventoryResult = serde_json::from_str(trimmed)
        .map_err(|e| format!("parse inventory json: {} (output: {:.500})", e, trimmed))?;
    Ok((parsed.apps, parsed.errors))
}
