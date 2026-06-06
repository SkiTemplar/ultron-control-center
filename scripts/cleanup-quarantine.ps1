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

    With -AutoCompress the script compresses any quarantine directory whose
    total size exceeds $AutoCompressThresholdGB GB (default 1 GB) into a
    .zip archive.  The original directory is removed only after the archive
    is confirmed present.  -WhatIf is honoured; -Force skips confirmation.

    With -PurgeExpired the script deletes quarantine directories (or their
    .zip archives) whose last-write time is older than $PurgeExpiredDays
    days (default 28 days / 4 weeks).  -WhatIf IS ACTIVE BY DEFAULT for
    this flag -- you must also pass -Force to execute actual deletions.

    This script NEVER deletes anything silently.  Every destructive step
    is guarded by an explicit confirmation prompt (or -Force to skip it).

    DISK HYGIENE POLICY (see docs/MAINTAINERS.md -- Disk Hygiene):
    * .fastembed_cache in ~/.ultron/.fastembed_cache is managed separately
      (do NOT pass that path to this script).
    * Quarantine directories are named _cleanup_quarantine_<YYYY-MM-DD>
      and accumulate during wave-based refactors.
    * Recommended cadence: run -AutoCompress weekly; -PurgeExpired monthly.

.PARAMETER Apply
    When specified, compress each quarantine to .zip and delete the source.

.PARAMETER Force
    Skip confirmation prompts.  Required together with -PurgeExpired to
    execute actual deletions (WhatIf is default for purge).

.PARAMETER AutoCompress
    Compress quarantine directories whose combined size exceeds
    AutoCompressThresholdGB (default 1 GB) into a .zip archive next to the
    directory, then remove the original directory.  No deletions happen
    without a .zip being confirmed on disk first.

.PARAMETER AutoCompressThresholdGB
    Size threshold (in GB) above which -AutoCompress acts on a directory.
    Default: 1 (i.e. 1 GB).

.PARAMETER PurgeExpired
    Delete quarantine directories (or .zip archives) whose last-write
    timestamp is older than PurgeExpiredDays days.  -WhatIf IS ON BY
    DEFAULT; add -Force to execute real deletions.

.PARAMETER PurgeExpiredDays
    Age threshold (in days) for -PurgeExpired.  Default: 28 (4 weeks).

.PARAMETER WhatIf
    (Standard PowerShell switch.)  When used with -Apply or -AutoCompress,
    show what would happen without actually doing it.

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

.EXAMPLE
    # Compress directories larger than 1 GB (dry-run by default via -WhatIf)
    .\cleanup-quarantine.ps1 -AutoCompress -WhatIf

.EXAMPLE
    # Compress directories larger than 1 GB (execute)
    .\cleanup-quarantine.ps1 -AutoCompress -Force

.EXAMPLE
    # Show what -PurgeExpired would delete (WhatIf always on without -Force)
    .\cleanup-quarantine.ps1 -PurgeExpired

.EXAMPLE
    # Actually delete quarantine dirs/archives older than 28 days
    .\cleanup-quarantine.ps1 -PurgeExpired -Force
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Apply,
    [switch]$Force,

    # --- auto-compress flag (Kirkardo PILAR 4 gap) ---
    [switch]$AutoCompress,
    [double]$AutoCompressThresholdGB = 1.0,

    # --- purge-expired flag (Kirkardo PILAR 4 gap) ---
    [switch]$PurgeExpired,
    [int]$PurgeExpiredDays = 28
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

# @(...) forces an array so .Count is valid under Set-StrictMode even when the
# pipeline yields $null (0 matches) or a single object (1 match).
$quarantineDirs = @(Get-ChildItem -Path $UltronHome -Directory -Force `
    | Where-Object { $_.Name -like '_cleanup_quarantine_*' } `
    | Sort-Object Name)

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

if (-not $Apply -and -not $AutoCompress -and -not $PurgeExpired) {
    Write-Host 'Read-only mode.  Use -Apply, -AutoCompress, or -PurgeExpired.' -ForegroundColor Yellow
    exit 0
}

# ---------------------------------------------------------------------------
# -Apply: compress each quarantine to .zip then delete the source
# ---------------------------------------------------------------------------

# GUARD: the compress+delete block below acts on ALL quarantine dirs and must
# run ONLY when -Apply was explicitly passed.  Without this guard, invoking the
# script with -AutoCompress or -PurgeExpired alone (whose own early-exit on
# line ~164 does not fire because a flag IS present) fell through into this
# block and compressed+deleted every quarantine dir, ignoring the size/age
# thresholds and bypassing the -WhatIf-by-default contract.  (Kirkardo R4 P4.)
if ($Apply) {
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
    if (-not $AutoCompress -and -not $PurgeExpired) {
        Write-Host 'Done.' -ForegroundColor Cyan
        exit 0
    }
}

# ---------------------------------------------------------------------------
# -AutoCompress: compress directories whose total size exceeds the threshold
# ---------------------------------------------------------------------------
# NOTE: This flag compresses heavy quarantine dirs to .zip to reclaim disk
# space.  The original directory is only removed after the .zip is confirmed
# on disk.  -WhatIf is fully supported.  Actual heavy I/O (7z / Compress-
# Archive) is deferred to runtime -- this script does NOT execute it for you
# during test/review; run it explicitly when disk hygiene requires it.
# ---------------------------------------------------------------------------

