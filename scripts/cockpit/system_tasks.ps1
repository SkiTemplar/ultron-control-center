param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('list', 'run', 'info', 'detail', 'richinfo')]
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

    'detail' {
        if (-not $Name) { throw 'detail requires -Name' }
        if ($Name -notmatch '^(ULTRON|Ultron)[A-Za-z0-9._\-]{1,80}$') {
            throw "invalid task name '$Name'"
        }
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if (-not $task) { throw "task not found: $Name" }
        $info = $task | Get-ScheduledTaskInfo

        # Triggers — serialize each in a readable shape
        $triggers = @()
        foreach ($t in $task.Triggers) {
            $kind = $t.CimClass.CimClassName -replace 'MSFT_TaskTrigger', '' -replace 'Trigger', ''
            $start = if ($t.StartBoundary) { $t.StartBoundary } else { '' }
            $enabled = if ($t.Enabled -ne $null) { $t.Enabled } else { $true }
            $extra = ''
            if ($t.PSObject.Properties.Match('DaysOfWeek').Count -gt 0 -and $t.DaysOfWeek) { $extra = "days=$($t.DaysOfWeek)" }
            if ($t.PSObject.Properties.Match('DaysInterval').Count -gt 0 -and $t.DaysInterval) { $extra = "every $($t.DaysInterval) day(s)" }
            if ($t.PSObject.Properties.Match('WeeksInterval').Count -gt 0 -and $t.WeeksInterval) { $extra = "every $($t.WeeksInterval) week(s)" }
            $triggers += @{
                kind    = $kind
                start   = $start
                enabled = [bool]$enabled
                extra   = $extra
            }
        }

        # Actions — usually 1, but can be multiple
        $actions = @()
        foreach ($a in $task.Actions) {
            $actions += @{
                execute   = if ($a.Execute) { $a.Execute } else { '' }
                arguments = if ($a.Arguments) { $a.Arguments } else { '' }
                working   = if ($a.WorkingDirectory) { $a.WorkingDirectory } else { '' }
            }
        }

        # Recent run events from TaskScheduler operational log.
        $history = @()
        try {
            $filter = @{
                LogName      = 'Microsoft-Windows-TaskScheduler/Operational'
                ID           = 100, 102, 103, 200, 201, 202, 203
                StartTime    = (Get-Date).AddDays(-14)
            }
            $events = Get-WinEvent -FilterHashtable $filter -MaxEvents 200 -ErrorAction SilentlyContinue |
                Where-Object { $_.Message -match [regex]::Escape($Name) }
            foreach ($e in ($events | Select-Object -First 10)) {
                $history += @{
                    time    = $e.TimeCreated.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
                    event_id = [int]$e.Id
                    message = ($e.Message -replace "`r`n", ' ' -replace "`n", ' ').Substring(0, [Math]::Min(200, $e.Message.Length))
                }
            }
        } catch {
            # Event log unavailable (e.g. permission denied) — ignore.
        }

        @{
            name             = $task.TaskName
            description      = $task.Description
            author           = $task.Author
            state            = $task.State.ToString()
            last_run         = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 1) { $info.LastRunTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") } else { '' }
            next_run         = if ($info.NextRunTime -and $info.NextRunTime.Year -gt 1) { $info.NextRunTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") } else { '' }
            last_result      = $info.LastTaskResult
            missed_runs      = $info.NumberOfMissedRuns
            principal_user   = $task.Principal.UserId
            principal_logon  = $task.Principal.LogonType.ToString()
            run_level        = $task.Principal.RunLevel.ToString()
            triggers         = $triggers
            actions          = $actions
            history          = $history
        } | ConvertTo-Json -Depth 6 -Compress
    }

    'richinfo' {
        $os    = Get-CimInstance Win32_OperatingSystem
        $cs    = Get-CimInstance Win32_ComputerSystem
        $cpu   = Get-CimInstance Win32_Processor | Select-Object -First 1
        $disk  = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
        $boot  = $os.LastBootUpTime
        $uptimeSecs = [int]((Get-Date) - $boot).TotalSeconds

        $ramTotal = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
        $ramFreeMB = $os.FreePhysicalMemory      # KB
        $ramFreeGB = [math]::Round($ramFreeMB / 1MB, 1)  # KB→GB
        $ramUsedGB = [math]::Round($ramTotal - $ramFreeGB, 1)
        $ramPctUsed = [math]::Round(($ramUsedGB / $ramTotal) * 100, 1)

        # CPU load average sample (Windows: WMI LoadPercentage = recent sample)
        $cpuLoad = $cpu.LoadPercentage

        # GPU via nvidia-smi if present, else WMI (Win32_VideoController) fallback
        $gpus = @()
        $nvSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
        if ($nvSmi) {
            try {
                $rows = & nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>$null
                foreach ($r in $rows) {
                    $parts = $r -split ',' | ForEach-Object { $_.Trim() }
                    if ($parts.Count -ge 5) {
                        $gpus += @{
                            name           = $parts[0]
                            util_pct       = [int]$parts[1]
                            mem_used_mb    = [int]$parts[2]
                            mem_total_mb   = [int]$parts[3]
                            temp_c         = [int]$parts[4]
                            vendor         = 'nvidia'
                        }
                    }
                }
            } catch {}
        }
        if ($gpus.Count -eq 0) {
            foreach ($v in (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)) {
                $gpus += @{
                    name           = $v.Name
                    util_pct       = $null
                    mem_used_mb    = $null
                    mem_total_mb   = if ($v.AdapterRAM) { [int]($v.AdapterRAM / 1MB) } else { $null }
                    temp_c         = $null
                    vendor         = 'wmi'
                }
            }
        }

        # Battery
        $battery = $null
        $batt = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($batt) {
            $battery = @{
                percent       = $batt.EstimatedChargeRemaining
                status        = $batt.BatteryStatus    # 1=Discharging 2=AC 3=Fully charged ...
                plugged_in    = ($batt.BatteryStatus -in @(2, 3, 6, 7, 8, 9))
            }
        }

        # Network: primary IPv4 address (first connected non-loopback)
        $netIf = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
            Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq 'Up' } |
            Select-Object -First 1
        $network = $null
        if ($netIf) {
            $network = @{
                interface   = $netIf.InterfaceAlias
                ipv4        = $netIf.IPv4Address.IPAddress
                gateway     = if ($netIf.IPv4DefaultGateway) { $netIf.IPv4DefaultGateway.NextHop } else { '' }
                dns         = ($netIf.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | Select-Object -First 1).ServerAddresses -join ', '
            }
        }

        # Top 5 processes by working set (RAM)
        $topProcs = Get-Process -ErrorAction SilentlyContinue |
            Sort-Object -Property WorkingSet64 -Descending |
            Select-Object -First 5 |
            ForEach-Object {
                @{
                    name   = $_.ProcessName
                    pid    = $_.Id
                    ram_mb = [math]::Round($_.WorkingSet64 / 1MB, 1)
                }
            }

        @{
            hostname        = $env:COMPUTERNAME
            user            = $env:USERNAME
            os_name         = $os.Caption
            os_version      = $os.Version
            uptime_seconds  = $uptimeSecs
            cpu_name        = $cpu.Name
            cpu_cores       = $cpu.NumberOfCores
            cpu_threads     = $cpu.NumberOfLogicalProcessors
            cpu_load_pct    = $cpuLoad
            ram_total_gb    = $ramTotal
            ram_free_gb     = $ramFreeGB
            ram_used_gb     = $ramUsedGB
            ram_pct_used    = $ramPctUsed
            disk_c_total_gb = [math]::Round($disk.Size / 1GB, 1)
            disk_c_free_gb  = [math]::Round($disk.FreeSpace / 1GB, 1)
            disk_c_pct_used = [math]::Round((1 - $disk.FreeSpace / $disk.Size) * 100, 1)
            gpus            = @($gpus)
            battery         = $battery
            network         = $network
            top_procs       = @($topProcs)
        } | ConvertTo-Json -Depth 6 -Compress
    }
}
