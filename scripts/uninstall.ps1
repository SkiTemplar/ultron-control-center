<#
.SYNOPSIS
  Safe uninstall for ULTRON v15.2 (Windows / PowerShell).

.DESCRIPTION
  Removes the ULTRON user state at $env:USERPROFILE\.ultron\ after
  preserving any existing backups. Does NOT touch ~/.claude/, which is
  global user state for the Claude Code CLI.

  Hard rules honored:
    - No admin / UAC elevation.
    - No emojis.
    - Confirmation prompt unless -Yes is passed.
    - Idempotent: safe to re-run.

.PARAMETER Yes
  Skip the confirmation prompt (CI mode).

.PARAMETER InstallRoot
  Override the install root. Defaults to "$env:USERPROFILE\.ultron".
#>

[CmdletBinding()]
param(
    [switch]$Yes,
    [string]$InstallRoot = (Join-Path $env:USERPROFILE ".ultron")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step  { param([string]$Msg) Write-Host ("[ STEP ] " + $Msg) }
function Write-Ok    { param([string]$Msg) Write-Host ("  ok    " + $Msg) }
function Write-Info  { param([string]$Msg) Write-Host ("        " + $Msg) }

function Stop-WithFix {
    param(
        [string]$Stage,
        [string]$Command,
        [string]$Fix
    )
    Write-Host ""
    Write-Host ("UNINSTALL FAILED at stage: " + $Stage)
    Write-Host ("  command : " + $Command)
    Write-Host ("  fix     : " + $Fix)
    Write-Host ""
    exit 1
}

# ----------------------------------------------------------------------
# Banner
# ----------------------------------------------------------------------
Write-Host ""
Write-Host "======================================================="
Write-Host " ULTRON uninstaller"
Write-Host "======================================================="
Write-Host (" target : " + $InstallRoot)
Write-Host ""

if (-not (Test-Path -LiteralPath $InstallRoot)) {
    Write-Host "Nothing to do - install root does not exist:"
    Write-Host ("  " + $InstallRoot)
    exit 0
}

# ----------------------------------------------------------------------
# Confirmation
# ----------------------------------------------------------------------
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupSrc = Join-Path $InstallRoot "backups"
$backupDst = Join-Path (Split-Path -Parent $InstallRoot) (".ultron-backup-" + $timestamp)

Write-Host "This will:"
Write-Host ("  1. Move " + $backupSrc + " (if it exists) to " + $backupDst)
Write-Host ("  2. Remove " + $InstallRoot)
Write-Host "  3. Leave ~/.claude/ untouched (global Claude CLI state)"
Write-Host ""

if (-not $Yes) {
    $answer = Read-Host -Prompt "Continue? [y/N]"
    if ($answer -notmatch "^(y|yes)$") {
        Write-Host "Aborted."
        exit 0
    }
}

# ----------------------------------------------------------------------
# Move backups out of the way
# ----------------------------------------------------------------------
Write-Step "preserving backups"
if (Test-Path -LiteralPath $backupSrc) {
    try {
        Move-Item -LiteralPath $backupSrc -Destination $backupDst -Force
        Write-Ok ("backups moved to " + $backupDst)
    } catch {
        Stop-WithFix -Stage "preserve-backups" `
                     -Command ("Move-Item " + $backupSrc + " -> " + $backupDst) `
                     -Fix     "Close any process holding files inside backups/ and re-run."
    }
} else {
    Write-Info "no backups/ directory found - nothing to preserve"
}

# ----------------------------------------------------------------------
# Remove .ultron
# ----------------------------------------------------------------------
Write-Step ("removing " + $InstallRoot)
try {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force -Confirm:$false
    Write-Ok "install root removed"
} catch {
    Stop-WithFix -Stage "remove-root" `
                 -Command ("Remove-Item -Recurse -Force " + $InstallRoot) `
                 -Fix     "Close any editor or shell with a working directory inside ~/.ultron and re-run."
}

# ----------------------------------------------------------------------
# Final notice
# ----------------------------------------------------------------------
Write-Host ""
Write-Host "======================================================="
Write-Host " ULTRON uninstall complete"
Write-Host "======================================================="
if (Test-Path -LiteralPath $backupDst) {
    Write-Host (" Backups preserved at: " + $backupDst)
}
Write-Host " ~/.claude/ was NOT touched."
Write-Host "======================================================="
exit 0
