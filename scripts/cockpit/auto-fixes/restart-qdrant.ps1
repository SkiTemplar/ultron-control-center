# auto-fixes/restart-qdrant.ps1
# Restarts the local Qdrant container if it's unhealthy. We prefer the
# Docker container path (most common setup) and fall back to invoking
# scripts/hooks/ensure-qdrant.ps1 which knows about the native binary
# fallback used on some installs.

$ErrorActionPreference = "Stop"
$report = [ordered]@{
    fix     = "restart-qdrant"
    actions = @()
    success = $false
    error   = $null
}

try {
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if ($docker) {
        # Find any running or stopped qdrant container.
        $cid = (& docker ps -a --filter "ancestor=qdrant/qdrant" --format "{{.ID}}" 2>$null) `
            | Where-Object { $_ } `
            | Select-Object -First 1
        if ($cid) {
            $report.actions += "docker restart $cid"
            & docker restart $cid | Out-Null
            $report.success = $LASTEXITCODE -eq 0
        }
    }
    if (-not $report.success) {
        # Fallback: hand off to the ensure-qdrant hook, which already
        # handles the "container missing -> recreate / native start"
        # branches.
        $ensure = Join-Path $HOME ".ultron\scripts\hooks\ensure-qdrant.ps1"
        if (Test-Path -LiteralPath $ensure) {
            $report.actions += "ensure-qdrant.ps1"
            & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ensure | Out-Null
            $report.success = $LASTEXITCODE -eq 0
        } else {
            $report.error = "no docker qdrant container and ensure-qdrant.ps1 missing"
        }
    }
} catch {
    $report.error = $_.Exception.Message
}

[pscustomobject]$report | ConvertTo-Json -Compress
