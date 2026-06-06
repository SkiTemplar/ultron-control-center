# ensure-qdrant.ps1 - Guard de arranque: garantiza que Qdrant nativo este vivo.
# Pensado para SessionStart de Claude Code. ASCII puro (compat PS 5.1).
# Si el puerto 6333 no escucha, relanza qdrant.exe desde su dir (config/storage local).

$ErrorActionPreference = 'SilentlyContinue'
$port = 6333
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
    }
} else {
    Write-Output "ensure-qdrant: Qdrant ya activo en puerto $port"
}
