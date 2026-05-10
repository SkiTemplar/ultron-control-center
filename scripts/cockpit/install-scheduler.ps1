# ULTRON v10.2 Cockpit - Windows Task Scheduler installer (config-driven)
#
# Reads ~/.ultron/cockpit/schedule-config.json and creates Task Scheduler tasks
# that ALL fire AT LOGIN (with staggered delays). Daily/weekly tasks have a
# Python-side guard (should_run.py + marker file) so they only do real work
# once per period - safe to fire on every login.
#
# Why: PC may be off at scheduled times (night, weekends). AtLogOn ensures
# tasks catch up when USER turns on the PC.
#
# Frequency types from config:
#   on_login             -> AtLogOn, runs every login
#   every_10_minutes     -> AtLogOn + RepetitionInterval 10min
#   every_hour           -> AtLogOn + RepetitionInterval 1h
#   once_per_day         -> AtLogOn (script guards via marker)
#   once_per_weekday     -> AtLogOn (script guards: weekday + marker)
#   once_per_week_sunday -> AtLogOn (script guards: Sunday onwards + marker)
#
# Run: powershell -ExecutionPolicy Bypass -File install-scheduler.ps1
#      powershell -File install-scheduler.ps1 -Status
#      powershell -File install-scheduler.ps1 -Uninstall

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Status
)

$ErrorActionPreference = "Stop"

# -- Paths --------------------------------------------------------------------
$ConfigPath = Join-Path $env:USERPROFILE ".ultron\cockpit\schedule-config.json"
$LogDir     = Join-Path $env:USERPROFILE ".ultron\cockpit\scheduler-logs"

# Map task name -> python script path (relative to scripts/cockpit)
$ScriptMap = @{
    "ScanProjects-Login"   = "scan_projects.py"
    "Retention-Daily"      = "retention.py"
    "Standup-Weekday"      = "ai_standup.py"
    "Research-Weekly"      = "research.py"
    "GithubTrending-Daily" = "github_trending.py"
    "Doctor-Weekly"        = "doctor.py"
}
$TUITaskName = "TUI-Login"  # special: uses wt.exe not python+log redirect
$BackupTaskName = "Backup-Weekly"  # special: invokes ~/.ultron/scripts/backup/weekly-backup.ps1
$BackupScriptPath = Join-Path $env:USERPROFILE ".ultron\scripts\backup\weekly-backup.ps1"

# Task name prefix in Windows Task Scheduler
$TaskPrefix = "Ultron"

# -- Status --------------------------------------------------------------------
if ($Status) {
    Write-Host "[Cockpit] Scheduled tasks status:" -ForegroundColor Cyan
    $tasks = Get-ScheduledTask -TaskName "$TaskPrefix*" -ErrorAction SilentlyContinue
    if (-not $tasks) {
        Write-Host "  (no Ultron tasks installed - run without -Status to install)"
        return
    }
    foreach ($t in $tasks | Sort-Object TaskName) {
        $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -ErrorAction SilentlyContinue
        $lastRun = if ($info -and $info.LastRunTime -gt [datetime]"1900-01-01") { $info.LastRunTime } else { "never" }
        Write-Host ("  [{0}] {1,-32} LastRun: {2}" -f $t.State, $t.TaskName, $lastRun)
    }
    return
}

# -- Uninstall ----------------------------------------------------------------
if ($Uninstall) {
    $tasks = Get-ScheduledTask -TaskName "$TaskPrefix*" -ErrorAction SilentlyContinue
    if (-not $tasks) {
        Write-Host "[Cockpit] No Ultron tasks to uninstall."
        return
    }
    foreach ($t in $tasks) {
        Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false
        Write-Host "[Cockpit] Removed: $($t.TaskName)" -ForegroundColor Yellow
    }
    return
}

# -- Pre-checks ----------------------------------------------------------------
Write-Host "[Cockpit] Installing scheduled tasks (config-driven)..." -ForegroundColor Cyan

if (-not (Test-Path $ConfigPath)) {
    Write-Error "Config not found at: $ConfigPath. The default config should be at this path."
    exit 1
}

$config = Get-Content -Raw $ConfigPath -Encoding UTF8 | ConvertFrom-Json
Write-Host "[Cockpit] Config loaded from: $ConfigPath"

# Python in PATH
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $python) {
    Write-Error "Python not found in PATH."
    exit 1
}
$pythonExe = $python.Source

# Scripts present
foreach ($script in $ScriptMap.Values) {
    $p = Join-Path $PSScriptRoot $script
    if (-not (Test-Path $p)) {
        Write-Error "Script not found: $p"
        exit 1
    }
}
Write-Host "[Cockpit] Python: $pythonExe"
Write-Host "[Cockpit] All scripts present"

# Log dir
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# -- Remove existing Ultron tasks first (clean slate) -------------------------
$existing = Get-ScheduledTask -TaskName "$TaskPrefix*" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[Cockpit] Removing $($existing.Count) existing Ultron tasks before reinstall..."
    foreach ($t in $existing) {
        Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false
    }
}

# -- Common settings (StartWhenAvailable for catch-up after PC was off) -------
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

