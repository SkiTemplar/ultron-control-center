# apply-lazy-skills.ps1
# Disables skills with keep_active=false by renaming their folder to <name>.disabled
# Use -Undo to revert. Idempotent. ASCII-safe (no em-dashes or fancy quotes).
#
# Usage:
#   .\apply-lazy-skills.ps1            # disable lazy skills
#   .\apply-lazy-skills.ps1 -Undo      # re-enable disabled skills
#
# Requirements: Node.js not required; reads skills-registry.json directly via PowerShell.

param(
    [switch]$Undo
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SkillsDir = Join-Path $env:USERPROFILE ".claude\skills"
$RegistryPath = Join-Path $env:USERPROFILE ".ultron\cockpit\skill-lazy\skills-registry.json"

if (-not (Test-Path $RegistryPath)) {
    Write-Error "Registry not found: $RegistryPath"
    exit 1
}

$RegistryRaw = Get-Content -Raw -Path $RegistryPath
$Registry = $RegistryRaw | ConvertFrom-Json

$LazySkills = $Registry | Where-Object { $_.keep_active -eq $false }

if ($LazySkills.Count -eq 0) {
    Write-Host "No lazy skills found in registry. Nothing to do."
    exit 0
}

$Disabled = 0
$Skipped  = 0
$Errors   = 0

if ($Undo) {
    Write-Host "=== UNDO mode: re-enabling lazy skills ==="
    foreach ($skill in $LazySkills) {
        $disabledPath = Join-Path $SkillsDir ($skill.name + ".disabled")
        $activePath   = Join-Path $SkillsDir $skill.name

        if (Test-Path $disabledPath) {
            if (Test-Path $activePath) {
                Write-Host "SKIP (already active): $($skill.name)"
                $Skipped++
            } else {
                try {
                    Rename-Item -Path $disabledPath -NewName $skill.name
                    Write-Host "ENABLED: $($skill.name)"
                    $Disabled++
                } catch {
                    Write-Warning "ERROR enabling $($skill.name): $_"
                    $Errors++
                }
            }
        } elseif (Test-Path $activePath) {
            Write-Host "SKIP (already active, no .disabled copy): $($skill.name)"
            $Skipped++
        } else {
            Write-Host "SKIP (not found): $($skill.name)"
            $Skipped++
        }
    }
    Write-Host ""
    Write-Host "Done. Re-enabled: $Disabled  Skipped: $Skipped  Errors: $Errors"
} else {
    Write-Host "=== APPLY mode: disabling lazy skills ==="
    foreach ($skill in $LazySkills) {
        $activePath   = Join-Path $SkillsDir $skill.name
        $disabledPath = Join-Path $SkillsDir ($skill.name + ".disabled")

        if (Test-Path $disabledPath) {
            Write-Host "SKIP (already disabled): $($skill.name)"
            $Skipped++
        } elseif (Test-Path $activePath) {
            try {
                Rename-Item -Path $activePath -NewName ($skill.name + ".disabled")
                Write-Host "DISABLED: $($skill.name)"
                $Disabled++
            } catch {
                Write-Warning "ERROR disabling $($skill.name): $_"
                $Errors++
            }
        } else {
            Write-Host "SKIP (not found): $($skill.name)"
            $Skipped++
        }
    }
    Write-Host ""
    Write-Host "Done. Disabled: $Disabled  Skipped: $Skipped  Errors: $Errors"
    Write-Host ""
    Write-Host "To revert run: .\apply-lazy-skills.ps1 -Undo"
}
