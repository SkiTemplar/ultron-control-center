# ULTRON Cockpit - which Task Scheduler tasks belong to install-scheduler.ps1.
#
# Dot-sourced by install-scheduler.ps1 (status, -Uninstall and the clean slate
# before reinstalling) and by scheduler-tasks.selftest.mjs. Pure: it never
# calls the Task Scheduler, it only filters task objects it is given.
#
# Before 2026-10-23 the installer selected every task matching "Ultron*". That
# wildcard is case-insensitive, so the clean slate also removed tasks owned by
# other installers (ULTRON-BitacoraSweep, UltronQdrant, ULTRON-QdrantWatchdog).
# Now a task is ours only if its exact name (case-sensitive) is the prefix plus
# a short name this installer creates or created in the past.

$CockpitTaskPrefix = "Ultron"

# Short names that older versions of the installer registered and that a
# reinstall or -Uninstall must still be able to clean up.
$LegacyCockpitTaskNames = @(
    "Retention-Daily",
    "Standup-Weekday",
    "Research-Weekly",
    "GithubTrending-Daily",
    "TUI-Login"
)

function Get-CockpitOwnedNames {
    param([string[]]$ShortNames)
    $all = @($ShortNames) + $LegacyCockpitTaskNames
    return @($all | Where-Object { $_ } | ForEach-Object { "$CockpitTaskPrefix$_" } | Sort-Object -Unique)
}

# The weekly backup task is owned by Settings -> Backups in the Control Center
# (backup_status/schedule.rs). It is recognised by its action, whatever its name.
function Test-IsBackupTask {
    param($Task)
    return [bool]($Task.Actions | Where-Object { "$($_.Execute) $($_.Arguments)" -like "*weekly-backup.ps1*" })
}

function Select-CockpitTasks {
    param($Tasks, [string[]]$OwnedNames)
    return @($Tasks | Where-Object {
        $_ -and ($OwnedNames -ccontains $_.TaskName) -and -not (Test-IsBackupTask $_)
    })
}
