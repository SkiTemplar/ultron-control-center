param(
    [ValidateSet('install', 'uninstall', 'status', 'run-now')]
    [string]$Action = 'install',

    [int]$IntervalHours = 6
)

# install-memory-gc.ps1 - registra/retira la tarea ULTRON-MemoryGC: lanza
# hooks/scripts/memory-gc.js --scheduled cada N horas. El script decide si toca
# (cadencia semanal y backoff tras fallos); casi siempre sale en milisegundos.
#
# Por que (2026-11-14): el hook de SessionEnd es async y Sessions cierra el Job
# Object del PTY (KILL_ON_JOB_CLOSE) en cuanto Claude sale. Cuando el gc tocaba
# de verdad, moria a medias sin dejar rastro: vencido desde el 2026-11-13 y sin
# ejecutarse en tres cierres seguidos. Una tarea programada corre fuera de
# cualquier Job. ASCII puro (compat PS 5.1). Sin admin: corre como usuario.
#
# Uso:
#   .\install-memory-gc.ps1 install      # default (cada 6 h)
#   .\install-memory-gc.ps1 uninstall
#   .\install-memory-gc.ps1 status
#   .\install-memory-gc.ps1 run-now

$ErrorActionPreference = 'Stop'

$taskName = 'ULTRON-MemoryGC'
$ultron   = "$env:USERPROFILE\.ultron"
$hook     = Join-Path $ultron 'hooks\scripts\memory-gc.js'
$vbsWrap  = Join-Path $ultron 'scripts\memory-gc-hidden.vbs'

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
        if (-not (Test-Path $hook))    { throw "memory-gc.js not found at $hook" }
        if (-not (Test-Path $vbsWrap)) { throw "memory-gc-hidden.vbs not found at $vbsWrap" }

        $taskAction = New-ScheduledTaskAction `
            -Execute 'wscript.exe' `
            -Argument "`"$vbsWrap`""

        # Arranca en 5 min y repite cada N horas "indefinidamente" (PS 5.1 no
        # acepta MaxValue: 3650 dias es el idioma). StartWhenAvailable recupera
        # la ejecucion perdida si el PC estaba apagado.
        $taskTrigger = New-ScheduledTaskTrigger `
            -Once -At (Get-Date).AddMinutes(5) `
            -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) `
            -RepetitionDuration (New-TimeSpan -Days 3650)

        $taskSettings = New-ScheduledTaskSettingsSet `
            -StartWhenAvailable `
            -DontStopIfGoingOnBatteries `
            -AllowStartIfOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
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
            -Description 'ULTRON - mantenimiento semanal de brain.db (hooks/scripts/memory-gc.js --scheduled). El script aplica la cadencia y el backoff; esta tarea solo garantiza que corre fuera del Job Object de Sessions.' | Out-Null

        Write-Host "Task '$taskName' registered."
        Write-Host "Trigger:  cada $IntervalHours h (repeticion indefinida)"
        Write-Host "Action:   wscript.exe memory-gc-hidden.vbs (sin flash)"
        Write-Host "Log:      ~\.ultron\logs\memory-gc.jsonl (trigger:scheduled)"
        Write-Host ""
        Write-Host "Test now:   .\install-memory-gc.ps1 run-now"
        Write-Host "Remove:     .\install-memory-gc.ps1 uninstall"
        exit 0
    }
}
