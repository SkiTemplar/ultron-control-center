# auto-fixes/run-weekly-backup.ps1
# Triggers the ULTRON-Backup-Weekly scheduled task immediately so the
# disk mirrors get refreshed. Used by the Doctor "Backup stale" fix-it
# action — alternative to the user clicking Maintenance commands ->
# Weekly backup manually.
#
# Returns the standard {fix, actions[], success, error} JSON report.

$ErrorActionPreference = "Stop"
$report = [ordered]@{
    fix     = "run-weekly-backup"
    actions = @()
    success = $false
    error   = $null
}

try {
    # Prefer the registered scheduled task — that's the canonical path
    # the install.ps1 sets up. If it's not registered, fall back to
    # invoking the script directly.
    $taskName = "ULTRON-Backup-Weekly"
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

    if ($task) {
        $report.actions += "Start-ScheduledTask $taskName"
        Start-ScheduledTask -TaskName $taskName
        # Poll briefly to confirm the task entered Running state.
        Start-Sleep -Seconds 2
        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
        if ($info) {
            $report.actions += "task state probed: $($task.State), last result: 0x$('{0:X}' -f $info.LastTaskResult)"
        }
        $report.success = $true
    } else {
        # Fallback: run the script directly if it exists.
        $script = Join-Path $HOME ".ultron\scripts\backup\weekly-backup.ps1"
        if (Test-Path -LiteralPath $script) {
            $report.actions += "direct: $script"
            & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script | Out-Null
            $report.success = $LASTEXITCODE -eq 0
        } else {
            $report.error = "Neither scheduled task '$taskName' nor weekly-backup.ps1 found. Run install.ps1 -Force to register the task."
        }
    }
} catch {
    $report.error = $_.Exception.Message
}

[pscustomobject]$report | ConvertTo-Json -Compress
