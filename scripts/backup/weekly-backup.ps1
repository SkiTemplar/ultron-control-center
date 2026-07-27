# ULTRON v14.8 BACKUP-WATCH — weekly robocopy backup (mirror, overwrite)
#
# Backs up the user's data sources to $env:BACKUP_ROOT\<src>\ (NO dated subdir).
# Each run overwrites the previous mirror via robocopy /MIR — single up-to-date
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
# history.
#
# Exit codes:
#   0 success / nothing to do
#   1 partial (some sources failed)
#   2 fatal (D: drive missing, exclusions file missing, etc.)
#
# Sources are anchored at $env:USERPROFILE. Paths configured below.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$Source = "",
    [int]$KeepWeeks = 4,
    [switch]$Status
)

$ErrorActionPreference = "Stop"

# ── Configuration ──────────────────────────────────────────────────────────────

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
# control-center/src-tauri/src/backup_status.rs::backup_root():
#   1. ~/.ultron/.tmp/backup-root.txt        (set via Settings -> Backups UI)
#   2. $env:ULTRON_BACKUP_ROOT               (CLI / Task Scheduler override)
#   3. D:\BACKUP if mounted                  (legacy convention)
#   4. $env:USERPROFILE\BACKUP               (fresh-install fallback)
#
# v2.7 fix: prior versions only read step (2), so when the user picked a
# destination through the Control Center UI (which writes step 1 only,
# and sets the env var ONLY in the live Tauri process) any subsequent
# Force-Backup-Now invocation after a Control Center restart silently
# fell back to %USERPROFILE%\BACKUP — leaving the configured D:\... empty
# and the "last backup" badge stuck on the old C: mirror.
$BackupRootFile  = Join-Path $env:USERPROFILE ".ultron\.tmp\backup-root.txt"
$BackupRoot      = $null
if (Test-Path $BackupRootFile) {
    try {
        $fileVal = (Get-Content -Raw -Path $BackupRootFile -Encoding UTF8).Trim()
        if ($fileVal) { $BackupRoot = $fileVal }
    } catch {
        Write-Warning "Could not read $BackupRootFile ($_) - falling back to env/defaults."
    }
}
if (-not $BackupRoot -and $env:ULTRON_BACKUP_ROOT) {
    $BackupRoot = $env:ULTRON_BACKUP_ROOT
}
if (-not $BackupRoot -and (Test-Path "D:\BACKUP")) {
    $BackupRoot = "D:\BACKUP"
}
if (-not $BackupRoot) {
    $BackupRoot = Join-Path $env:USERPROFILE "BACKUP"
}
$ExclusionsFile  = Join-Path $env:USERPROFILE ".ultron\config\backup-exclusions.txt"
$LogDir          = Join-Path $env:USERPROFILE ".ultron\logs"
$StatusFile      = Join-Path $env:USERPROFILE ".ultron\.tmp\backup-last-run.json"

# ── Helpers ────────────────────────────────────────────────────────────────────

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
        [switch]$DryRunFlag
    )
    if (-not (Test-Path $SourcePath)) {
        Write-Log "SKIP: source missing: $SourcePath" "WARN"
        return @{ Code = 16; Skipped = $true }
    }
    $args = @(
        $SourcePath, $DestPath,
        "/MIR",        # mirror — match source exactly under dated dest
        "/R:1",        # 1 retry on locked files
        "/W:5",        # 5s wait between retries
        "/MT:8",       # 8 multi-threaded copies
        "/NP",         # no progress %
        "/NDL",        # no directory list
        "/NJH",        # no job header
        "/NJS",        # no job summary (we capture summary ourselves via exit code)
        "/LOG+:$LogPath"
    )
    if ($DryRunFlag) { $args += "/L" }
    if ($ExcludeDirs.Count -gt 0)  { $args += "/XD"; $args += $ExcludeDirs }
    if ($ExcludeFiles.Count -gt 0) { $args += "/XF"; $args += $ExcludeFiles }

    Write-Log "robocopy $SourcePath -> $DestPath ($(if($DryRunFlag){'DRY-RUN'}else{'COPY'}))"
    & robocopy @args | Out-Null
    return @{ Code = $LASTEXITCODE; Skipped = $false }
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

# ── Status mode (early exit) ──────────────────────────────────────────────────

