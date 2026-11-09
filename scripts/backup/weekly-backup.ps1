# ULTRON v14.8 BACKUP-WATCH - weekly robocopy backup (mirror, overwrite)
#
# Backs up the user's data sources to $env:BACKUP_ROOT\<src>\ (NO dated subdir).
# Each run overwrites the previous mirror via robocopy /MIR - single up-to-date
# snapshot, no history. Logs are still dated (~/.ultron/logs/backup-<DATE>.log).
# Reads exclusions from ~/.ultron/config/backup-exclusions.txt (gitignore-style).
# Designed to run via Task Scheduler ONLOGON (weekly trigger). Idempotent and
# safe: /MIR removes destination files no longer in source.
#
# Usage:
#   weekly-backup.ps1                     # run real backup
#   weekly-backup.ps1 -DryRun              # log what would happen, no copy
#   weekly-backup.ps1 -Source .ultron      # restrict to a single source
#   weekly-backup.ps1 -Status              # print last-run summary, exit
#
# -KeepWeeks (default 4) controls how many dated brain.db snapshots are kept
# under <BackupRoot>\brain-snapshots\. The robocopy mirror itself keeps no
# history. -KeepLogs (default 8) controls how many dated backup logs and
# robocopy logs are kept under ~/.ultron/logs (each kind pruned separately).
#
# Trash (2026-11-09): /MIR deletes from the mirror whatever is gone from the
# source, so a file deleted by mistake used to vanish from the backup on the
# next run. Before mirroring, the files /MIR is about to delete are moved to
# <BackupRoot>\_borrados\<date>\<dest folder>\<relative path> and kept for
# -TrashDays days (default 28). If they cannot be listed or moved, that source
# is copied without deleting anything (robocopy /E) for this run. Only deleted
# files go to the trash: overwritten versions are not kept. The Linux/macOS
# variant (weekly-backup.sh) has no trash.
#
# Exit codes:
#   0 success / nothing to do
#   1 partial (some sources failed)
#   2 fatal: no destination configured, destination drive not mounted, or
#     destination on the same volume as a source. A fatal abort still writes
#     backup-last-run.json with status "failed", aborted=true, error_code
#     (no_destination | drive_missing | same_volume) and error, so the
#     Control Center shows it.
#
# ULTRON_BACKUP_ALLOW_SAME_VOLUME=1 disables the same-volume guard. It exists
# for the selftest (its sandbox lives in %TEMP%); do not set it for real runs.
#
# Relative sources are anchored at $env:USERPROFILE; absolute sources
# (D:\TFG) are used as-is and mirrored to <BackupRoot>\abs-D-TFG. A configured
# source that does not exist counts as a failure (exit 1).
# Selftest: scripts/backup/weekly-backup.selftest.mjs

[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$Source = "",
    [int]$KeepWeeks = 4,
    [int]$KeepLogs = 8,
    [int]$TrashDays = 28,
    [switch]$Status
)

$ErrorActionPreference = "Stop"

# -- Configuration --------------------------------------------------------------

