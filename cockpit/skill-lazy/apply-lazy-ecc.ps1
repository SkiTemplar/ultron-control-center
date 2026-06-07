# apply-lazy-ecc.ps1
# Disables ECC plugin skills for SessionStart by FOLDER-renaming the skill
# directory: <name>  ->  <name>.disabled  (the SKILL.md stays inside).
#
# This MUST match what the routing dispatcher expects. scanEccSkills() in
# cockpit/skill-lazy/routing-dispatcher.v2.js recognizes a skill as disabled
# ONLY when its FOLDER is named "<name>.disabled" (it iterates directories,
# strips the ".disabled" suffix from the folder name, and reads
# "<folder>/SKILL.md"). Renaming SKILL.md -> SKILL.md.disabled (the previous
# strategy) is NOT recognized as disabled by the dispatcher and broke the
# _verify_final.js harness (26 -> 12), hence the rewrite.
#
# Layouts:
#   Active:   skills/<name>/SKILL.md
#   Disabled: skills/<name>.disabled/SKILL.md   (folder renamed by this script)
#
# Reversible: -Undo renames <name>.disabled -> <name> (symmetric). Only skill
# folders that actually contain a SKILL.md are touched; hooks/ and commands/
# directories elsewhere in the cache are untouched.
#
# ASCII-safe: no em-dashes or smart quotes (PS 5.1 parser-safe).
#
# Usage:
#   .\apply-lazy-ecc.ps1                   # dry-run of disable (default)
#   .\apply-lazy-ecc.ps1 -Force            # execute disable
#   .\apply-lazy-ecc.ps1 -Undo             # dry-run of undo
#   .\apply-lazy-ecc.ps1 -Undo -Force      # revert: <name>.disabled -> <name>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Undo,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Root of the ECC plugin cache (matches ECC_CACHE_ROOT in routing-dispatcher.v2.js)
$EccRoot = Join-Path $env:USERPROFILE '.claude\plugins\cache\ecc\ecc'

if (-not (Test-Path $EccRoot)) {
    Write-Error "ECC cache not found: $EccRoot"
    exit 1
}

# Resolve the skills directory: first version sub-dir of $EccRoot that has a
# "skills" folder (same resolution as resolveEccSkillsDir() in the dispatcher).
$SkillsDir = $null
foreach ($vdir in (Get-ChildItem -Path $EccRoot -Directory -ErrorAction SilentlyContinue)) {
    $candidate = Join-Path $vdir.FullName 'skills'
    if (Test-Path $candidate) {
        $SkillsDir = $candidate
        break
    }
}

if (-not $SkillsDir) {
    Write-Error "No skills directory found under: $EccRoot"
    exit 1
}

# Enumerate immediate skill folders. A folder is a real skill iff it contains
# a SKILL.md (so we never rename hooks/, commands/, or other non-skill dirs).
$AllFolders = Get-ChildItem -Path $SkillsDir -Directory -ErrorAction SilentlyContinue

$ActiveFolders = @()
$DisabledFolders = @()
foreach ($folder in $AllFolders) {
    $skillMd = Join-Path $folder.FullName 'SKILL.md'
    if (-not (Test-Path $skillMd)) { continue }
    if ($folder.Name.EndsWith('.disabled')) {
        $DisabledFolders += $folder
    } else {
        $ActiveFolders += $folder
    }
}

$CountChanged = 0
$CountSkipped = 0
$CountErrors  = 0

# ---- DRY-RUN guard ----
# When -Force is NOT supplied, report and exit without touching the filesystem.
if (-not $Force) {
    if ($Undo) {
        Write-Host "DRY-RUN (-Undo): would re-enable $($DisabledFolders.Count) disabled skill folders (<name>.disabled -> <name>)."
        Write-Host "Run with -Undo -Force to execute."
    } else {
        Write-Host "DRY-RUN: would disable $($ActiveFolders.Count) active skill folders (<name> -> <name>.disabled)."
        Write-Host "Run with -Force to execute."
    }
    exit 0
}

# ---- UNDO mode: <name>.disabled -> <name> ----
if ($Undo) {
    Write-Host "=== UNDO mode: re-enabling ECC skills (folder rename) ==="
    foreach ($folder in $DisabledFolders) {
        $newName = $folder.Name.Substring(0, $folder.Name.Length - '.disabled'.Length)
        $targetPath = Join-Path $folder.Parent.FullName $newName
        if (Test-Path $targetPath) {
            Write-Host "SKIP (target already exists): $newName"
            $CountSkipped++
        } else {
            if ($PSCmdlet.ShouldProcess($folder.FullName, "Rename folder -> $newName")) {
                try {
                    Rename-Item -LiteralPath $folder.FullName -NewName $newName
                    Write-Verbose "ENABLED: $newName"
                    $CountChanged++
                } catch {
                    Write-Warning "ERROR enabling $($folder.FullName): $_"
                    $CountErrors++
                }
            }
        }
    }
    Write-Host ""
    Write-Host "Done. Re-enabled: $CountChanged  Skipped: $CountSkipped  Errors: $CountErrors"
    exit 0
}

# ---- DISABLE mode: <name> -> <name>.disabled ----
Write-Host "=== DISABLE mode: disabling ECC skills (folder rename) ==="
foreach ($folder in $ActiveFolders) {
    $newName = "$($folder.Name).disabled"
    $targetPath = Join-Path $folder.Parent.FullName $newName
    if (Test-Path $targetPath) {
        Write-Verbose "SKIP (already disabled): $($folder.Name)"
        $CountSkipped++
    } else {
        if ($PSCmdlet.ShouldProcess($folder.FullName, "Rename folder -> $newName")) {
            try {
                Rename-Item -LiteralPath $folder.FullName -NewName $newName
                Write-Verbose "DISABLED: $($folder.Name)"
                $CountChanged++
            } catch {
                Write-Warning "ERROR disabling $($folder.FullName): $_"
                $CountErrors++
            }
        }
    }
}

Write-Host ""
Write-Host "Done. Disabled: $CountChanged  Skipped: $CountSkipped  Errors: $CountErrors"
Write-Host ""
Write-Host "To revert run: .\apply-lazy-ecc.ps1 -Undo -Force"