# -- Helper: build action - PowerShell hidden window, no CMD flash -------------
# -WindowStyle Hidden: no terminal visible. -NonInteractive: no prompts.
# Stdout+stderr redirected to log via Start-Transcript equivalent (Out-File append).
function New-PyAction([string]$scriptName, [string]$logName, [string]$extraArgs = "") {
    $scriptPath = Join-Path $PSScriptRoot $scriptName
    $logPath    = Join-Path $LogDir $logName
    $cmd = "& '$pythonExe' '$scriptPath' $extraArgs 2>&1 | Out-File -Append -Encoding utf8 '$logPath'"
    $argString = "-WindowStyle Hidden -NonInteractive -Command `"$cmd`""
    return New-ScheduledTaskAction -Execute "PowerShell.exe" `
                                    -Argument $argString `
                                    -WorkingDirectory $env:USERPROFILE
}

# -- Helper: build trigger from frequency -------------------------------------
function New-TriggerFromFrequency([string]$frequency, [int]$delayMin) {
    $delaySpec = "PT$($delayMin)M"

    # All triggers fire AT LOGIN; the script self-guards if it should skip.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $trigger.Delay = $delaySpec

    if ($frequency -eq "every_10_minutes") {
        $trigger.Repetition = (New-ScheduledTaskTrigger `
            -Once -At ([datetime]::Now) `
            -RepetitionInterval (New-TimeSpan -Minutes 10) `
            -RepetitionDuration ([TimeSpan]::FromDays(3650))).Repetition
    } elseif ($frequency -eq "every_hour") {
        $trigger.Repetition = (New-ScheduledTaskTrigger `
            -Once -At ([datetime]::Now) `
            -RepetitionInterval (New-TimeSpan -Hours 1) `
            -RepetitionDuration ([TimeSpan]::FromDays(3650))).Repetition
    }

    return $trigger
}

# -- Install each task from config --------------------------------------------
$installed = 0
$skipped = 0

foreach ($prop in $config.tasks.PSObject.Properties) {
    $taskShortName = $prop.Name
    $taskCfg       = $prop.Value
    $fullName      = "$TaskPrefix$taskShortName"

    if (-not $taskCfg.enabled) {
        Write-Host "[Cockpit] [SKIP disabled] $fullName" -ForegroundColor DarkGray
        $skipped++
        continue
    }

    $trigger = New-TriggerFromFrequency $taskCfg.frequency $taskCfg.delay_minutes

    # Special-case TUI-Login: launches Windows Terminal with the TUI inside, not python+log
    if ($taskShortName -eq "TUI-Login") {
        $tuiPath = Join-Path $PSScriptRoot "tui.py"
        $wtArgs  = "new-tab --title `"ULTRON Cockpit`" `"$pythonExe`" `"$tuiPath`""
        $action  = New-ScheduledTaskAction -Execute "wt.exe" `
                                           -Argument $wtArgs `
                                           -WorkingDirectory $env:USERPROFILE
    } elseif ($taskShortName -eq $BackupTaskName) {
        # v14.7 Backup: invoke weekly-backup.ps1 in ~/.ultron/scripts/backup/.
        # Script self-skips if D: drive is missing (exit 2). Logs go to its own dir.
        if (-not (Test-Path $BackupScriptPath)) {
            Write-Host "[Cockpit] [WARN] Backup script missing: $BackupScriptPath. Skipping $fullName."
            $skipped++
            continue
        }
        $logName  = "backup-weekly.log"
        $logPath  = Join-Path $LogDir $logName
        $bkCmd    = "& '$BackupScriptPath' 2>&1 | Out-File -Append -Encoding utf8 '$logPath'"
        $bkArgs   = "-ExecutionPolicy Bypass -WindowStyle Hidden -NonInteractive -Command `"$bkCmd`""
        $action   = New-ScheduledTaskAction -Execute "PowerShell.exe" `
                                            -Argument $bkArgs `
                                            -WorkingDirectory $env:USERPROFILE
    } else {
        if (-not $ScriptMap.ContainsKey($taskShortName)) {
            Write-Host "[Cockpit] [WARN] Unknown task in config: $taskShortName (no script mapping). Skipping."
            $skipped++
            continue
        }
        $scriptName = $ScriptMap[$taskShortName]
        $logName    = ($scriptName -replace "\.py$", ".log")
        # Pass --from-cron to scripts that have weekly/daily guards
        $extraArgs = ""
        if ($taskShortName -in @("Retention-Daily","Standup-Weekday","Research-Weekly","Doctor-Weekly")) {
            $extraArgs = "--from-cron"
        }
        $action = New-PyAction $scriptName $logName $extraArgs
    }

    Register-ScheduledTask -TaskName $fullName `
                           -Action $action `
                           -Trigger $trigger `
                           -Settings $settings `
                           -Principal $principal `
                           -Description "ULTRON Cockpit: $($taskCfg.description)" | Out-Null

    Write-Host ("[Cockpit] [INSTALL] {0,-32} login+{1,2}min - {2}" -f `
                $fullName, $taskCfg.delay_minutes, $taskCfg.frequency) -ForegroundColor Green
    $installed++
}

Write-Host ""
Write-Host "[Cockpit] Done. Installed: $installed - Skipped (disabled): $skipped" -ForegroundColor Cyan
Write-Host "[Cockpit] Verify: powershell -File install-scheduler.ps1 -Status"
Write-Host "[Cockpit] Edit config: notepad $ConfigPath  -> then re-run this installer"
