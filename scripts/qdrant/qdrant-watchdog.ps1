# qdrant-watchdog.ps1 - watchdog periodico de Qdrant (tarea ULTRON-QdrantWatchdog).
# ASCII puro (compat PS 5.1). Corre cada ~5 min via wscript vbHide (sin flash).
#
# POR QUE (audit 2026-08-09): Qdrant se caia de forma recurrente (16
# ensure_failed en 2.5 meses) y NADA lo verificaba ni reparaba entre logons -
# los launchers eran fire-and-forget y solo corrian en logon/SessionStart.
# Con Qdrant caido el recall denso colapsaba en silencio (recall@8 0.823->0.151).
#
# REGLA DURA: NUNCA Stop-Process sobre qdrant (lock RocksDB = corrupcion).
# Este watchdog solo OBSERVA y RELANZA via el launcher canonico; jamas mata.
#
# Log: ~/.ultron/logs/qdrant-watchdog.jsonl (solo eventos: down/relaunch/
# recovered/still_down; los ticks sanos NO se loguean para no generar ruido).

$ErrorActionPreference = 'SilentlyContinue'
$healthzUrl = 'http://localhost:6333/healthz'
$launcher   = "$env:USERPROFILE\.ultron\scripts\ensure-qdrant.ps1"
$logDir     = "$env:USERPROFILE\.ultron\logs"
$logFile    = Join-Path $logDir 'qdrant-watchdog.jsonl'
$maxLogKB   = 512

function Test-Healthz {
    param([int]$TimeoutSec = 3)
    try {
        $r = Invoke-WebRequest -Uri $healthzUrl -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Write-Event {
    param([string]$EventName, [string]$Detail)
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    # Log acotado: si supera el limite, conserva las ultimas 200 lineas.
    if (Test-Path $logFile) {
        $sizeKB = (Get-Item $logFile).Length / 1KB
        if ($sizeKB -gt $maxLogKB) {
            $tail = Get-Content $logFile -Tail 200
            Set-Content -Path $logFile -Value $tail -Encoding utf8
        }
    }
    $rec = [ordered]@{
        ts     = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')
        event  = $EventName
        detail = $Detail
    } | ConvertTo-Json -Compress
    Add-Content -Path $logFile -Value $rec -Encoding utf8
}

# Tick sano: silencio total (0 escrituras, 0 ruido).
if (Test-Healthz) { exit 0 }

# Caido: relanzar via el launcher canonico (el de la raiz: NO mata procesos,
# respeta la cadena D:\Ultron\qdrant -> qdrant-native y valida healthz al final).
Write-Event -EventName 'down' -Detail 'healthz sin respuesta; disparando launcher'
if (-not (Test-Path $launcher)) {
    Write-Event -EventName 'launcher_missing' -Detail $launcher
    exit 1
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher | Out-Null

# Verificacion post-launch REAL (el fire-and-forget ciego era parte del bug):
# hasta ~30s de margen para el warm-up del binario.
$recovered = $false
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 3
    if (Test-Healthz -TimeoutSec 2) { $recovered = $true; break }
}
if ($recovered) {
    Write-Event -EventName 'recovered' -Detail ("healthz OK tras relaunch (~" + (($i + 1) * 3) + "s)")
    exit 0
} else {
    Write-Event -EventName 'still_down' -Detail 'healthz sigue sin responder tras relaunch + 30s'
    exit 2
}
