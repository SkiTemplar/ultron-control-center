#Requires -Version 5.1
<#
.SYNOPSIS
    Report size/count of _cleanup_quarantine_* directories and optionally
    compress or delete them.

.DESCRIPTION
    By default (no -Apply) the script is read-only: it prints a table with
    the name, file count, and total size of every _cleanup_quarantine_*
    directory found directly under ~/.ultron.

    With -Apply the script compresses each quarantine to a .zip archive
    alongside the original directory, then removes the original.  All
    actions are preceded by a -WhatIf dry-run summary unless -Force is
    also specified.

    This script NEVER deletes anything silently.  Every destructive step
    is guarded by an explicit confirmation prompt (or -Force to skip it).

.PARAMETER Apply
    When specified, compress each quarantine to .zip and delete the source.

.PARAMETER Force
    Skip confirmation prompts.  Only meaningful together with -Apply.

.PARAMETER WhatIf
    (Standard PowerShell switch.)  When used with -Apply, show what would
    happen without actually doing it.

.EXAMPLE
    # Just report sizes (safe, default)
    .\cleanup-quarantine.ps1

.EXAMPLE
    # Dry-run: show what would be compressed/deleted
    .\cleanup-quarantine.ps1 -Apply -WhatIf

.EXAMPLE
    # Actually compress and delete, with per-item confirmation
    .\cleanup-quarantine.ps1 -Apply

.EXAMPLE
    # Compress and delete everything without prompts
    .\cleanup-quarantine.ps1 -Apply -Force
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Apply,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Locate quarantine directories
# ---------------------------------------------------------------------------
$UltronHome = Join-Path $env:USERPROFILE '.ultron'

if (-not (Test-Path $UltronHome -PathType Container)) {
    Write-Error "ULTRON home not found: $UltronHome"
    exit 1
}

$quarantineDirs = Get-ChildItem -Path $UltronHome -Directory -Force `
    | Where-Object { $_.Name -like '_cleanup_quarantine_*' } `
    | Sort-Object Name

if ($quarantineDirs.Count -eq 0) {
    Write-Host 'No _cleanup_quarantine_* directories found.' -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# Measure each directory
# ---------------------------------------------------------------------------
$rows = foreach ($dir in $quarantineDirs) {
    $files = Get-ChildItem -Path $dir.FullName -Recurse -Force -File `
                 -ErrorAction SilentlyContinue
    $count = ($files | Measure-Object).Count
    $bytes = ($files | Measure-Object -Sum Length).Sum
    if ($null -eq $bytes) { $bytes = 0 }
    $mb    = [math]::Round($bytes / 1MB, 2)

    [PSCustomObject]@{
        Name    = $dir.Name
        Files   = $count
        SizeMB  = $mb
        FullPath = $dir.FullName
    }
}

# ---------------------------------------------------------------------------
# Always print the report table
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Quarantine directories under ~/.ultron' -ForegroundColor Cyan
Write-Host ('-' * 72)
$rows | Format-Table -Property Name, Files, SizeMB -AutoSize
$totalMB = [math]::Round(($rows | Measure-Object -Sum SizeMB).Sum, 2)
Write-Host "Total: $($rows.Count) director(ies), ${totalMB} MB combined."
Write-Host ''

if (-not $Apply) {
    Write-Host 'Read-only mode.  Use -Apply to compress and remove.' -ForegroundColor Yellow
    exit 0
}

# ---------------------------------------------------------------------------
# -Apply: compress each quarantine to .zip then delete the source
# ---------------------------------------------------------------------------

# Confirm once unless -Force
if (-not $Force -and -not $WhatIfPreference) {
    $answer = Read-Host "About to compress $($rows.Count) director(ies) and delete originals.  Proceed? [y/N]"
    if ($answer -notmatch '^[Yy]') {
        Write-Host 'Aborted.' -ForegroundColor Yellow
        exit 0
    }
}

foreach ($row in $rows) {
    $src  = $row.FullPath
    $zip  = "$src.zip"

    Write-Host "Processing: $($row.Name) ($($row.SizeMB) MB, $($row.Files) files)"

    # --- Compress ---
    if ($PSCmdlet.ShouldProcess($src, "Compress to $zip")) {
        try {
            Compress-Archive -Path $src -DestinationPath $zip -Force
            Write-Host "  Compressed -> $zip" -ForegroundColor Green
        } catch {
            Write-Warning "  Compression failed for $src : $_"
            Write-Warning "  Skipping deletion for this directory."
            continue
        }
    }

    # --- Delete source ---
    if ($PSCmdlet.ShouldProcess($src, 'Remove original directory')) {
        try {
            Remove-Item -Path $src -Recurse -Force
            Write-Host "  Deleted source directory." -ForegroundColor Green
        } catch {
            Write-Warning "  Could not delete $src : $_"
            Write-Warning "  Archive retained at $zip"
        }
    }
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Cyan
