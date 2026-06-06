# ensure-qdrant.ps1 - Guard de arranque: garantiza que Qdrant nativo este vivo.
# Pensado para SessionStart de Claude Code. ASCII puro (compat PS 5.1).
# Si el puerto 6333 no escucha, relanza qdrant.exe desde su dir (config/storage local).
# v2: tras confirmar que el puerto escucha, valida salud real via GET /healthz.

$ErrorActionPreference = 'SilentlyContinue'
$port        = 6333
$healthzUrl  = 'http://localhost:6333/healthz'
$httpTimeout = 4   # segundos; corto para no bloquear SessionStart

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

$listening = (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Measure-Object).Count

if ($listening -eq 0) {
    $exe = "$env:USERPROFILE\.ultron\qdrant-native\qdrant.exe"
    $wd  = "$env:USERPROFILE\.ultron\qdrant-native"
    if (Test-Path $exe) {
        Start-Process -FilePath $exe -WorkingDirectory $wd -WindowStyle Hidden
        # Espera breve a que abra el puerto (max ~6s) para no devolver antes de tiempo.
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Milliseconds 500
            $now = (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Measure-Object).Count
            if ($now -gt 0) { break }
        }
        Write-Output "ensure-qdrant: Qdrant relanzado en puerto $port"
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
