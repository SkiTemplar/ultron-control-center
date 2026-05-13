param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('list', 'run', 'info')]
    [string]$Action,

    [Parameter(Mandatory = $false)]
    [string]$Name
)

# ULTRON Control Center — scheduled task helper.
#
# Provides a stable JSON interface so the Tauri backend doesn't have to
# parse CIM metadata that Get-ScheduledTask | ConvertTo-Json drags along.
#
# Subcommands:
#   list        all tasks starting with ULTRON (case-insensitive) → JSON array
#   run -Name   start a specific ULTRON task by name
#   info        OS + uptime + disk C:\ free → JSON object

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'

function Get-UltronTasks {
    Get-ScheduledTask -TaskName 'ULTRON*' -ErrorAction SilentlyContinue
}

function Get-TaskRow {
    param($Task)
    $info = $Task | Get-ScheduledTaskInfo
    $lastRun = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 1) {
        $info.LastRunTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    } else { '' }
    $nextRun = if ($info.NextRunTime -and $info.NextRunTime.Year -gt 1) {
        $info.NextRunTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    } else { '' }
    [PSCustomObject]@{
        name        = $Task.TaskName
        state       = $Task.State.ToString()
        last_run    = $lastRun
        next_run    = $nextRun
        last_result = $info.LastTaskResult
        description = $Task.Description
    }
}

switch ($Action) {
    'list' {
        $rows = @()
        foreach ($t in Get-UltronTasks) {
            $rows += Get-TaskRow $t
        }
        # @() + ConvertTo-Json with -Depth so single-element arrays don't collapse to object.
        if ($rows.Count -eq 1) {
            # ConvertTo-Json wraps a single object as object, not array — force array.
            ConvertTo-Json @($rows) -Depth 4 -Compress
        } elseif ($rows.Count -eq 0) {
            Write-Output '[]'
        } else {
            ConvertTo-Json $rows -Depth 4 -Compress
        }
    }

    'run' {
        if (-not $Name) { throw 'run requires -Name' }
        if ($Name -notmatch '^[A-Za-z0-9._\-]{1,80}$') { throw "invalid name '$Name'" }
        if ($Name -notmatch '^ULTRON|^Ultron') {
            throw "only ULTRON-* tasks allowed (got '$Name')"
        }
        Start-ScheduledTask -TaskName $Name
        @{
            success = $true
            name    = $Name
        } | ConvertTo-Json -Compress
    }

    'info' {
        $os = Get-CimInstance Win32_OperatingSystem
        $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
        $bootTime = $os.LastBootUpTime
        $uptimeSecs = [int]((Get-Date) - $bootTime).TotalSeconds
        @{
            hostname        = $env:COMPUTERNAME
            user            = $env:USERNAME
            os_name         = $os.Caption
            os_version      = $os.Version
            uptime_seconds  = $uptimeSecs
            disk_c_total_gb = [math]::Round($disk.Size / 1GB, 1)
            disk_c_free_gb  = [math]::Round($disk.FreeSpace / 1GB, 1)
            disk_c_pct_used = [math]::Round((1 - $disk.FreeSpace / $disk.Size) * 100, 1)
        } | ConvertTo-Json -Compress
    }
}
