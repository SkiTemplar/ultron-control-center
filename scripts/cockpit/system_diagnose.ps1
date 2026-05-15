# ULTRON Control Center — System diagnostic collector.
#
# Outputs a JSON-shaped report with: last 24h critical/error events from
# System and Application logs, current top processes by CPU and RAM, disk
# free, recent unexpected reboots, and pending updates if accessible.
# Output is bounded to keep payload <= ~30 KB so it fits in an LLM prompt.

[CmdletBinding()]
param(
    [int]$Hours = 24,
    [int]$MaxEventsPerLog = 25
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

# Force UTF-8 on stdout so Rust's String::from_utf8_lossy doesn't replace
# Spanish accents with U+FFFD when serde tries to parse the JSON output.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

try {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -and ($env:PATH -notlike "*$userPath*")) {
        $env:PATH = $userPath + ";" + $env:PATH
    }
} catch {}

$now = Get-Date
$since = $now.AddHours(-$Hours)

function Get-LogEvents([string]$LogName) {
    $rows = @()
    try {
        $events = Get-WinEvent -FilterHashtable @{LogName=$LogName; Level=1,2,3; StartTime=$since} -MaxEvents $MaxEventsPerLog -ErrorAction Stop
        foreach ($e in $events) {
            $rawMsg = if ($e.Message) { $e.Message } else { "" }
            $msg = ($rawMsg -replace "\s+", " ").Trim()
            if ($msg.Length -gt 280) { $msg = $msg.Substring(0, 280) + "..." }
            # $e.Level is an int (1=critical, 2=error, 3=warning). The old
            # version mapped by LevelDisplayName (string) which yielded $null
            # for every row — the UI never got severities.
            $levelLabel = @{1="critical"; 2="error"; 3="warning"; 4="info"; 5="verbose"}[[int]$e.Level]
            if (-not $levelLabel) { $levelLabel = "info" }
            $rows += [PSCustomObject]@{
                time     = $e.TimeCreated.ToString("yyyy-MM-ddTHH:mm:ss")
                level    = $levelLabel
                levelNum = [int]$e.Level
                source   = $e.ProviderName
                eventId  = $e.Id
                msg      = $msg
            }
        }
    } catch {}
    return ,$rows
}

$systemEvents = Get-LogEvents -LogName 'System'
$appEvents = Get-LogEvents -LogName 'Application'

# Top processes — CPU sample is jittery for one-shot, use working set as primary signal.
$topByRam = Get-Process | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 8 |
    ForEach-Object {
        [PSCustomObject]@{
            name = $_.ProcessName
            pid  = $_.Id
            ramMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
            cpuSec = [math]::Round($_.CPU, 1)
        }
    }

# Disk free + total for C:
$diskRows = @()
try {
    Get-PSDrive -PSProvider FileSystem -ErrorAction Stop | Where-Object { $_.Used -ne $null } | ForEach-Object {
        $totalGB = [math]::Round(($_.Used + $_.Free) / 1GB, 1)
        $freeGB = [math]::Round($_.Free / 1GB, 1)
        $diskRows += [PSCustomObject]@{
            drive = $_.Name
            totalGB = $totalGB
            freeGB = $freeGB
            usedPct = if ($totalGB -gt 0) { [math]::Round((($totalGB - $freeGB) / $totalGB) * 100, 1) } else { 0 }
        }
    }
} catch {}

# Memory
$mem = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$ramTotalGB = if ($mem) { [math]::Round($mem.TotalVisibleMemorySize / 1MB, 1) } else { 0 }
$ramFreeGB = if ($mem) { [math]::Round($mem.FreePhysicalMemory / 1MB, 1) } else { 0 }
$ramPctUsed = if ($ramTotalGB -gt 0) { [math]::Round((($ramTotalGB - $ramFreeGB) / $ramTotalGB) * 100, 1) } else { 0 }

# Boots — unexpected if shutdown wasn't clean. Event 6008 = unexpected shutdown.
$unexpectedReboots = @()
try {
    $events = Get-WinEvent -FilterHashtable @{LogName='System'; Id=6008; StartTime=$now.AddDays(-7)} -MaxEvents 5 -ErrorAction Stop
    foreach ($e in $events) {
        $rawMsg = if ($e.Message) { $e.Message } else { "" }
        $clean = ($rawMsg -replace "\s+", " ")
        $unexpectedReboots += [PSCustomObject]@{
            time = $e.TimeCreated.ToString("yyyy-MM-ddTHH:mm:ss")
            msg = $clean.Substring(0, [Math]::Min(200, $clean.Length))
        }
    }
} catch {}

# Recent app crashes — event 1000 (Application Error)
$appCrashes = @()
try {
    $events = Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000; StartTime=$since} -MaxEvents 10 -ErrorAction Stop
    foreach ($e in $events) {
        $rawMsg = if ($e.Message) { $e.Message } else { "" }
        $clean = ($rawMsg -replace "\s+", " ")
        $appCrashes += [PSCustomObject]@{
            time = $e.TimeCreated.ToString("yyyy-MM-ddTHH:mm:ss")
            msg = $clean.Substring(0, [Math]::Min(240, $clean.Length))
        }
    }
} catch {}

$report = [PSCustomObject]@{
    generatedAt = $now.ToString("yyyy-MM-ddTHH:mm:ss")
    windowHours = $Hours
    host = [PSCustomObject]@{
        name = $env:COMPUTERNAME
        user = $env:USERNAME
        os = if ($mem) { $mem.Caption } else { "" }
        uptimeHours = if ($mem) { [math]::Round(((Get-Date) - $mem.LastBootUpTime).TotalHours, 1) } else { 0 }
    }
    memory = [PSCustomObject]@{
        totalGB = $ramTotalGB
        freeGB = $ramFreeGB
        usedPct = $ramPctUsed
    }
    disks = $diskRows
    topProcessesByRam = $topByRam
    systemEvents = $systemEvents
    appEvents = $appEvents
    appCrashes = $appCrashes
    unexpectedReboots = $unexpectedReboots
}

$report | ConvertTo-Json -Depth 6 -Compress
