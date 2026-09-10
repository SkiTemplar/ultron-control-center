# ensure-qdrant.ps1 - Guard de arranque: garantiza que Qdrant nativo este vivo.
# Pensado para SessionStart de Claude Code. ASCII puro (compat PS 5.1).
# Si el puerto 6333 no escucha, relanza qdrant.exe desde su dir (config/storage local).
# v2: tras confirmar que el puerto escucha, valida salud real via GET /healthz.
# v3 (2026-09-10, frente 5): el relanzamiento fallaba el 78% de las veces sin
# rastro diagnosticable (logs/qdrant-watchdog.jsonl: down=35 recovered=8
# still_down=28). Causa raiz sospechada: Start-Process -WindowStyle Hidden
# descarta el stdout de qdrant.exe (el binario loguea ahi, no a fichero), asi
# que un arranque fallido no dejaba ninguna pista. Este cambio anade:
#   - snapshot de procesos qdrant.exe vivos ANTES de lanzar (un proceso vivo
#     sin puerto abierto es la hipotesis principal: arrancando o colgado con
#     el lock de RocksDB) -> logs/qdrant-launch.jsonl
#   - stdout/stderr del proceso lanzado redirigidos a fichero (antes se
#     tiraban) -> logs/qdrant.stdout.log / logs/qdrant.stderr.log
#   - margen de espera del puerto ampliado de ~6s a 20s
#   - si el proceso termina durante la espera, se registra exit code + cola
#     de stderr como evento 'launch_failed'
# Nota PS 5.1: -WindowStyle Hidden y -RedirectStandardOutput/-RedirectStandardError
# SI combinan en Start-Process (verificado en runtime, PSVersion 5.1.26100.9168).
# La incompatibilidad real de Start-Process es -WindowStyle vs -NoNewWindow
# (mutuamente excluyentes entre si), no -WindowStyle vs redireccion.

$ErrorActionPreference = 'SilentlyContinue'
$port         = 6333
$healthzUrl   = 'http://localhost:6333/healthz'
$httpTimeout  = 4   # segundos; corto para no bloquear SessionStart
$logDir       = "$env:USERPROFILE\.ultron\logs"
$launchLog    = Join-Path $logDir 'qdrant-launch.jsonl'
$stdoutLog    = Join-Path $logDir 'qdrant.stdout.log'
$stderrLog    = Join-Path $logDir 'qdrant.stderr.log'
$maxLogKB     = 512
$portWaitSec  = 20
$portPollMs   = 500

