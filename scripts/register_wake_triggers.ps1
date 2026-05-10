# ULTRON v11.0 â€” register_wake_triggers.ps1
# Adds "On workstation unlock" and "On system resume" triggers to all ULTRON
# once-per-day/once-per-weekday tasks, so they fire whenever the laptop wakes â€”
# not just on fresh login. Idempotent: safe to re-run; won't duplicate triggers.
#
# Trigger strategy:
#   1. SessionStateChange (unlock) â€” fires when user unlocks screen after sleep
#   2. EventTrigger (power resume) â€” fires when system wakes from S3/S4 sleep
# Both inherit the same Delay as the existing logon trigger.
# The should_run_today() marker in each script prevents duplicate runs same day.
#
# Run: pwsh -File scripts/register_wake_triggers.ps1
# Or:  ultron schedule install  (calls this automatically when enabled)
#
# Requires: Windows PowerShell 5.1+ or PowerShell 7+, elevation not required
# but Task Scheduler service must be running.

[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Force,      # Add triggers even if they seem present already
    [switch]$DryRun      # Show what would change without modifying tasks
)

$ErrorActionPreference = 'Stop'

# â”€â”€ Which tasks get wake triggers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# All ULTRON tasks that use "once per day/weekday" semantics (not every_10_min/every_hour/on_login-only)
$TARGET_TASKS = @(
    'UltronNewsScraper-Daily',
    'UltronStandup-Weekday',
    'UltronRetention-Daily',
    'UltronResearch-Weekly',
    'UltronNewsletter-Weekly',
    'UltronGithubTrending-Daily'   # v11 new
)

# â”€â”€ Power resume event query (System log, Kernel-Power EventID=1) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# ID=1 = POWERSCHEMEPERSONALITY_OTHER = wake from sleep; fires ~1s after resume.
$POWER_EVENT_QUERY = @'
<QueryList>
  <Query Id="0" Path="System">
    <Select Path="System">
      *[System[Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=1)]]
    </Select>
  </Query>
</QueryList>
'@

function Get-LogonDelay {
    param([Microsoft.Management.Infrastructure.CimInstance[]]$Triggers)
    foreach ($t in $Triggers) {
        if ($t.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') {
            if ($t.Delay) { return $t.Delay }   # e.g. "PT8M"; skip null/empty
        }
    }
    return 'PT2M'  # safe fallback (also covers tasks with no delay set)
}

function Has-TriggerOfClass {
    param([Microsoft.Management.Infrastructure.CimInstance[]]$Triggers, [string]$ClassName, [string]$QuerySubstr = '')
    foreach ($t in $Triggers) {
        if ($t.CimClass.CimClassName -eq $ClassName) {
            if (-not $QuerySubstr -or ($t.Subscription -and $t.Subscription -like "*$QuerySubstr*")) {
                return $true
            }
        }
    }
    return $false
}

function Add-WakeTriggersToTask {
    param([string]$TaskName)

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Host "  [skip] $TaskName not found in Task Scheduler" -ForegroundColor Yellow
        return
    }

    $delay = Get-LogonDelay $task.Triggers
    $changed = $false

    # â”€â”€ 1. SessionStateChange (workstation unlock) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    $hasUnlock = Has-TriggerOfClass $task.Triggers 'MSFT_TaskSessionStateChangeTrigger'
    if (-not $hasUnlock -or $Force) {
        if ($DryRun) {
            Write-Host "  [dry] $TaskName : would add SessionStateChange (unlock, delay=$delay)"
        } else {
            $unlockTrigger = New-CimInstance -Namespace Root/Microsoft/Windows/TaskScheduler `
                -ClassName MSFT_TaskSessionStateChangeTrigger -ClientOnly `
                -Property @{
                    StateChange = [uint32]8   # TASK_SESSION_STATE_CHANGE_TYPE.TASK_SESSION_UNLOCK = 8
                    UserId      = "$env:COMPUTERNAME\$env:USERNAME"
                    Delay       = $delay
                    Enabled     = $true
                }
            $task.Triggers += $unlockTrigger
            $changed = $true
            Write-Host "  [+] $TaskName : SessionStateChange (unlock, delay=$delay)" -ForegroundColor Green
        }
    } else {
        Write-Host "  [ok] $TaskName : SessionStateChange already present"
    }

    # â”€â”€ 2. EventTrigger (system resume from sleep) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    $hasResume = Has-TriggerOfClass $task.Triggers 'MSFT_TaskEventTrigger' 'Kernel-Power'
    if (-not $hasResume -or $Force) {
        if ($DryRun) {
            Write-Host "  [dry] $TaskName : would add EventTrigger (power resume, delay=$delay)"
        } else {
            $resumeTrigger = New-CimInstance -Namespace Root/Microsoft/Windows/TaskScheduler `
                -ClassName MSFT_TaskEventTrigger -ClientOnly `
                -Property @{
                    Subscription = $POWER_EVENT_QUERY
                    Delay        = $delay
                    Enabled      = $true
                }
            $task.Triggers += $resumeTrigger
            $changed = $true
            Write-Host "  [+] $TaskName : EventTrigger (power resume, delay=$delay)" -ForegroundColor Green
        }
    } else {
        Write-Host "  [ok] $TaskName : EventTrigger (power resume) already present"
    }

    if ($changed) {
        Set-ScheduledTask -InputObject $task | Out-Null
        Write-Host "  [saved] $TaskName" -ForegroundColor Cyan
    }
}

