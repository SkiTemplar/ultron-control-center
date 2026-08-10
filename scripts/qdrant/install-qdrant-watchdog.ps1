param(
    [ValidateSet('install', 'uninstall', 'status', 'run-now')]
    [string]$Action = 'install',

    [int]$IntervalMinutes = 5
)

# install-qdrant-watchdog.ps1 - registra/retira la tarea ULTRON-QdrantWatchdog:
# healthz + relaunch de Qdrant cada N minutos (audit 2026-08-09: nada vigilaba
# Qdrant entre logons y las caidas recurrentes dejaban el recall denso muerto
# en silencio). ASCII puro (compat PS 5.1). Sin admin: corre como usuario.
#
# Patron identico a install-qdrant-bootcheck.ps1: wscript + VBS para vbHide
# (cero flash de consola, importante en sesiones fullscreen).
#
# Uso:
#   .\install-qdrant-watchdog.ps1 install      # default (5 min)
#   .\install-qdrant-watchdog.ps1 uninstall
#   .\install-qdrant-watchdog.ps1 status
#   .\install-qdrant-watchdog.ps1 run-now

$ErrorActionPreference = 'Stop'

$taskName  = 'ULTRON-QdrantWatchdog'
$qdrantDir = "$env:USERPROFILE\.ultron\scripts\qdrant"
$watchdog  = Join-Path $qdrantDir 'qdrant-watchdog.ps1'
$vbsWrap   = Join-Path $qdrantDir 'qdrant-watchdog-hidden.vbs'

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
        if (-not (Test-Path $watchdog)) { throw "qdrant-watchdog.ps1 not found at $watchdog" }
        if (-not (Test-Path $vbsWrap))  { throw "qdrant-watchdog-hidden.vbs not found at $vbsWrap" }

        $taskAction = New-ScheduledTaskAction `
            -Execute 'wscript.exe' `
            -Argument "`"$vbsWrap`""

        # Repeticion: arranca en el proximo minuto y repite cada N min
        # "indefinidamente" (PS 5.1 no acepta MaxValue: 3650 dias es el idioma).
        $taskTrigger = New-ScheduledTaskTrigger `
            -Once -At (Get-Date).AddMinutes(1) `
            -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
            -RepetitionDuration (New-TimeSpan -Days 3650)

        $taskSettings = New-ScheduledTaskSettingsSet `
            -StartWhenAvailable `
            -DontStopIfGoingOnBatteries `
            -AllowStartIfOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
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
            -Description 'ULTRON - watchdog periodico de Qdrant: healthz cada 5 min y relaunch via ensure-qdrant si esta caido. Nunca mata el proceso (lock RocksDB).' | Out-Null

        Write-Host "Task '$taskName' registered."
        Write-Host "Trigger:  cada $IntervalMinutes min (repeticion indefinida)"
        Write-Host "Action:   wscript.exe qdrant-watchdog-hidden.vbs (sin flash)"
        Write-Host "Log:      ~\.ultron\logs\qdrant-watchdog.jsonl (solo eventos)"
        Write-Host ""
        Write-Host "Test now:   .\install-qdrant-watchdog.ps1 run-now"
        Write-Host "Remove:     .\install-qdrant-watchdog.ps1 uninstall"
        exit 0
    }
}
