# auto-fixes/clear-minidumps.ps1
# Removes Windows app crash dumps (.dmp) from %LOCALAPPDATA%\CrashDumps.
#
# Triggered from the Dashboard's "Auto-fix common issues" modal in
# Control Center. Returns a single-line JSON summary on stdout so the
# Rust caller can render the result.

$ErrorActionPreference = "Stop"
$dir = Join-Path $env:LOCALAPPDATA "CrashDumps"
$removed = 0
$freed = 0L
$errors = @()

if (Test-Path -LiteralPath $dir) {
    Get-ChildItem -LiteralPath $dir -Filter *.dmp -File -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $sz = $_.Length
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
            $removed++
            $freed += $sz
        } catch {
            $errors += "$($_.FullName): $($_.Exception.Message)"
        }
    }
}

$summary = [pscustomobject]@{
    fix      = "clear-minidumps"
    dir      = $dir
    removed  = $removed
    freed_mb = [math]::Round($freed / 1MB, 2)
    errors   = $errors
}
$summary | ConvertTo-Json -Compress
