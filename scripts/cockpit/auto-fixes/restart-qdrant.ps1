# auto-fixes/restart-qdrant.ps1
# Restarts the local Qdrant native binary if it's unhealthy.
#
# Strategy:
#   1. Kill any stale qdrant.exe in the user session.
#   2. Hand off to scripts/hooks/ensure-qdrant.ps1, which knows the
#      native-binary boot path and waits for /healthz.
#
# Returns a JSON {fix, actions[], success, error} report so the
# Dashboard "Apply selected fixes" panel can render the outcome.

$ErrorActionPreference = "Stop"
$report = [ordered]@{
    fix     = "restart-qdrant"
    actions = @()
    success = $false
    error   = $null
}

try {
    # 1) Kill stale qdrant.exe processes (they sometimes hang after a bad shutdown).
    $stale = Get-Process -Name 'qdrant' -ErrorAction SilentlyContinue
    if ($stale) {
        $report.actions += "stop-process qdrant ($($stale.Count) process(es))"
        $stale | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    # 2) Hand off to ensure-qdrant.ps1 — the canonical boot path.
    $ensure = Join-Path $HOME ".ultron\scripts\hooks\ensure-qdrant.ps1"
    if (Test-Path -LiteralPath $ensure) {
        $report.actions += "ensure-qdrant.ps1"
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ensure | Out-Null
        $report.success = $LASTEXITCODE -eq 0
    } else {
        $report.error = "ensure-qdrant.ps1 missing at $ensure"
    }
} catch {
    $report.error = $_.Exception.Message
}

[pscustomobject]$report | ConvertTo-Json -Compress
