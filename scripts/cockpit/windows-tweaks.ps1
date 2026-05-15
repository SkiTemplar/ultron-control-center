# ULTRON Control Center - Windows tweaks for gaming.
#
# Read and apply a curated set of Windows knobs that affect gaming
# performance / interruptions. Every change is reversible from the same
# script via -Revert. We never write Group Policy keys; only HKCU
# (user-level) and powercfg (per-user power plan). No admin needed.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Action,  # status | apply | revert
    [string]$Key                                     # game-dvr | game-mode | power-plan | focus-assist
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

# --- helpers ----------------------------------------------------------------

function Get-RegValue([string]$Path, [string]$Name, $Default = $null) {
    try {
        $v = Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop
        return $v.$Name
    } catch {
        return $Default
    }
}

function Set-RegValue([string]$Path, [string]$Name, $Value, [string]$Type = "DWord") {
    if (-not (Test-Path $Path)) {
        New-Item -Path $Path -Force | Out-Null
    }
    New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

function Get-PowerPlan {
    try {
        $line = (powercfg /getactivescheme 2>$null) | Select-String 'GUID'
        if (-not $line) { return @{ guid = ""; name = "" } }
        $m = [regex]::Match($line.ToString(), 'GUID:\s*([0-9a-f-]+)\s*\((.+)\)')
        if ($m.Success) {
            return @{ guid = $m.Groups[1].Value; name = $m.Groups[2].Value.Trim() }
        }
    } catch {}
    return @{ guid = ""; name = "" }
}

# --- status readers (one per knob, return PSCustomObject) -------------------

function Get-GameDVRState {
    $cfg = Get-RegValue 'HKCU:\System\GameConfigStore' 'GameDVR_Enabled' 1
    $cap = Get-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR' 'AppCaptureEnabled' 1
    [PSCustomObject]@{
        key = "game-dvr"
        label = "Game DVR (background recording)"
        enabled = ([int]$cfg -eq 1 -and [int]$cap -eq 1)
        description = "Si esta on, Windows graba en background lo que pasa en el juego (consume CPU/GPU+disco). Desactivar quita ese overhead."
    }
}

function Set-GameDVRState([bool]$Enable) {
    $v = if ($Enable) { 1 } else { 0 }
    Set-RegValue 'HKCU:\System\GameConfigStore' 'GameDVR_Enabled' $v
    Set-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR' 'AppCaptureEnabled' $v
}

function Get-GameModeState {
    $v = Get-RegValue 'HKCU:\Software\Microsoft\GameBar' 'AutoGameModeEnabled' 1
    [PSCustomObject]@{
        key = "game-mode"
        label = "Windows Game Mode"
        enabled = ([int]$v -eq 1)
        description = "Da prioridad a procesos del juego y pausa updates / notificaciones del Store mientras juegas."
    }
}

function Set-GameModeState([bool]$Enable) {
    $v = if ($Enable) { 1 } else { 0 }
    Set-RegValue 'HKCU:\Software\Microsoft\GameBar' 'AutoGameModeEnabled' $v
}

# Microsoft "Ultimate Performance" plan GUID — present on Win10/11 Pro+. If
# missing we fall back to "High performance".
$ULTIMATE_GUID = "e9a42b02-d5df-448d-aa00-03f14749eb61"
$HIGHPERF_GUID = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
$BALANCED_GUID = "381b4222-f694-41f0-9685-ff5bb260df2e"

function Get-PowerPlanState {
    $cur = Get-PowerPlan
    $isPerf = ($cur.guid -eq $ULTIMATE_GUID -or $cur.guid -eq $HIGHPERF_GUID)
    [PSCustomObject]@{
        key = "power-plan"
        label = "Power plan: high performance"
        enabled = $isPerf
        description = "Activa el plan High performance (o Ultimate si esta disponible). Mas CPU base clock y menos throttling cuando el portatil esta enchufado."
        active_guid = $cur.guid
        active_name = $cur.name
    }
}

function Set-PowerPlanState([bool]$Enable) {
    if ($Enable) {
        # Try ultimate first; if powercfg complains the GUID isn't there,
        # try to duplicate it from the hidden scheme; finally fall back to
        # high-performance.
        $r = (powercfg /setactive $ULTIMATE_GUID 2>&1)
        if ($LASTEXITCODE -ne 0) {
            (powercfg /duplicatescheme $ULTIMATE_GUID 2>&1) | Out-Null
            $r = (powercfg /setactive $ULTIMATE_GUID 2>&1)
        }
        if ($LASTEXITCODE -ne 0) {
            (powercfg /setactive $HIGHPERF_GUID 2>&1) | Out-Null
        }
    } else {
        (powercfg /setactive $BALANCED_GUID 2>&1) | Out-Null
    }
}

function Get-FocusAssistState {
    # Focus Assist registry has multiple keys; this one is the "Quiet Hours"
    # toggle used during fullscreen play.
    $base = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\Windows.SystemToast.QuietHours'
    $v = Get-RegValue $base 'Enabled' 0
    [PSCustomObject]@{
        key = "focus-assist"
        label = "Focus Assist during fullscreen apps"
        enabled = ([int]$v -eq 1)
        description = "Silencia toast notifications cuando hay una app fullscreen. Hace que no aparezcan popups encima del juego."
    }
}

function Set-FocusAssistState([bool]$Enable) {
    $v = if ($Enable) { 1 } else { 0 }
    $base = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\Windows.SystemToast.QuietHours'
    Set-RegValue $base 'Enabled' $v
}

# --- dispatch ---------------------------------------------------------------

function Get-AllStatus {
    return @(
        Get-GameDVRState
        Get-GameModeState
        Get-PowerPlanState
        Get-FocusAssistState
    )
}

function Apply-Key([string]$K, [bool]$Enable) {
    switch ($K) {
        "game-dvr"     { Set-GameDVRState $Enable }
        "game-mode"    { Set-GameModeState $Enable }
        "power-plan"   { Set-PowerPlanState $Enable }
        "focus-assist" { Set-FocusAssistState $Enable }
        default        { throw "unknown key '$K'" }
    }
}

switch ($Action) {
    "status" {
        Get-AllStatus | ConvertTo-Json -Depth 4 -Compress
    }
    "apply" {
        if (-not $Key) { throw "missing -Key for apply" }
        Apply-Key $Key $true
        Get-AllStatus | ConvertTo-Json -Depth 4 -Compress
    }
    "revert" {
        if (-not $Key) { throw "missing -Key for revert" }
        Apply-Key $Key $false
        Get-AllStatus | ConvertTo-Json -Depth 4 -Compress
    }
    default {
        throw "Action must be one of status / apply / revert"
    }
}