# Resolution order (v15.5.20: backups-modular-ui added the JSON UI layer):
#   1. ~/.ultron/cockpit/backup-config.json -> { "sources": ["..."] }
#      (written by Settings -> Backups -> Sources panel)
#   2. $env:ULTRON_BACKUP_SOURCES (comma-separated, fallback for CLI users)
#   3. Defaults: .ultron, .ultron-vault, .claude
# Personal trees like Documents / source / your-folder are opt-in via the UI.
$DefaultSources    = @(".ultron", ".ultron-vault", ".claude")
$SourcesConfigPath = Join-Path $env:USERPROFILE ".ultron\cockpit\backup-config.json"
$Sources = $null
if (Test-Path $SourcesConfigPath) {
    try {
        $cfg = Get-Content -Raw -Path $SourcesConfigPath -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.sources -and $cfg.sources.Count -gt 0) {
            $Sources = @($cfg.sources | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
        }
    } catch {
        Write-Warning "Could not parse $SourcesConfigPath ($_) - falling back to env/defaults."
    }
}
if (-not $Sources) {
    $Sources = if ($env:ULTRON_BACKUP_SOURCES) {
        @($env:ULTRON_BACKUP_SOURCES.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    } else {
        $DefaultSources
    }
}

# Backup destination root. Resolution order MUST match
# control-center/src-tauri/src/backup_status/root.rs::backup_root():
#   1. ~/.ultron/.tmp/backup-root.txt        (set via Settings -> Backups UI)
#   2. $env:ULTRON_BACKUP_ROOT               (CLI / Task Scheduler override)
#   3. nothing: the run aborts (exit 2, status "failed").
#
# 2026-10-23 (audit N1): steps "D:\BACKUP if mounted" and
# "%USERPROFILE%\BACKUP" were removed. With D: unplugged the script fell back
# to a folder on C: and ran /MIR on the same disk as the sources with exit 0:
# a mirror on the same volume is not a backup.
$BackupRootFile  = Join-Path $env:USERPROFILE ".ultron\.tmp\backup-root.txt"
$BackupRoot      = $null
if (Test-Path $BackupRootFile) {
    try {
        $fileVal = (Get-Content -Raw -Path $BackupRootFile -Encoding UTF8).Trim()
        if ($fileVal) { $BackupRoot = $fileVal }
    } catch {
        Write-Warning "Could not read $BackupRootFile ($_) - falling back to ULTRON_BACKUP_ROOT."
    }
}
if (-not $BackupRoot -and $env:ULTRON_BACKUP_ROOT) {
    $BackupRoot = $env:ULTRON_BACKUP_ROOT.Trim()
}
$ExclusionsFile  = Join-Path $env:USERPROFILE ".ultron\config\backup-exclusions.txt"
$LogDir          = Join-Path $env:USERPROFILE ".ultron\logs"
$StatusFile      = Join-Path $env:USERPROFILE ".ultron\.tmp\backup-last-run.json"

# -- Helpers --------------------------------------------------------------------

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$ts] $Level $Message" | Tee-Object -FilePath $script:LogFile -Append
}

function Read-Exclusions {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        return @{ Dirs = @(); Files = @() }
    }
    $dirs  = New-Object System.Collections.Generic.List[string]
    $files = New-Object System.Collections.Generic.List[string]
    foreach ($line in Get-Content $Path -Encoding UTF8) {
        $trim = $line.Trim()
        if (-not $trim -or $trim.StartsWith("#")) { continue }
        if ($trim.EndsWith("/")) {
            $dirs.Add($trim.TrimEnd("/"))
        } elseif ($trim -like "*.*") {
            $files.Add($trim)
        } else {
            # Defensive: treat bare names as directories
            $dirs.Add($trim)
        }
    }
    return @{ Dirs = $dirs.ToArray(); Files = $files.ToArray() }
}

function Invoke-Robocopy {
    param(
        [string]$SourcePath,
        [string]$DestPath,
        [string[]]$ExcludeDirs,
        [string[]]$ExcludeFiles,
        [string]$LogPath,
        [switch]$DryRunFlag,
        [switch]$NoPurge
    )
    if (-not (Test-Path -LiteralPath $SourcePath)) {
        Write-Log "SKIP: source missing: $SourcePath" "WARN"
        return @{ Code = 16; Skipped = $true }
    }
    $args = @(
        $SourcePath, $DestPath,
        $(if ($NoPurge) { "/E" } else { "/MIR" }),  # /E = copy without deleting extras
        "/R:1",        # 1 retry on locked files
        "/W:5",        # 5s wait between retries
        "/MT:8",       # 8 multi-threaded copies
        "/NP",         # no progress %
        "/NDL",        # no directory list
        "/NJH",        # no job header
        # /XJD skips directory junctions. Windows keeps legacy XP compatibility
        # junctions inside Documents ("Mis videos", "Mis imagenes", "Mi musica")
        # that carry a deny ACL to prevent enumeration loops. robocopy counted
        # them as 3 failed directories on every run, which turned a healthy
        # backup into exit code 9 -> task exit 1. They hold no data of their own.
        "/XJD",
        # /NJS was dropped on 2026-09-21: without the job summary, the per-file
        # ERROR lines and the failure count never reached the log, so an exit 9
        # could not be diagnosed at all. The summary is a handful of lines.
        "/LOG+:$LogPath"
    )
    if ($DryRunFlag) { $args += "/L" }
    if ($ExcludeDirs.Count -gt 0)  { $args += "/XD"; $args += $ExcludeDirs }
    if ($ExcludeFiles.Count -gt 0) { $args += "/XF"; $args += $ExcludeFiles }

    Write-Log "robocopy $SourcePath -> $DestPath ($(if($DryRunFlag){'DRY-RUN'}else{'COPY'}))"
    & robocopy @args 2>&1 | Out-Null
    return @{ Code = $LASTEXITCODE; Skipped = $false }
}

