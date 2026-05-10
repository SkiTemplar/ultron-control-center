# ULTRON v11.0 - Register wake-based Task Scheduler triggers
# Replaces fixed-time 8:00/8:15 tasks with on-logon + on-resume-from-sleep.
#
# Run once as admin (or as USER - tasks are per-user if -RunLevel Limited):
#   powershell -ExecutionPolicy Bypass -File register_wake_triggers.ps1
#
# What this does:
#   ULTRON-OnWake         on logon          -> on_wake.py (90s settle, then morning scripts)
#   ULTRON-OnWakeResume   on resume-sleep   -> on_wake.py (same, via power event)
#
# Removes obsolete fixed-time tasks: ULTRON-AiStandup, ULTRON-NewsScraper,
# ULTRON-GithubTrending (these now run via on_wake.py).

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$SkillRoot  = Split-Path $PSScriptRoot -Parent | Split-Path -Parent
$_uvCmd     = Get-Command uv.exe -ErrorAction SilentlyContinue
$UvExe      = if ($_uvCmd) { $_uvCmd.Source } else { $null }
if (-not $UvExe) { $UvExe = "$env:USERPROFILE\.local\bin\uv.exe" }
$UserName   = $env:USERNAME

# -- Wake-from-sleep event trigger (Power-Troubleshooter Event ID 1) -----------
$WakeEventXml = @'
<QueryList>
  <Query Id="0" Path="System">
    <Select Path="System">*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]</Select>
  </Query>
</QueryList>
'@

function New-EventTrigger([string]$Subscription) {
    $cls = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
    $t   = New-CimInstance -CimClass $cls -ClientOnly -Property @{
        Enabled      = $true
        Subscription = $Subscription
        ExecutionTimeLimit = 'PT10M'
    }
    return $t
}

function Register-UltronTask {
    param(
        [string]$Name,
        [string]$Description,
        $Trigger,
        [string]$Arguments
    )
    if ($WhatIf) { Write-Host "[WhatIf] Register: $Name"; return }
    $action   = New-ScheduledTaskAction `
        -Execute    $UvExe `
        -Argument   "run python $Arguments" `
        -WorkingDirectory $SkillRoot
    $settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
        -MultipleInstances   IgnoreNew `
        -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId $UserName -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask `
        -TaskName  $Name `
        -Action    $action `
        -Trigger   $Trigger `
        -Settings  $settings `
        -Principal $principal `
        -Description $Description `
        -Force | Out-Null
    Write-Host "[OK] Registered: $Name"
}

function Remove-UltronTask([string]$Name) {
    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        if ($WhatIf) { Write-Host "[WhatIf] Remove: $Name"; return }
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
        Write-Host "[OK] Removed: $Name"
    } else {
        Write-Host "[skip] Not found: $Name"
    }
}

# -- Uninstall mode ------------------------------------------------------------
if ($Uninstall) {
    foreach ($t in @('ULTRON-OnWake','ULTRON-OnWakeResume','ULTRON-ActivityTrack','ULTRON-Dashboard',
                     'ULTRON-AiStandup','ULTRON-NewsScraper','ULTRON-GithubTrending')) {
        Remove-UltronTask $t
    }
    Write-Host "Uninstalled all ULTRON tasks."
    exit 0
}

# -- Remove obsolete fixed-time tasks -----------------------------------------
foreach ($old in @('ULTRON-AiStandup','ULTRON-NewsScraper','ULTRON-GithubTrending')) {
    Remove-UltronTask $old
}

# -- ULTRON-OnWake: At logon ---------------------------------------------------
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $UserName
Register-UltronTask `
    -Name        'ULTRON-OnWake' `
    -Description 'ULTRON v11 on-wake orchestrator - fires on logon, runs morning scripts' `
    -Trigger     $logonTrigger `
    -Arguments   'scripts/cockpit/on_wake.py'

# -- ULTRON-OnWakeResume: On resume from sleep ---------------------------------
try {
    $resumeTrigger = New-EventTrigger -Subscription $WakeEventXml
    Register-UltronTask `
        -Name        'ULTRON-OnWakeResume' `
        -Description 'ULTRON v11 on-wake orchestrator - fires on resume from sleep' `
        -Trigger     $resumeTrigger `
        -Arguments   'scripts/cockpit/on_wake.py'
} catch {
    Write-Warning "Could not register event-based wake trigger (may need admin): $_"
    Write-Warning "ULTRON-OnWake (logon) is still registered - laptop boots and logins are covered."
}

Write-Host ""
Write-Host "Done. Tasks registered:"
Get-ScheduledTask | Where-Object { $_.TaskName -like 'ULTRON-*' } |
    Select-Object TaskName, State | Format-Table -AutoSize
