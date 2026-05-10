#requires -Version 5.1
<#
.SYNOPSIS
ULTRON Alerts Bus — PowerShell helper to append one alert to ~/.ultron/alerts.jsonl

.DESCRIPTION
Silent (no console output unless -Verbose). Atomic single-line append via
.NET FileStream(Append). Concurrent writers do NOT corrupt the file (kernel
handles append offset).

Schema and severity ladder documented in ~/.ultron/docs/alerts-bus.md.

.EXAMPLE
write-alert.ps1 -Severity warn -Source 'session-init.ps1' -Message 'EEXIST mkdir'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('info', 'warn', 'blocking')]
    [string]$Severity,

    [Parameter(Mandatory = $true)]
    [string]$Source,

    [Parameter(Mandatory = $true)]
    [string]$Message,

    [string[]]$Tags = @()
)

$ErrorActionPreference = 'Stop'

$ultronHome  = Join-Path $env:USERPROFILE '.ultron'
$alertsFile  = Join-Path $ultronHome 'alerts.jsonl'

# Ensure parent dir exists (idempotent).
if (-not (Test-Path -LiteralPath $ultronHome)) {
    New-Item -ItemType Directory -Force -Path $ultronHome | Out-Null
}
if (-not (Test-Path -LiteralPath $alertsFile)) {
    # UTF-8 no BOM
    [System.IO.File]::WriteAllBytes($alertsFile, @())
}

# Compute next id by counting today's existing entries.
$today  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$prefix = "a-$today-"
$count  = 0
try {
    $sr = New-Object System.IO.StreamReader($alertsFile, [System.Text.Encoding]::UTF8)
    $seenIds = New-Object 'System.Collections.Generic.HashSet[string]'
    try {
        while (-not $sr.EndOfStream) {
            $line = $sr.ReadLine()
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try {
                $obj = $line | ConvertFrom-Json -ErrorAction Stop
                if ($obj.id -is [string] -and $obj.id.StartsWith($prefix) -and -not $seenIds.Contains($obj.id)) {
                    $null = $seenIds.Add($obj.id)
                    $count++
                }
            } catch { }  # malformed line — skip
        }
    } finally { $sr.Close() }
} catch {
    Write-Verbose "read existing alerts failed: $($_.Exception.Message)"
}
$nnn = '{0:D3}' -f ($count + 1)
$id  = "$prefix$nnn"

$ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$record = [ordered]@{
    id        = $id
    ts        = $ts
    severity  = $Severity
    source    = $Source
    message   = $Message
    tags      = @($Tags)
    ack       = $false
    ack_ts    = $null
}

# Compact JSON (single line — required for jsonl invariant).
$json = ($record | ConvertTo-Json -Compress -Depth 4)

# Atomic append via .NET FileStream(Append). UTF-8 no BOM.
$utf8 = New-Object System.Text.UTF8Encoding $false
$bytes = $utf8.GetBytes($json + "`n")
$fs = $null
try {
    $fs = [System.IO.File]::Open(
        $alertsFile,
        [System.IO.FileMode]::Append,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::ReadWrite)
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush()
} finally {
    if ($fs) { $fs.Dispose() }
}

# Output the id on stdout (data, not noise).
Write-Output $id
