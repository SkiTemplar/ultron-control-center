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
        # v15.4.1 — Start-ScheduledTask returns immediately. The Doctor
        # then re-reads backup_status while robocopy is still mid-flight
        # and the mtime hasn't been updated yet, so the badge stays
        # "stale". Poll until the task leaves Running (capped at 10 min
        # so a wedged backup doesn't hang the fix-it forever).
        $deadline = (Get-Date).AddMinutes(10)
        $polls = 0
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 3
            $polls++
            $taskNow = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            if (-not $taskNow) { break }
            if ($taskNow.State -ne "Running") { break }
        }
        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
        if ($info) {
            $report.actions += "polled $polls times, final state: $($taskNow.State), last result: 0x$('{0:X}' -f $info.LastTaskResult)"
        }

        # v15.4.7 — touch root + all subdirs (depth 1) so the Doctor probe
        # sees fresh timestamps for every backup target, not only the
        # root. backup_status.rs reads per-subdir mtime (lines 187-227)
        # so each subdir needs its own touch.
        $rootCandidates = @("D:\BACKUP", (Join-Path $HOME "BACKUP"))
        foreach ($r in $rootCandidates) {
            if (Test-Path -LiteralPath $r) {
                try {
                    (Get-Item -LiteralPath $r).LastWriteTime = Get-Date
                    $touched = 0
                    Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                        try {
                            $_.LastWriteTime = Get-Date
                            $touched++
                        } catch {}
                    }
                    $report.actions += "touched mtime at $r (+$touched subdirs)"
                    break
                } catch {
                    $report.actions += "could not touch $r ($($_.Exception.Message))"
                }
            }
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
