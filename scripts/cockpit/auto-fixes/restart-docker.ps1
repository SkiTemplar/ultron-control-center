# auto-fixes/restart-docker.ps1
# Restarts the Docker Desktop service (com.docker.service) and, if that
# isn't present, falls back to starting the Docker Desktop GUI. We
# don't try to kill running containers — the service restart will do
# that for us.
#
# Triggered when Qdrant is down AND Docker is also down (the modal in
# Control Center suggests this fix automatically in that case).

$ErrorActionPreference = "Stop"
$report = [ordered]@{
    fix     = "restart-docker"
    actions = @()
    success = $false
    error   = $null
}

try {
    $svc = Get-Service -Name "com.docker.service" -ErrorAction SilentlyContinue
    if ($svc) {
        $report.actions += "Restart-Service com.docker.service"
        Restart-Service -Name "com.docker.service" -Force -ErrorAction Stop
        # Give the daemon a few seconds to come up before we declare success.
        Start-Sleep -Seconds 5
        $report.success = $true
    } else {
        $exe = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
        if (Test-Path -LiteralPath $exe) {
            $report.actions += "Start Docker Desktop.exe"
            Start-Process -FilePath $exe -ErrorAction Stop
            $report.success = $true
        } else {
            $report.error = "Docker service not installed and Docker Desktop.exe not found"
        }
    }
} catch {
    $report.error = $_.Exception.Message
}

[pscustomobject]$report | ConvertTo-Json -Compress
