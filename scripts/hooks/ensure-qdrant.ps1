# ensure-qdrant.ps1 -- ULTRON MEMORY CORE D2
# Probes Qdrant at http://127.0.0.1:6333/healthz and launches
# D:\Ultron\qdrant\qdrant.exe if it is not running.
# PowerShell 5.1 compatible. ASCII only -- no smart quotes, no em-dashes.

$QdrantExe = "D:\Ultron\qdrant\qdrant.exe"
$QdrantDir = "D:\Ultron\qdrant"
$HealthUrl = "http://127.0.0.1:6333/healthz"
$TimeoutSec = 2

function Test-QdrantRunning {
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        return $resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300
    } catch {
        return $false
    }
}

Write-Host "[ensure-qdrant] Probing $HealthUrl ..."

if (Test-QdrantRunning) {
    Write-Host "[ensure-qdrant] Qdrant already running -- no action needed."
    exit 0
}

Write-Host "[ensure-qdrant] Qdrant not running. Attempting auto-launch."

if (-not (Test-Path $QdrantExe)) {
    Write-Warning "[ensure-qdrant] Exe not found at $QdrantExe -- start Qdrant manually."
    exit 1
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $QdrantExe
$psi.WorkingDirectory = $QdrantDir
$psi.CreateNoWindow = $true
$psi.UseShellExecute = $false
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

$proc = [System.Diagnostics.Process]::Start($psi)
if ($null -eq $proc) {
    Write-Warning "[ensure-qdrant] Failed to start process."
    exit 1
}
Write-Host "[ensure-qdrant] Spawned pid=$($proc.Id). Waiting 4s for port to bind..."

Start-Sleep -Seconds 4

if (Test-QdrantRunning) {
    Write-Host "[ensure-qdrant] Qdrant is now reachable at :6333."
    exit 0
} else {
    Write-Warning "[ensure-qdrant] Qdrant still not reachable after launch. Check logs in $QdrantDir."
    exit 1
}
