param(
    [ValidateSet('install', 'uninstall', 'status', 'run-now')]
    [string]$Action = 'install',

    [int]$IntervalMinutes = 15
)

# install-bitacora-sweep.ps1 - registra/retira la tarea ULTRON-BitacoraSweep:
# barre TODOS los proyectos cada N minutos y resume las sesiones inactivas sin
# bitacora (scripts/bitacora-sweep.mjs). Diagnostico 2026-09-25: SessionEnd
# casi nunca dispara (el usuario cierra la ventana) y el fallback de
# SessionStart solo llega en el arranque SIGUIENTE del MISMO proyecto -> hasta
# 4 dias de retraso en proyectos que se retoman poco. ASCII puro (compat PS
# 5.1). Sin admin: corre como usuario.
#
# Patron identico a scripts/qdrant/install-qdrant-watchdog.ps1: wscript + VBS
# para vbHide (cero flash de consola).
#
# Uso:
#   .\install-bitacora-sweep.ps1 install      # default (15 min)
#   .\install-bitacora-sweep.ps1 uninstall
#   .\install-bitacora-sweep.ps1 status
#   .\install-bitacora-sweep.ps1 run-now

$ErrorActionPreference = 'Stop'

$taskName   = 'ULTRON-BitacoraSweep'
$scriptsDir = "$env:USERPROFILE\.ultron\scripts"
$sweep      = Join-Path $scriptsDir 'bitacora-sweep.mjs'
$vbsWrap    = Join-Path $scriptsDir 'bitacora-sweep-hidden.vbs'

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
        if (-not (Test-Path $sweep))   { throw "bitacora-sweep.mjs not found at $sweep" }
        if (-not (Test-Path $vbsWrap)) { throw "bitacora-sweep-hidden.vbs not found at $vbsWrap" }

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
            -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
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
            -Description 'ULTRON - barrido periodico de bitacoras: resume sesiones inactivas sin summary.md en todos los proyectos (scripts/bitacora-sweep.mjs). MultipleInstances IgnoreNew + lock propio del script: nunca se solapa.' | Out-Null

        Write-Host "Task '$taskName' registered."
        Write-Host "Trigger:  cada $IntervalMinutes min (repeticion indefinida)"
        Write-Host "Action:   wscript.exe bitacora-sweep-hidden.vbs (sin flash)"
        Write-Host "Log:      ~\.ultron\logs\session-summary.jsonl (trigger:sweep)"
        Write-Host ""
        Write-Host "Test now:   .\install-bitacora-sweep.ps1 run-now"
        Write-Host "Remove:     .\install-bitacora-sweep.ps1 uninstall"
        exit 0
    }
}
