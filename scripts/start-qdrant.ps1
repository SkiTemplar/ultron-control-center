# start-qdrant.ps1 - arranca Qdrant en segundo plano si no esta ya corriendo.
# Idempotente: si ya hay un proceso qdrant, no hace nada. Sin ventana visible.
# Usado por: arranque manual y la tarea programada UltronQdrant (AtLogon).
$ErrorActionPreference = 'SilentlyContinue'

$exe = 'D:\Ultron\qdrant\qdrant.exe'
$cfg = 'D:\Ultron\qdrant\config.yaml'
$dir = 'D:\Ultron\qdrant'

if (-not (Test-Path $exe)) {
    Write-Output "qdrant.exe no encontrado en $exe"
    exit 1
}

$running = Get-Process qdrant -ErrorAction SilentlyContinue
if ($running) {
    Write-Output "Qdrant ya esta corriendo (PID $($running.Id))"
    exit 0
}

if (Test-Path $cfg) {
    Start-Process -FilePath $exe -ArgumentList '--config-path', $cfg -WorkingDirectory $dir -WindowStyle Hidden
} else {
    Start-Process -FilePath $exe -WorkingDirectory $dir -WindowStyle Hidden
}
Write-Output "Qdrant lanzado."
exit 0
