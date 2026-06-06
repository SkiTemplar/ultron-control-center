# apply-lazy-ecc.ps1
# Disables ECC plugin skills for SessionStart by renaming SKILL.md -> SKILL.md.disabled
# Reversible: ONLY the SKILL.md file is renamed. Folders, hooks/, commands/ are untouched.
# ASCII-safe: no em-dashes or smart quotes (PS 5.1 parser-safe).
#
# Usage:
#   .\apply-lazy-ecc.ps1 -WhatIf           # dry-run (default: shows what would change)
#   .\apply-lazy-ecc.ps1 -Force            # execute disable
#   .\apply-lazy-ecc.ps1 -Undo -Force      # revert: SKILL.md.disabled -> SKILL.md
#   .\apply-lazy-ecc.ps1 -Undo             # dry-run of undo

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Undo,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Root of the ECC skills cache
$EccRoot = Join-Path $env:USERPROFILE '.claude\plugins\cache\ecc'

if (-not (Test-Path $EccRoot)) {
    Write-Error "ECC cache not found: $EccRoot"
    exit 1
}

# Discover all SKILL.md files (active) and SKILL.md.disabled files (already disabled)
$ActiveFiles   = Get-ChildItem -Path $EccRoot -Recurse -Filter 'SKILL.md'   -ErrorAction SilentlyContinue |
                     Where-Object { $_.Name -eq 'SKILL.md' }
$DisabledFiles = Get-ChildItem -Path $EccRoot -Recurse -Filter 'SKILL.md.disabled' -ErrorAction SilentlyContinue |
                     Where-Object { $_.Name -eq 'SKILL.md.disabled' }

$CountDisabled = 0
$CountSkipped  = 0
$CountErrors   = 0

# ---- DRY-RUN guard ----
# When -Force is NOT supplied, report and exit without touching the filesystem.
if (-not $Force) {
    if ($Undo) {
        Write-Host "DRY-RUN (-Undo): would re-enable $($DisabledFiles.Count) SKILL.md.disabled files."
        Write-Host "Run with -Undo -Force to execute."
    } else {
        Write-Host "DRY-RUN: would disable $($ActiveFiles.Count) SKILL.md files (rename -> SKILL.md.disabled)."
        Write-Host "Run with -Force to execute."
    }
    exit 0
}

# ---- UNDO mode ----
if ($Undo) {
    Write-Host "=== UNDO mode: re-enabling ECC skills ==="
    foreach ($file in $DisabledFiles) {
        $targetPath = Join-Path $file.DirectoryName 'SKILL.md'
        if (Test-Path $targetPath) {
            Write-Host "SKIP (SKILL.md already present): $($file.DirectoryName)"
            $CountSkipped++
        } else {
            if ($PSCmdlet.ShouldProcess($file.FullName, 'Rename SKILL.md.disabled -> SKILL.md')) {
                try {
                    Rename-Item -Path $file.FullName -NewName 'SKILL.md'
                    Write-Verbose "ENABLED: $($file.DirectoryName)"
                    $CountDisabled++
                } catch {
                    Write-Warning "ERROR enabling $($file.FullName): $_"
                    $CountErrors++
                }
            }
        }
    }
    Write-Host ""
    Write-Host "Done. Re-enabled: $CountDisabled  Skipped: $CountSkipped  Errors: $CountErrors"
    exit 0
}

# ---- DISABLE mode ----
Write-Host "=== DISABLE mode: disabling ECC skills ==="
foreach ($file in $ActiveFiles) {
    $disabledPath = Join-Path $file.DirectoryName 'SKILL.md.disabled'
    if (Test-Path $disabledPath) {
        Write-Verbose "SKIP (already disabled): $($file.DirectoryName)"
        $CountSkipped++
    } else {
        if ($PSCmdlet.ShouldProcess($file.FullName, 'Rename SKILL.md -> SKILL.md.disabled')) {
            try {
                Rename-Item -Path $file.FullName -NewName 'SKILL.md.disabled'
                Write-Verbose "DISABLED: $($file.DirectoryName)"
                $CountDisabled++
            } catch {
                Write-Warning "ERROR disabling $($file.FullName): $_"
                $CountErrors++
            }
        }
    }
}

Write-Host ""
Write-Host "Done. Disabled: $CountDisabled  Skipped: $CountSkipped  Errors: $CountErrors"
Write-Host ""
Write-Host "To revert run: .\apply-lazy-ecc.ps1 -Undo -Force"