if ($AutoCompress) {
    $thresholdBytes = $AutoCompressThresholdGB * 1GB
    # @(...) keeps .Count valid under StrictMode for 0/1/N matches.
    $candidates = @($rows | Where-Object { ($_.SizeMB * 1MB) -ge $thresholdBytes })

    if ($candidates.Count -eq 0) {
        Write-Host ("AutoCompress: no directories exceed {0} GB threshold." -f $AutoCompressThresholdGB) -ForegroundColor Green
    } else {
        Write-Host ''
        Write-Host ("AutoCompress: {0} director(ies) exceed {1} GB:" -f $candidates.Count, $AutoCompressThresholdGB) -ForegroundColor Cyan

        if (-not $Force -and -not $WhatIfPreference) {
            $answer = Read-Host ("Compress {0} director(ies) and remove originals?  [y/N]" -f $candidates.Count)
            if ($answer -notmatch '^[Yy]') {
                Write-Host 'AutoCompress: aborted by user.' -ForegroundColor Yellow
            } else {
                foreach ($row in $candidates) {
                    $src = $row.FullPath
                    $zip = "$src.zip"
                    Write-Host ("  Compressing: {0} ({1} MB)" -f $row.Name, $row.SizeMB)
                    if ($PSCmdlet.ShouldProcess($src, "AutoCompress to $zip")) {
                        try {
                            Compress-Archive -Path $src -DestinationPath $zip -Force
                            Write-Host "    -> $zip" -ForegroundColor Green
                        } catch {
                            Write-Warning "    Compression failed: $_"
                            continue
                        }
                        if (Test-Path $zip) {
                            if ($PSCmdlet.ShouldProcess($src, 'Remove original after successful compress')) {
                                try {
                                    Remove-Item -Path $src -Recurse -Force
                                    Write-Host "    Original removed." -ForegroundColor Green
                                } catch {
                                    Write-Warning "    Could not remove original: $_"
                                }
                            }
                        } else {
                            Write-Warning "    Archive not found after compress; original kept: $src"
                        }
                    }
                }
            }
        } else {
            foreach ($row in $candidates) {
                $src = $row.FullPath
                $zip = "$src.zip"
                Write-Host ("  Compressing: {0} ({1} MB)" -f $row.Name, $row.SizeMB)
                if ($PSCmdlet.ShouldProcess($src, "AutoCompress to $zip")) {
                    try {
                        Compress-Archive -Path $src -DestinationPath $zip -Force
                        Write-Host "    -> $zip" -ForegroundColor Green
                    } catch {
                        Write-Warning "    Compression failed: $_"
                        continue
                    }
                    if (Test-Path $zip) {
                        if ($PSCmdlet.ShouldProcess($src, 'Remove original after successful compress')) {
                            try {
                                Remove-Item -Path $src -Recurse -Force
                                Write-Host "    Original removed." -ForegroundColor Green
                            } catch {
                                Write-Warning "    Could not remove original: $_"
                            }
                        }
                    } else {
                        Write-Warning "    Archive not found after compress; original kept: $src"
                    }
                }
            }
        }
    }
}

# ---------------------------------------------------------------------------
# -PurgeExpired: delete quarantine dirs/archives older than PurgeExpiredDays
# ---------------------------------------------------------------------------
# SAFETY: -WhatIf IS ACTIVE BY DEFAULT for this flag.  Real deletions only
# happen when -Force is also specified.  This is intentional -- purging
# weeks-old data is irreversible and should require an explicit opt-in.
# ---------------------------------------------------------------------------

if ($PurgeExpired) {
    $cutoff = (Get-Date).AddDays(-$PurgeExpiredDays)

    # Collect both directories and .zip archives that match the quarantine pattern.
    # @(...) keeps .Count valid under StrictMode when 0 items are expired.
    $expiredItems = @(Get-ChildItem -Path $UltronHome -Force `
        | Where-Object {
            ($_.Name -like '_cleanup_quarantine_*') -and
            ($_.LastWriteTime -lt $cutoff)
        } `
        | Sort-Object Name)

    Write-Host ''
    Write-Host ("PurgeExpired: items older than {0} days (cutoff {1:yyyy-MM-dd}):" -f $PurgeExpiredDays, $cutoff) -ForegroundColor Cyan

    if ($expiredItems.Count -eq 0) {
        Write-Host "  None found." -ForegroundColor Green
    } else {
        $expiredItems | Format-Table Name, LastWriteTime -AutoSize

        # Default to WhatIf unless -Force is explicitly supplied.
        if (-not $Force) {
            Write-Host ("PurgeExpired: {0} item(s) would be deleted.  Re-run with -Force to execute." -f $expiredItems.Count) -ForegroundColor Yellow
        } else {
            $answer = Read-Host ("Permanently delete {0} expired item(s)?  This is IRREVERSIBLE.  [y/N]" -f $expiredItems.Count)
            if ($answer -notmatch '^[Yy]') {
                Write-Host 'PurgeExpired: aborted by user.' -ForegroundColor Yellow
            } else {
                foreach ($item in $expiredItems) {
                    if ($PSCmdlet.ShouldProcess($item.FullName, 'Purge expired quarantine item')) {
                        try {
                            Remove-Item -Path $item.FullName -Recurse -Force
                            Write-Host ("  Deleted: {0}" -f $item.Name) -ForegroundColor Green
                        } catch {
                            Write-Warning ("  Could not delete {0}: {1}" -f $item.Name, $_)
                        }
                    }
                }
            }
        }
    }
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Cyan