function Resolve-BackupTarget {
    # Relative sources (".ultron", "Documents") are anchored at USERPROFILE.
    # Absolute sources ("D:\TFG") are used as-is: Join-Path USERPROFILE with an
    # absolute path produced an impossible path and the source was never
    # copied. Their mirror goes to abs-<sanitised path> so it cannot collide
    # with a USERPROFILE folder of the same name.
    param([string]$Src, [string]$Root)
    if ([System.IO.Path]::IsPathRooted($Src)) {
        $slug = ($Src -replace '[:\\/]+', '-').Trim('-')
        return @{ Source = $Src; Dest = ([System.IO.Path]::Combine($Root, "abs-" + $slug)) }
    }
    $srcAbs = Join-Path $env:USERPROFILE $Src
    if ($Src.StartsWith(".")) {
        # Hidden source: preserve a non-leading-dot name on dest for explorer friendliness
        return @{ Source = $srcAbs; Dest = ([System.IO.Path]::Combine($Root, "dot-" + $Src.TrimStart("."))) }
    }
    return @{ Source = $srcAbs; Dest = ([System.IO.Path]::Combine($Root, $Src.TrimStart("\"))) }
}

function Test-RobocopyOk {
    param([int]$Code)
    # Robocopy exit codes: 0..7 are success-ish; 8+ contain failures.
    # 0 = nothing copied, 1 = files copied, 2 = extra dirs found, 3 = 1+2,
    # 4 = mismatched, 5 = files copied + mismatched, 6 = mismatch + extra,
    # 7 = all of the above. >=8 = at least one error.
    return $Code -lt 8
}

function Remove-LegacyDatedBackups {
    # One-shot cleanup: remove old YYYY-MM-DD dated subdirs left over from
    # the pre-mirror version of this script. Safe to call repeatedly.
    param([string]$Root)
    if (-not (Test-Path $Root)) { return }
    $dated = Get-ChildItem -Path $Root -Directory -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' }
    foreach ($d in $dated) {
        Write-Log "CLEANUP: removing legacy dated backup $($d.FullName)"
        if (-not $DryRun) {
            Remove-Item -Path $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-PurgeCandidates {
    # Files robocopy /MIR would delete from $DestPath: present there, absent
    # from $SourcePath and not under an excluded name (/XD and /XF protect
    # extras from deletion too). /L lists without copying; /XL /XC /XN /XO hide
    # new and changed files so only the extras remain; /NC drops the localised
    # class column; /UNILOG keeps non-ASCII names intact (console output is
    # decoded with the OEM codepage).
    # Returns @{ Ok; Files }: Ok = $false when the listing itself failed.
    param([string]$SourcePath, [string]$DestPath, [string[]]$ExcludeDirs, [string[]]$ExcludeFiles)
    $listFile = [System.IO.Path]::GetTempFileName()
    try {
        $roboArgs = @($SourcePath, $DestPath, "/MIR", "/L", "/XL", "/XC", "/XN", "/XO",
            "/NC", "/NS", "/NP", "/NJH", "/NJS", "/FP", "/XJD", "/R:0", "/W:0", "/UNILOG:$listFile")
        if ($ExcludeDirs.Count -gt 0)  { $roboArgs += "/XD"; $roboArgs += $ExcludeDirs }
        if ($ExcludeFiles.Count -gt 0) { $roboArgs += "/XF"; $roboArgs += $ExcludeFiles }
        & robocopy @roboArgs 2>&1 | Out-Null
        if ($LASTEXITCODE -ge 8) { return @{ Ok = $false; Files = @() } }
        $prefix = $DestPath.TrimEnd('\') + '\'
        $files = @(Get-Content -LiteralPath $listFile -Encoding Unicode |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and -not $_.EndsWith('\') })
        return @{ Ok = $true; Files = $files }
    } finally {
        Remove-Item -LiteralPath $listFile -Force -ErrorAction SilentlyContinue
    }
}

function Move-ToTrash {
    # Moves each file to $TrashDir keeping its path relative to $DestPath. The
    # trash lives on the same volume as the mirror, so each move is a rename.
    param([string[]]$Files, [string]$DestPath, [string]$TrashDir)
    $moved = 0
    $failed = 0
    $prefixLen = $DestPath.TrimEnd('\').Length + 1
    foreach ($file in $Files) {
        $target = Join-Path $TrashDir $file.Substring($prefixLen)
        try {
            [System.IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
            if ([System.IO.File]::Exists($target)) { [System.IO.File]::Delete($target) }
            [System.IO.File]::Move($file, $target)
            $moved++
        } catch {
            $failed++
            if ($failed -le 20) { $null = Write-Log "WARN: could not move to trash $file ($($_.Exception.Message))" "WARN" }
        }
    }
    return @{ Moved = $moved; Failed = $failed }
}

function Protect-PurgedFiles {
    # Saves what /MIR is about to delete. Purge = $false tells the caller to
    # copy without deleting: either the listing failed or some file could not
    # be moved, and /MIR would destroy it.
    param([string]$SourcePath, [string]$DestPath, [string]$TrashDir,
          [string[]]$ExcludeDirs, [string[]]$ExcludeFiles, [switch]$DryRunFlag)
    $none = @{ Moved = 0; Failed = 0; Purge = $true }
    if (-not (Test-Path -LiteralPath $SourcePath) -or -not (Test-Path -LiteralPath $DestPath)) { return $none }
    $list = Get-PurgeCandidates -SourcePath $SourcePath -DestPath $DestPath `
        -ExcludeDirs $ExcludeDirs -ExcludeFiles $ExcludeFiles
    if (-not $list.Ok) {
        $null = Write-Log "WARN: could not list the files to delete in $DestPath; copying without deleting this run" "WARN"
        return @{ Moved = 0; Failed = 0; Purge = $false }
    }
    if ($list.Files.Count -eq 0) { return $none }
    if ($DryRunFlag) {
        $null = Write-Log "TRASH (dry-run): would move $($list.Files.Count) file(s) from $DestPath to $TrashDir"
        return $none
    }
    $result = Move-ToTrash -Files $list.Files -DestPath $DestPath -TrashDir $TrashDir
    $null = Write-Log "TRASH: moved $($result.Moved) file(s) deleted from $SourcePath to $TrashDir"
    if ($result.Failed -gt 0) {
        $null = Write-Log ("WARN: $($result.Failed) file(s) could not be moved to the trash; " +
            "copying $SourcePath without deleting this run") "WARN"
    }
    return @{ Moved = $result.Moved; Failed = $result.Failed; Purge = ($result.Failed -eq 0) }
}

function Remove-OldTrash {
    # Retention: drop <TrashRoot>\<yyyy-MM-dd> folders older than $Days days.
    # Folders with any other name are left alone.
    param([string]$TrashRoot, [int]$Days)
    if (-not (Test-Path -LiteralPath $TrashRoot)) { return }
    $cutoff = (Get-Date).Date.AddDays(-$Days)
    foreach ($dir in @(Get-ChildItem -LiteralPath $TrashRoot -Directory -ErrorAction SilentlyContinue)) {
        $day = [datetime]::MinValue
        $isDated = [datetime]::TryParseExact($dir.Name, 'yyyy-MM-dd',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$day)
        if (-not $isDated -or $day -ge $cutoff) { continue }
        if ($DryRun) { Write-Log "CLEANUP (dry-run): would prune trash $($dir.Name)"; continue }
        try {
            Remove-Item -LiteralPath $dir.FullName -Recurse -Force
            Write-Log "CLEANUP: pruned trash $($dir.Name)"
        } catch {
            Write-Log "WARN: could not prune trash $($dir.Name) ($($_.Exception.Message))" "WARN"
        }
    }
}

function Get-VolumeKey {
    # Volume identity by path root: "c:" for C:\..., "\\server\share" for UNC.
    # A subst drive or a mount point inside C: is not detected; the guard is
    # about the common mistake (default folder on the system disk).
    param([string]$Path)
    $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
    return $root.TrimEnd('\', '/').ToLowerInvariant()
}

function Write-RunStatus {
    param([hashtable]$Payload)
    $statusDir = Split-Path $StatusFile -Parent
    if (-not (Test-Path $statusDir)) { New-Item -ItemType Directory -Path $statusDir -Force | Out-Null }
    $Payload | ConvertTo-Json -Depth 4 | Set-Content -Path $StatusFile -Encoding UTF8
}

function Exit-Aborted {
    # Fatal pre-flight error: record it where the Control Center reads the
    # last run (status "failed") and exit 2. Nothing has been copied.
    param([string]$Code, [string]$Message)
    Write-RunStatus @{
        last_run    = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK")
        date        = (Get-Date -Format "yyyy-MM-dd")
        dry_run     = [bool]$DryRun
        status      = "failed"
        aborted     = $true
        error_code  = $Code
        error       = $Message
        sources     = $sourcesToRun
        results     = @{}
        backup_root = $BackupRoot
        any_failed  = $true
    }
    [Console]::Error.WriteLine("weekly-backup: ABORT ($Code): $Message")
    exit 2
}

function Assert-Destination {
    # Aborts unless the destination is configured, its drive is mounted and
    # it does not share a volume with any source.
    param([string]$Root, [hashtable]$Targets)
    if (-not $Root) {
        Exit-Aborted "no_destination" ("No backup destination configured: pick one on another drive in " +
            "Settings -> Backups (writes ~/.ultron/.tmp/backup-root.txt) or set ULTRON_BACKUP_ROOT. " +
            "There is no fallback folder on the system disk.")
    }
    $drive = [System.IO.Path]::GetPathRoot($Root)
    if ($drive -and -not (Test-Path -LiteralPath $drive)) {
        Exit-Aborted "drive_missing" "Backup drive not mounted: $drive (destination $Root)."
    }
    if ($env:ULTRON_BACKUP_ALLOW_SAME_VOLUME -eq "1") { return }
    $rootVol = Get-VolumeKey $Root
    $clash = @($Targets.Keys | Where-Object { (Get-VolumeKey $Targets[$_].Source) -eq $rootVol } | Sort-Object)
    if ($clash.Count -gt 0) {
        Exit-Aborted "same_volume" ("Destination $Root is on the same volume ($rootVol) as the sources: " +
            ($clash -join ", ") + ". A mirror on the same disk is not a backup; pick a folder on another drive.")
    }
}

function Remove-OldLogs {
    # Retention (audit N5): keep the newest $Keep dated logs of each kind
    # (backup-<date>.log[.gz] and backup-<date>.robocopy.log[.gz]). The date
    # prefix makes the name order chronological.
    param([string]$Dir, [int]$Keep)
    $kinds = @('^backup-\d{4}-\d{2}-\d{2}\.log(\.gz)?$', '^backup-\d{4}-\d{2}-\d{2}\.robocopy\.log(\.gz)?$')
    foreach ($pattern in $kinds) {
        Get-ChildItem -Path $Dir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match $pattern } |
            Sort-Object Name -Descending | Select-Object -Skip $Keep | ForEach-Object {
                if ($DryRun) {
                    Write-Log "CLEANUP (dry-run): would prune old log $($_.Name)"
                    return
                }
                try {
                    Remove-Item -LiteralPath $_.FullName -Force
                    Write-Log "CLEANUP: pruned old log $($_.Name)"
                } catch {
                    Write-Log "WARN: could not prune $($_.Name) ($($_.Exception.Message))" "WARN"
                }
            }
    }
}

# -- Status mode (early exit) --------------------------------------------------

if ($Status) {
    if (Test-Path $StatusFile) {
        Get-Content $StatusFile -Raw
    } else {
        Write-Output ('{"status": "never_run", "status_file": "' + $StatusFile + '"}')
    }
    exit 0
}

# -- Pre-flight ----------------------------------------------------------------

$sourcesToRun = if ($Source) { @($Source) } else { $Sources }
$targets = @{}
foreach ($src in $sourcesToRun) {
    $targets[$src] = Resolve-BackupTarget -Src $src -Root $(if ($BackupRoot) { $BackupRoot } else { "." })
}
Assert-Destination -Root $BackupRoot -Targets $targets

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
if (-not (Test-Path $BackupRoot)) { New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null }

$DateStr   = Get-Date -Format "yyyy-MM-dd"
$LogFile   = Join-Path $LogDir "backup-$DateStr.log"
# robocopy writes its /LOG+ output in the OEM codepage while Write-Log uses
# Tee-Object (UTF-16LE on PS 5.1). Sharing one file produced an unreadable
# mix of both encodings, which hid the real per-file errors behind exit 9.
# Keep the two streams in separate files so both stay greppable.
$RoboLogFile = Join-Path $LogDir "backup-$DateStr.robocopy.log"

$exclusions = Read-Exclusions -Path $ExclusionsFile
$TrashRoot  = Join-Path $BackupRoot "_borrados"
$TrashDay   = Join-Path $TrashRoot $DateStr
Write-Log "v14.8 BACKUP-WATCH start (DryRun=$DryRun, mode=mirror-overwrite)"
Write-Log "exclusions: $($exclusions.Dirs.Count) dirs - $($exclusions.Files.Count) files"
Write-Log "destination root: $BackupRoot (one folder per source, mirrored)"

# -- Per-source backup ---------------------------------------------------------

$results = @{}
$trashResults = @{}
$anyFailed = $false

foreach ($src in $sourcesToRun) {
    $target  = $targets[$src]
    $srcAbs  = $target.Source
    $destAbs = $target.Dest
    # Only create the destination when the source exists: an empty folder for
    # a missing source used to get a fresh mtime and look like a good mirror.
    if ((Test-Path -LiteralPath $srcAbs) -and -not (Test-Path -LiteralPath $destAbs)) {
        New-Item -ItemType Directory -Path $destAbs -Force | Out-Null
    }
    $trash = Protect-PurgedFiles -SourcePath $srcAbs -DestPath $destAbs `
        -TrashDir (Join-Path $TrashDay (Split-Path -Leaf $destAbs)) `
        -ExcludeDirs $exclusions.Dirs -ExcludeFiles $exclusions.Files -DryRunFlag:$DryRun
    $r = Invoke-Robocopy -SourcePath $srcAbs -DestPath $destAbs `
        -ExcludeDirs $exclusions.Dirs -ExcludeFiles $exclusions.Files `
        -LogPath $RoboLogFile -DryRunFlag:$DryRun -NoPurge:(-not $trash.Purge)
    # Kept apart from $r: Write-Log echoes to the pipeline, so $r is an array
    # (log line + hashtable) whose members can be read but not assigned.
    $trashResults[$src] = $trash
    $results[$src] = $r
    if ($r.Skipped) {
        # A configured source that does not exist is a failure, not a skip:
        # otherwise the run reports success and nothing was backed up.
        $anyFailed = $true
        Write-Log "FAIL: $src source missing ($srcAbs)" "ERROR"
    } elseif (-not (Test-RobocopyOk -Code $r.Code)) {
        $anyFailed = $true
        Write-Log "FAIL: $src robocopy exit code $($r.Code)" "ERROR"
    } else {
        Write-Log "OK: $src robocopy exit code $($r.Code)"
        # v15.4.7 - touch the destination mtime so the Doctor backup-stale
        # detector (control-center/src-tauri/src/backup_status.rs) sees a
        # fresh timestamp even when robocopy /MIR had no deltas to apply.
        # Without this, a successful no-op run leaves the badge orange.
        if (-not $DryRun -and (Test-Path -LiteralPath $destAbs)) {
            try {
                (Get-Item -LiteralPath $destAbs).LastWriteTime = Get-Date
            } catch {
                Write-Log "WARN: could not touch mtime on $destAbs ($($_.Exception.Message))" "WARN"
            }
        }
    }
}

# -- brain.db consistent snapshot (v14.8, MEM-AUD backup 2026-07-27) ----------
# robocopy copies brain.db while the memory daemon may be writing, so the
# mirror copy can be internally inconsistent. VACUUM INTO produces a
# transactionally consistent snapshot even with concurrent writers. Snapshots
# are dated and pruned to the newest $KeepWeeks generations.

$BrainDb     = Join-Path $env:USERPROFILE ".ultron\brain.db"
$SnapshotDir = Join-Path $BackupRoot "brain-snapshots"
$snapshotOk  = $null
if (-not $DryRun -and -not $Source -and (Test-Path $BrainDb)) {
    if (-not (Test-Path $SnapshotDir)) { New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null }
    $SnapshotPath = Join-Path $SnapshotDir "brain-$DateStr.db"
    # VACUUM INTO refuses to overwrite: drop a same-day previous/partial file.
    if (Test-Path $SnapshotPath) { Remove-Item -Path $SnapshotPath -Force }
    $pyCode = "import sqlite3; con = sqlite3.connect(r'$BrainDb'); con.execute('VACUUM INTO ?', (r'$SnapshotPath',)); con.close()"
    try {
        $pyOut = & uv run --no-project python -c $pyCode 2>&1
        $pyExit = $LASTEXITCODE
    } catch {
        $pyOut = $_.Exception.Message
        $pyExit = -1
    }
    $snapshotOk = ($pyExit -eq 0) -and (Test-Path $SnapshotPath) -and ((Get-Item $SnapshotPath).Length -gt 1MB)
    if ($snapshotOk) {
        $snapMb = [math]::Round((Get-Item $SnapshotPath).Length / 1MB, 1)
        Write-Log "OK: brain.db snapshot (VACUUM INTO) -> $SnapshotPath ($snapMb MB)"
        # Retention: keep the newest $KeepWeeks dated snapshots.
        Get-ChildItem -Path $SnapshotDir -Filter "brain-*.db" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -Skip $KeepWeeks | ForEach-Object {
                Write-Log "CLEANUP: pruning old brain snapshot $($_.Name)"
                Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
            }
    } else {
        $anyFailed = $true
        $errTxt = ("$pyOut" -replace '\s+', ' ')
        if ($errTxt.Length -gt 300) { $errTxt = $errTxt.Substring(0, 300) }
        Write-Log "FAIL: brain.db snapshot exit=$pyExit $errTxt" "ERROR"
        if (Test-Path $SnapshotPath) { Remove-Item -Path $SnapshotPath -Force -ErrorAction SilentlyContinue }
    }
}

# -- Retention prune -----------------------------------------------------------

if (-not $Source) {
    # Mirror mode does not retain history. Sweep any leftover dated subdirs
    # from the previous (history-keeping) version of this script.
    Remove-LegacyDatedBackups -Root $BackupRoot
}
Remove-OldTrash -TrashRoot $TrashRoot -Days $TrashDays

# -- Persist status ------------------------------------------------------------

$statusPayload = @{
    last_run        = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK")
    date            = $DateStr
    dry_run         = [bool]$DryRun
    status          = $(if ($anyFailed) { "failed" } else { "ok" })
    aborted         = $false
    sources         = $sourcesToRun
    results         = @{}
    log             = $LogFile
    robocopy_log    = $RoboLogFile
    backup_root     = $BackupRoot
    keep_weeks      = $KeepWeeks
    trash_root      = $TrashRoot
    trash_days      = $TrashDays
    brain_snapshot  = $snapshotOk
    any_failed      = [bool]$anyFailed
}
foreach ($k in $results.Keys) {
    $okCode = (Test-RobocopyOk -Code $results[$k].Code)
    # `failed` is what the Control Center reads (backup_status.rs): a missing
    # source counts as a failure.
    $statusPayload.results[$k] = @{
        code    = $results[$k].Code
        skipped = $results[$k].Skipped
        ok      = $okCode
        failed  = ($results[$k].Skipped -or -not $okCode)
        source  = $targets[$k].Source
        dest    = $targets[$k].Dest
        trash_moved  = $trashResults[$k].Moved
        trash_failed = $trashResults[$k].Failed
        purged       = [bool]$trashResults[$k].Purge
    }
}
Write-RunStatus $statusPayload

Write-Log "v14.8 BACKUP-WATCH end - failed=$anyFailed"

# Log retention runs last, once both of today's logs exist.
Remove-OldLogs -Dir $LogDir -Keep $KeepLogs

if ($anyFailed) { exit 1 } else { exit 0 }