# â”€â”€ GithubTrending-Daily: register the task itself if missing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Register-GithubTrendingTask {
    $taskName = 'UltronGithubTrending-Daily'
    if ((Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        Write-Host "[$taskName] already registered"
        return
    }

    $skillRoot = Split-Path $PSScriptRoot -Parent
    $uvCmd = Get-Command uv -ErrorAction SilentlyContinue
    $uvExe = if ($uvCmd) { $uvCmd.Source } else { $null }
    if (-not $uvExe) {
        $uvExe = "$env:USERPROFILE\.local\bin\uv.exe"
        if (-not (Test-Path $uvExe)) {
            Write-Warning "uv not found - GithubTrending task will use python directly"
            $uvExe = 'python'
        }
    }

    $scriptPath  = Join-Path $skillRoot 'scripts\cockpit\github_trending.py'
    if ($uvExe -eq 'python') {
        $action = New-ScheduledTaskAction -Execute $uvExe -Argument ('"' + $scriptPath + '" --from-cron')
    } else {
        $argStr = 'run python "' + $scriptPath + '" --from-cron'
        $action = New-ScheduledTaskAction -Execute $uvExe -Argument $argStr -WorkingDirectory $skillRoot
    }

    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$env:USERNAME"

    $settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
        -StartWhenAvailable `
        -RunOnlyIfNetworkAvailable `
        -MultipleInstances IgnoreNew

    if ($DryRun) {
        Write-Host "  [dry] Would register $taskName"
        return
    }

    Register-ScheduledTask -TaskName $taskName `
        -Action $action -Trigger $logonTrigger `
        -Settings $settings `
        -RunLevel Limited -Force | Out-Null

    Write-Host "  [+] Registered $taskName (logon trigger, delay added by wake step)" -ForegroundColor Green
}

# â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

Write-Host "ULTRON v11 - Register wake triggers" -ForegroundColor Cyan
Write-Host "Mode: $(if ($DryRun) { 'DRY RUN' } else { 'LIVE' })" -ForegroundColor $(if ($DryRun) { 'Yellow' } else { 'Green' })
Write-Host ""

Write-Host "[1/2] Ensuring GithubTrending task exists..."
Register-GithubTrendingTask

Write-Host ""
Write-Host "[2/2] Adding wake triggers to daily/weekly tasks..."
foreach ($name in $TARGET_TASKS) {
    try {
        Add-WakeTriggersToTask -TaskName $name
    } catch {
        Write-Warning "  [WARN] $name : wake trigger add failed (will retry next run): $($_.Exception.Message)"
    }
}

Write-Host ""
if ($DryRun) {
    Write-Host "Dry run complete. Re-run without -DryRun to apply." -ForegroundColor Yellow
} else {
    Write-Host "Done. Wake triggers active. Tasks will now fire on:" -ForegroundColor Cyan
    Write-Host "  - Screen unlock (wake from sleep with locked screen)"
    Write-Host "  - System resume (wake from S3/S4 hibernate)"
    Write-Host "  - Login (existing trigger, unchanged)"
    Write-Host "  Daily marker guards (should_run_today) prevent duplicate runs same day."
}