# ---------------------------------------------------------------------------
# Helper: prueba HTTP GET /healthz con timeout corto. Devuelve $true si 200.
# ---------------------------------------------------------------------------
function Test-QdrantHealthz {
    try {
        $r = Invoke-WebRequest -Uri $healthzUrl -UseBasicParsing `
                 -TimeoutSec $httpTimeout -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

# ---------------------------------------------------------------------------
# Helper: cuenta cuantos sockets escuchan en $port ahora mismo.
# ---------------------------------------------------------------------------
function Get-PortListenCount {
    return (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Measure-Object).Count
}

# ---------------------------------------------------------------------------
# Helper: trunca un fichero de log si supera $maxLogKB, conservando la cola.
# ---------------------------------------------------------------------------
function Limit-LogFile {
    param([string]$Path)
    if (Test-Path $Path) {
        $sizeKB = (Get-Item $Path).Length / 1KB
        if ($sizeKB -gt $maxLogKB) {
            $tail = Get-Content $Path -Tail 200
            Set-Content -Path $Path -Value $tail -Encoding utf8
        }
    }
}

# ---------------------------------------------------------------------------
# Helper: escribe un evento JSON en logs/qdrant-launch.jsonl (log acotado).
# ---------------------------------------------------------------------------
function Write-LaunchEvent {
    param([string]$EventName, [System.Collections.IDictionary]$Detail)
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    Limit-LogFile -Path $launchLog
    $rec = [ordered]@{
        ts    = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')
        event = $EventName
    }
    foreach ($key in $Detail.Keys) { $rec[$key] = $Detail[$key] }
    $json = $rec | ConvertTo-Json -Compress -Depth 6
    Add-Content -Path $launchLog -Value $json -Encoding utf8
}

$listening = Get-PortListenCount

if ($listening -eq 0) {
    # Canonical path overridable via ULTRON_QDRANT_EXE / ULTRON_QDRANT_DIR
    # (same contract as lib.rs spawn_qdrant_exe). Fallback chain: instalacion
    # real en D:\Ultron\qdrant, luego el default portable qdrant-native.
    if ($env:ULTRON_QDRANT_EXE) { $exe = $env:ULTRON_QDRANT_EXE }
    elseif (Test-Path "D:\Ultron\qdrant\qdrant.exe") { $exe = "D:\Ultron\qdrant\qdrant.exe" }
    else { $exe = "$env:USERPROFILE\.ultron\qdrant-native\qdrant.exe" }
    if ($env:ULTRON_QDRANT_DIR) { $wd = $env:ULTRON_QDRANT_DIR } else { $wd = Split-Path -Parent $exe }

    # --- Diagnostico pre-lanzamiento: procesos qdrant.exe ya vivos --------
    # Un proceso vivo con el puerto sin escuchar es la hipotesis principal
    # del 78% de relanzamientos fallidos: o esta en warm-up, o quedo colgado
    # reteniendo el lock de RocksDB (que impide a un segundo proceso servir).
    $existingProcs = @(Get-Process -Name 'qdrant' -ErrorAction SilentlyContinue)
    $procSnapshot = @()
    foreach ($proc in $existingProcs) {
        $startTimeStr = $null
        try { $startTimeStr = $proc.StartTime.ToString('yyyy-MM-ddTHH:mm:ssK') } catch {}
        $procSnapshot += [ordered]@{ id = $proc.Id; startTime = $startTimeStr }
    }
    Write-LaunchEvent -EventName 'pre_launch' -Detail ([ordered]@{
        port_listening = $false
        proc_count     = $existingProcs.Count
        existing_procs = $procSnapshot
        exe            = $exe
    })

    if (Test-Path $exe) {
        Limit-LogFile -Path $stdoutLog
        Limit-LogFile -Path $stderrLog

        $proc = Start-Process -FilePath $exe -WorkingDirectory $wd -WindowStyle Hidden `
                    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru

        # Espera hasta 20s a que abra el puerto (poll cada 500ms). Corta antes
        # si el proceso ya ha terminado: no tiene sentido seguir esperando.
        $portOpen = $false
        $waited   = 0
        $maxTicks = [int]([Math]::Ceiling(($portWaitSec * 1000) / $portPollMs))
        for ($i = 0; $i -lt $maxTicks; $i++) {
            Start-Sleep -Milliseconds $portPollMs
            $waited += $portPollMs
            if ((Get-PortListenCount) -gt 0) { $portOpen = $true; break }
            if ($proc.HasExited) { break }
        }

        if ($portOpen) {
            Write-Output "ensure-qdrant: Qdrant relanzado en puerto $port"
        } elseif ($proc.HasExited) {
            # Get-Content -Tail en PS 5.1 decora uno de los strings devueltos
            # con NoteProperties de fichero (PSPath, PSDrive, PSProvider...);
            # sin el .ToString() ConvertTo-Json vuelca el arbol de tipos
            # completo (decenas de KB de basura) en vez de la linea de texto.
            $stderrTail = @()
            if (Test-Path $stderrLog) {
                $stderrTail = @(Get-Content $stderrLog -Tail 20 | ForEach-Object { $_.ToString() })
            }
            Write-LaunchEvent -EventName 'launch_failed' -Detail ([ordered]@{
                exit_code   = $proc.ExitCode
                waited_ms   = $waited
                stderr_tail = $stderrTail
            })
            # NOTA (verificado en runtime, PS 5.1.26100.9168): con
            # -RedirectStandardOutput/-RedirectStandardError, $proc.ExitCode
            # via -PassThru puede quedar $null aunque HasExited sea $true
            # (reproducido incluso con un .exe nativo real, no solo el stub
            # .cmd de prueba) -- WaitForExit()+Refresh() no lo arregla. Se
            # muestra 'desconocido' en vez de un hueco en blanco.
            $exitCodeText = if ($null -eq $proc.ExitCode) { 'desconocido' } else { $proc.ExitCode }
            Write-Output "ensure-qdrant: WARN qdrant.exe termino durante el arranque (exit code $exitCodeText); ver $stderrLog"
        } else {
            Write-LaunchEvent -EventName 'launch_failed' -Detail ([ordered]@{
                exit_code   = $null
                waited_ms   = $waited
                detail      = 'proceso sigue vivo pero el puerto no abrio dentro del margen'
            })
            Write-Output "ensure-qdrant: WARN qdrant.exe sigue vivo pero el puerto $port no abrio tras ${portWaitSec}s"
        }
    } else {
        Write-Output "ensure-qdrant: WARN qdrant.exe no encontrado en $exe"
        exit 1
    }
} else {
    Write-Output "ensure-qdrant: Qdrant ya activo en puerto $port"
}

# ---------------------------------------------------------------------------
# Confirmacion de salud real: el puerto escucha, pero el proceso puede estar
# inicializando o en estado degradado. /healthz devuelve 200 solo cuando
# Qdrant esta listo para aceptar peticiones.
# ---------------------------------------------------------------------------
if (Test-QdrantHealthz) {
    Write-Output "ensure-qdrant: healthz OK -- Qdrant operativo"
    exit 0
} else {
    Write-Output "ensure-qdrant: WARN puerto $port escucha pero $healthzUrl no devolvio 200 (timeout ${httpTimeout}s)"
    exit 2
}
