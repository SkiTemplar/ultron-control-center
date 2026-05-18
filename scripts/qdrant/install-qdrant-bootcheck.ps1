param(
    [ValidateSet('install', 'uninstall', 'status', 'run-now')]
    [string]$Action = 'install',

    [int]$DelaySeconds = 12
)

# install-qdrant-bootcheck.ps1 - register/unregister the ULTRON-QdrantBoot
# Windows scheduled task. Triggers ensure-qdrant.ps1 + qdrant-notify.ps1
# at user logon, so the WinForm appears within ~15s of arriving at the
# desktop (before Claude Code is even opened).
#
# Requirements: runs as current user, NO admin needed. Uses
# RegisterScheduledTask with -User $env:USERNAME and InteractiveToken so
# the task can show UI in the user's session.
#
# Usage:
#   .\install-qdrant-bootcheck.ps1 install      # default
#   .\install-qdrant-bootcheck.ps1 uninstall
#   .\install-qdrant-bootcheck.ps1 status
#   .\install-qdrant-bootcheck.ps1 run-now      # fire the task immediately

$ErrorActionPreference = 'Stop'

$taskName = 'ULTRON-QdrantBoot'
# v15.5.14: bootcheck files relocated from scripts/hooks/ (settings.json-wired)
# to scripts/qdrant/ (scheduled-task-wired) so the hooks dir stays a clean
# Claude-hooks surface. ensure-qdrant.ps1 stays in scripts/hooks/ because
# session-init.ps1 still calls it as a real Claude Code hook.
$hooksDir  = "$env:USERPROFILE\.ultron\scripts\hooks"
$qdrantDir = "$env:USERPROFILE\.ultron\scripts\qdrant"
$ensure    = Join-Path $hooksDir  'ensure-qdrant.ps1'
$notify    = Join-Path $qdrantDir 'qdrant-notify.ps1'
$vbsWrap   = Join-Path $qdrantDir 'qdrant-bootcheck-hidden.vbs'

switch ($Action) {

    'status' {
        $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $t) {
            Write-Host "Task '$taskName' NOT INSTALLED"
            exit 1
        }
        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
        Write-Host "Task '$taskName' state: $($t.State)"
        if ($info) {
            Write-Host "Last run: $($info.LastRunTime) | result: 0x$('{0:X}' -f $info.LastTaskResult)"
            Write-Host "Next run: $($info.NextRunTime)"
        }
        exit 0
    }

    'uninstall' {
        $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($t) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Write-Host "Task '$taskName' unregistered"
        } else {
            Write-Host "Task '$taskName' was not present"
        }
        exit 0
    }

    'run-now' {
        $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $t) {
            Write-Host "Task '$taskName' NOT INSTALLED. Run install first."
            exit 1
        }
        Start-ScheduledTask -TaskName $taskName
        Write-Host "Task '$taskName' triggered"
        exit 0
    }

    'install' {
        if (-not (Test-Path $ensure))  { throw "ensure-qdrant.ps1 not found at $ensure" }
        if (-not (Test-Path $notify))  { throw "qdrant-notify.ps1 not found at $notify" }
        if (-not (Test-Path $vbsWrap)) { throw "qdrant-bootcheck-hidden.vbs not found at $vbsWrap" }

        # Use wscript.exe + VBS wrapper so the powershell child process is
        # launched with vbHide (0). This prevents any console flash on
        # logon or run-now — important for fullscreen gaming sessions.
        $taskAction = New-ScheduledTaskAction `
            -Execute 'wscript.exe' `
            -Argument "`"$vbsWrap`""

        $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

        $taskSettings = New-ScheduledTaskSettingsSet `
            -StartWhenAvailable `
            -DontStopIfGoingOnBatteries `
            -AllowStartIfOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
            -MultipleInstances IgnoreNew `
            -Hidden

        $taskPrincipal = New-ScheduledTaskPrincipal `
            -UserId $env:USERNAME `
            -LogonType Interactive `
            -RunLevel Limited

        $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existing) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }

        Register-ScheduledTask `
            -TaskName $taskName `
            -Action $taskAction `
            -Trigger $taskTrigger `
            -Settings $taskSettings `
            -Principal $taskPrincipal `
            -Description 'ULTRON - check the native Qdrant binary on logon and show a retry panel if it is down. No Docker, no admin required.' | Out-Null

        Write-Host "Task '$taskName' registered."
        Write-Host "Trigger:  at logon of $env:USERNAME"
        Write-Host "Action:   wscript.exe qdrant-bootcheck-hidden.vbs (no console flash)"
        Write-Host "Chain:    sleep 12s -> ensure-qdrant -> sleep 1s -> qdrant-notify"
        Write-Host ""
        Write-Host "Test now:   .\install-qdrant-bootcheck.ps1 run-now"
        Write-Host "Inspect:    Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo"
        Write-Host "Remove:     .\install-qdrant-bootcheck.ps1 uninstall"
        exit 0
    }
}
