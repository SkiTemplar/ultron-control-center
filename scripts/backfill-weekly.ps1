# backfill-weekly.ps1 - re-ejecuta el backfill de project_id (label propagation)
#
# (2026-07-13, decision del usuario: tarea programada semanal.) El corpus
# AMBIENTE (project_id NULL) va ganandose etiqueta segun crece el corpus
# etiquetado: cada item que un run etiqueta se vuelve vecino votante del
# siguiente. Umbral 0.90 + share 0.6 (conservador, calibrado con muestra:
# etiqueta mal puesta es PEOR que NULL).
#
# Registrado como scheduled task 'UltronBackfillProjects' (domingo 05:00).
# Log: ~/.ultron/logs/backfill-weekly.jsonl (append, una linea JSON por run).
# ASCII puro (PS 5.1). Exit 0 siempre: un fallo del backfill no debe marcar
# la tarea como rota; el error queda en el log.

$ErrorActionPreference = 'Stop'
$ultron = Join-Path $env:USERPROFILE '.ultron'
$bin = Join-Path $ultron 'bin\ultron-memory.exe'
$logDir = Join-Path $ultron 'logs'
$log = Join-Path $logDir 'backfill-weekly.jsonl'

try {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
    if (-not (Test-Path $bin)) { throw "ultron-memory.exe ausente en $bin" }
    $out = & $bin backfill-projects --apply 2>$null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    Add-Content -Path $log -Value ('{"ts":"' + $stamp + '","result":' + ($out -join '') + '}') -Encoding utf8
} catch {
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $msg = ($_.Exception.Message -replace '"', "'")
    try { Add-Content -Path $log -Value ('{"ts":"' + $stamp + '","error":"' + $msg + '"}') -Encoding utf8 } catch {}
}
exit 0
