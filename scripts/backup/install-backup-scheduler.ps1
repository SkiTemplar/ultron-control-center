# ULTRON v14.7 BACKUP-WATCH — Task Scheduler installer
#
# Registers / removes / inspects the `UltronBackup-Weekly` task that runs
# weekly-backup.ps1 every Monday at 09:00. Uses schtasks.exe (user scope,
# no admin required) so it works under standard logon.
#
# Usage:
#   install-backup-scheduler.ps1                # install (default)
#   install-backup-scheduler.ps1 -Status        # query existing task
#   install-backup-scheduler.ps1 -Uninstall     # remove the task
#   install-backup-scheduler.ps1 -Time 14:30    # custom time of day
#   install-backup-scheduler.ps1 -Day TUE       # custom day (MON/TUE/WED/...)

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Status,
    [string]$Time = "09:00",
    [ValidateSet("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")]
    [string]$Day = "MON"
)

$TaskName     = "UltronBackup-Weekly"
$ScriptPath   = Join-Path $env:USERPROFILE ".ultron\scripts\backup\weekly-backup.ps1"

# ── Status mode ───────────────────────────────────────────────────────────────

if ($Status) {
    schtasks /query /tn $TaskName /fo LIST 2>&1
    exit $LASTEXITCODE
}

# ── Uninstall mode ────────────────────────────────────────────────────────────

if ($Uninstall) {
    schtasks /delete /tn $TaskName /f 2>&1
    Write-Output "Removed task $TaskName (exit=$LASTEXITCODE)"
    exit $LASTEXITCODE
}

# ── Install mode ──────────────────────────────────────────────────────────────

if (-not (Test-Path $ScriptPath)) {
    Write-Error "weekly-backup.ps1 not found at $ScriptPath"
    exit 2
}

$cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""

schtasks /create /sc WEEKLY /d $Day /st $Time /tn $TaskName /tr $cmd /rl LIMITED /f 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Error "Task registration failed."
    exit 1
}

Write-Output "Registered $TaskName (weekly $Day at $Time)."
schtasks /query /tn $TaskName /fo LIST | Select-Object -First 8
exit 0