if ($Status) {
    if (Test-Path $StatusFile) {
        Get-Content $StatusFile -Raw
    } else {
        Write-Output '{"status": "never_run", "status_file": "' + $StatusFile + '"}'
    }
    exit 0
}

# ── Pre-flight ────────────────────────────────────────────────────────────────

# Verify the parent drive of $BackupRoot exists (e.g. "D:\" if BackupRoot is
# "D:\BACKUP"). Skip the check when BackupRoot lives under %USERPROFILE%
# because the C: drive is always present on Windows.
$backupDrive = ([System.IO.Path]::GetPathRoot($BackupRoot))
if ($backupDrive -and -not (Test-Path $backupDrive)) {
    Write-Error "Backup drive not mounted: $backupDrive. Aborting backup."
    exit 2
}
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
if (-not (Test-Path $BackupRoot)) { New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null }

$DateStr   = Get-Date -Format "yyyy-MM-dd"
$LogFile   = Join-Path $LogDir "backup-$DateStr.log"

$exclusions = Read-Exclusions -Path $ExclusionsFile
Write-Log "v14.8 BACKUP-WATCH start (DryRun=$DryRun, mode=mirror-overwrite)"
Write-Log "exclusions: $($exclusions.Dirs.Count) dirs · $($exclusions.Files.Count) files"
Write-Log "destination root: $BackupRoot (one folder per source, mirrored)"

# ── Per-source backup ─────────────────────────────────────────────────────────

$sourcesToRun = if ($Source) { @($Source) } else { $Sources }
$results = @{}
$anyFailed = $false

foreach ($src in $sourcesToRun) {
    $srcAbs  = Join-Path $env:USERPROFILE $src
    $destAbs = Join-Path $BackupRoot $src.TrimStart(".").TrimStart("\")
    if ($src.StartsWith(".")) {
        # Hidden source: preserve a non-leading-dot name on dest for explorer friendliness
        $destAbs = Join-Path $BackupRoot ("dot-" + $src.TrimStart("."))
    }
    if (-not (Test-Path $destAbs)) { New-Item -ItemType Directory -Path $destAbs -Force | Out-Null }
    $r = Invoke-Robocopy -SourcePath $srcAbs -DestPath $destAbs `
        -ExcludeDirs $exclusions.Dirs -ExcludeFiles $exclusions.Files `
        -LogPath $LogFile -DryRunFlag:$DryRun
    $results[$src] = $r
    if (-not (Test-RobocopyOk -Code $r.Code) -and -not $r.Skipped) {
        $anyFailed = $true
        Write-Log "FAIL: $src robocopy exit code $($r.Code)" "ERROR"
    } else {
        Write-Log "OK: $src robocopy exit code $($r.Code)"
        # v15.4.7 — touch the destination mtime so the Doctor backup-stale
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

# ── brain.db consistent snapshot (v14.8, MEM-AUD backup 2026-07-27) ──────────
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

# ── Retention prune ───────────────────────────────────────────────────────────

if (-not $Source) {
    # Mirror mode does not retain history. Sweep any leftover dated subdirs
    # from the previous (history-keeping) version of this script.
    Remove-LegacyDatedBackups -Root $BackupRoot
}

# ── Persist status ────────────────────────────────────────────────────────────

$statusPayload = @{
    last_run        = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK")
    date            = $DateStr
    dry_run         = [bool]$DryRun
    sources         = $sourcesToRun
    results         = @{}
    log             = $LogFile
    backup_root     = $BackupRoot
    keep_weeks      = $KeepWeeks
    brain_snapshot  = $snapshotOk
}
foreach ($k in $results.Keys) {
    $statusPayload.results[$k] = @{
        code    = $results[$k].Code
        skipped = $results[$k].Skipped
        ok      = (Test-RobocopyOk -Code $results[$k].Code)
    }
}
$statusDir = Split-Path $StatusFile -Parent
if (-not (Test-Path $statusDir)) { New-Item -ItemType Directory -Path $statusDir -Force | Out-Null }
$statusPayload | ConvertTo-Json -Depth 4 | Set-Content -Path $StatusFile -Encoding UTF8

Write-Log "v14.8 BACKUP-WATCH end · failed=$anyFailed"

if ($anyFailed) { exit 1 } else { exit 0 }
