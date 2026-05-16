<#
.SYNOPSIS
  ULTRON one-shot uninstaller (Windows / PowerShell).

.DESCRIPTION
  Removes everything ULTRON installed on this machine. Specifically:

    - ~/.ultron/                (entire directory: cockpit, plans, brain, vault index, sessions, logs, backups)
    - autostart entry          (HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ULTRON*)
    - scheduled tasks          (any task whose name starts with "ULTRON")
    - Start Menu / Desktop shortcuts that point at ULTRON Control Center
    - hook entries in ~/.claude/settings.json that point at ~/.ultron/

  Does NOT touch:
    - ~/.claude/skills/        (user's installed skills — those are theirs)
    - ~/.claude/settings.json  (only the hook entries pointing at ~/.ultron/ are removed; the file stays)
    - ~/.codex/, ~/.agents/    (third-party CLIs, untouched)
    - the cloned ultron repo directory (delete that yourself when ready)

  Use -DryRun to preview without making changes.

.PARAMETER NonInteractive
  Skip the y/N confirmation. Suitable for unattended cleanup.

.PARAMETER DryRun
  Print what would be removed without touching anything.

.PARAMETER KeepBackups
  Move ~/.ultron/ to ~/.ultron-removed-YYYYMMDD-HHMM/ instead of deleting it.

.EXAMPLE
  .\uninstall.ps1
  .\uninstall.ps1 -DryRun
  .\uninstall.ps1 -NonInteractive -KeepBackups

.NOTES
  Idempotent. Re-running is safe — items already removed are silently skipped.
#>

[CmdletBinding()]
param(
    [switch]$NonInteractive,
    [switch]$DryRun,
    [switch]$KeepBackups
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Script:UltronHome  = Join-Path $env:USERPROFILE ".ultron"
$Script:ClaudeHome  = Join-Path $env:USERPROFILE ".claude"
$Script:SettingsJson = Join-Path $Script:ClaudeHome "settings.json"
$Script:Actions      = New-Object System.Collections.Generic.List[string]
$Script:Skipped      = New-Object System.Collections.Generic.List[string]
$Script:Failures     = New-Object System.Collections.Generic.List[string]

function Write-Section($title) {
    Write-Host ""
    Write-Host ("== " + $title + " " + ("=" * [Math]::Max(0, 60 - $title.Length))) -ForegroundColor Cyan
}

function Record-Action($msg) { $Script:Actions.Add($msg) | Out-Null; Write-Host "  [OK] $msg" -ForegroundColor Green }
function Record-Skip($msg)   { $Script:Skipped.Add($msg) | Out-Null; Write-Host "  [--] $msg" -ForegroundColor DarkGray }
function Record-Fail($msg)   { $Script:Failures.Add($msg) | Out-Null; Write-Host "  [!!] $msg" -ForegroundColor Yellow }

function Invoke-Step($desc, [ScriptBlock]$block) {
    try {
        & $block
    } catch {
        Record-Fail "$desc — $($_.Exception.Message)"
    }
}

Write-Section "ULTRON uninstaller"
Write-Host "  Install root: $Script:UltronHome"
Write-Host "  Mode:         $(if ($DryRun) { 'DRY-RUN (no changes)' } else { 'LIVE' })"

if (-not $NonInteractive -and -not $DryRun) {
    Write-Host ""
    Write-Host "  This will remove ULTRON from this machine." -ForegroundColor Yellow
    Write-Host "  Your Claude Code skills in ~/.claude/skills/ will be PRESERVED." -ForegroundColor Yellow
    $resp = Read-Host "  Type 'yes' to continue"
    if ($resp -ne "yes") {
        Write-Host "  Aborted by user." -ForegroundColor Red
        return
    }
}

# ----------------------------------------------------------------------
# 1) Remove ~/.claude/settings.json hook entries that reference ~/.ultron
# ----------------------------------------------------------------------
Write-Section "Claude settings hooks"
Invoke-Step "Strip ~/.ultron hook entries from settings.json" {
    if (-not (Test-Path -LiteralPath $Script:SettingsJson)) {
        Record-Skip "settings.json not found"
        return
    }
    $raw = Get-Content -LiteralPath $Script:SettingsJson -Raw -Encoding UTF8
    $obj = $raw | ConvertFrom-Json -ErrorAction Stop
    if (-not $obj.PSObject.Properties.Match("hooks").Count) {
        Record-Skip "no hooks section in settings.json"
        return
    }
    $changed = $false
    $newHooks = @{}
    foreach ($eventName in $obj.hooks.PSObject.Properties.Name) {
        $eventHooks = $obj.hooks.$eventName
        if ($null -eq $eventHooks) { continue }
        $keptForEvent = @()
        foreach ($matcher in $eventHooks) {
            $keptHookEntries = @()
            $hookList = $null
            if ($matcher.PSObject.Properties.Match("hooks").Count) {
                $hookList = $matcher.hooks
            }
            foreach ($h in $hookList) {
                $cmd = if ($h.PSObject.Properties.Match("command").Count) { [string]$h.command } else { "" }
                if ($cmd -match "\.ultron[\\/]" -or $cmd -match "\\.ultron[\\\\/]" -or $cmd -match "~[\\/]\.ultron") {
                    $changed = $true
                    continue
                }
                $keptHookEntries += $h
            }
            if ($keptHookEntries.Count -gt 0) {
                $matcher.hooks = $keptHookEntries
                $keptForEvent += $matcher
            } else {
                $changed = $true
            }
        }
        if ($keptForEvent.Count -gt 0) {
            $newHooks[$eventName] = $keptForEvent
        } else {
            $changed = $true
        }
    }
    if (-not $changed) {
        Record-Skip "no hook entries reference ~/.ultron"
        return
    }
    if ($DryRun) {
        Record-Action "[dry] would rewrite settings.json (hooks cleared)"
        return
    }
    # Backup first
    $backupDir = Join-Path $Script:ClaudeHome "backups"
    if (-not (Test-Path -LiteralPath $backupDir)) {
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    }
    $ts = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupFile = Join-Path $backupDir "settings.json.uninstall-$ts.bak"
    Copy-Item -LiteralPath $Script:SettingsJson -Destination $backupFile -Force
    $obj.hooks = [pscustomobject]$newHooks
    $obj | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $Script:SettingsJson -Encoding UTF8
    Record-Action "Pruned ~/.ultron hooks (backup: $backupFile)"
}

# ----------------------------------------------------------------------
# 2) Remove autostart registry entry
# ----------------------------------------------------------------------
Write-Section "Autostart"
Invoke-Step "Remove HKCU Run autostart entry" {
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $props = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
    if (-not $props) {
        Record-Skip "no Run key"
        return
    }
    $removed = 0
    foreach ($name in @($props.PSObject.Properties.Name)) {
        if ($name -match "^ULTRON") {
            if ($DryRun) {
                Record-Action "[dry] would remove Run\$name"
            } else {
                Remove-ItemProperty -Path $runKey -Name $name -ErrorAction Stop
                Record-Action "Removed Run\$name"
            }
            $removed++
        }
    }
    if ($removed -eq 0) { Record-Skip "no ULTRON* entries in Run key" }
}

# ----------------------------------------------------------------------
# 3) Remove scheduled tasks
# ----------------------------------------------------------------------
Write-Section "Scheduled tasks"
Invoke-Step "Delete schtasks named ULTRON*" {
    $tasks = @()
    try {
        $tasks = Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -match "^ULTRON" }
    } catch {
        Record-Skip "Get-ScheduledTask unavailable"
        return
    }
    if (-not $tasks -or $tasks.Count -eq 0) {
        Record-Skip "no ULTRON* scheduled tasks"
        return
    }
    foreach ($t in $tasks) {
        if ($DryRun) {
            Record-Action "[dry] would delete $($t.TaskName)"
            continue
        }
        try {
            Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction Stop
            Record-Action "Deleted $($t.TaskName)"
        } catch {
            Record-Fail "delete $($t.TaskName) — $($_.Exception.Message)"
        }
    }
}

# ----------------------------------------------------------------------
# 4) Remove Start Menu / Desktop shortcuts
# ----------------------------------------------------------------------
Write-Section "Shortcuts"
Invoke-Step "Remove ULTRON shortcuts" {
    $shortcutRoots = @(
        [Environment]::GetFolderPath("Desktop"),
        (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs")
    )
    $any = $false
    foreach ($root in $shortcutRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $items = Get-ChildItem -LiteralPath $root -Filter "ULTRON*.lnk" -ErrorAction SilentlyContinue
        foreach ($item in $items) {
            $any = $true
            if ($DryRun) {
                Record-Action "[dry] would remove $($item.FullName)"
            } else {
                Remove-Item -LiteralPath $item.FullName -Force
                Record-Action "Removed $($item.FullName)"
            }
        }
    }
    if (-not $any) { Record-Skip "no ULTRON shortcuts found" }
}

# ----------------------------------------------------------------------
# 5) Remove ~/.ultron/
# ----------------------------------------------------------------------
Write-Section "Install root"
Invoke-Step "Remove $Script:UltronHome" {
    if (-not (Test-Path -LiteralPath $Script:UltronHome)) {
        Record-Skip "~/.ultron/ not present"
        return
    }
    if ($DryRun) {
        Record-Action "[dry] would remove $Script:UltronHome"
        return
    }
    if ($KeepBackups) {
        $ts = Get-Date -Format "yyyyMMdd-HHmm"
        $renamed = Join-Path $env:USERPROFILE ".ultron-removed-$ts"
        Move-Item -LiteralPath $Script:UltronHome -Destination $renamed -Force
        Record-Action "Moved to $renamed (kept for rollback)"
        return
    }
    Remove-Item -LiteralPath $Script:UltronHome -Recurse -Force
    Record-Action "Deleted $Script:UltronHome"
}

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
Write-Section "Summary"
Write-Host "  Actions:  $($Script:Actions.Count)"
Write-Host "  Skipped:  $($Script:Skipped.Count)"
Write-Host "  Failures: $($Script:Failures.Count)" -ForegroundColor $(if ($Script:Failures.Count -gt 0) { 'Yellow' } else { 'Green' })

if ($Script:Failures.Count -gt 0) {
    Write-Host ""
    Write-Host "  Some steps failed. ULTRON may be partially removed." -ForegroundColor Yellow
    foreach ($f in $Script:Failures) { Write-Host "    - $f" -ForegroundColor Yellow }
    exit 1
}

Write-Host ""
Write-Host "  Done. Your Claude Code skills in ~/.claude/skills/ are intact." -ForegroundColor Green
Write-Host "  If you cloned the ultron repo somewhere, delete that directory manually." -ForegroundColor DarkGray
