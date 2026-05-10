# ULTRON v14.7 BACKUP-WATCH — weekly robocopy backup (mirror, overwrite)
#
# Backs up USER's data sources to D:\USER\BACKUP\<src>\ (NO dated subdir).
# Each run overwrites the previous mirror via robocopy /MIR — single up-to-date
# snapshot, no history. Logs are still dated (~/.ultron/logs/backup-<DATE>.log).
# Reads exclusions from ~/.ultron/config/backup-exclusions.txt (gitignore-style).
# Designed to run via Task Scheduler ONLOGON (weekly trigger). Idempotent and
# safe: /MIR removes destination files no longer in source.
#
# Usage:
#   weekly-backup.ps1                     # run real backup
#   weekly-backup.ps1 -DryRun              # log what would happen, no copy
#   weekly-backup.ps1 -Source CARRERA      # restrict to a single source
#   weekly-backup.ps1 -Status              # print last-run summary, exit
#
# -KeepWeeks is accepted but ignored (kept for backward compat). Mirror mode
# does not retain history.
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

$Sources = @(
    "CARRERA",
    "PERSONAL",
    ".ultron",
    ".ultron-vault",
    ".claude"
)

$BackupRoot      = "D:\USER\BACKUP"
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

if (-not (Test-Path "D:\")) {
    Write-Error "D: drive not mounted. Aborting backup."
    exit 2
}
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
if (-not (Test-Path $BackupRoot)) { New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null }

$DateStr   = Get-Date -Format "yyyy-MM-dd"
$LogFile   = Join-Path $LogDir "backup-$DateStr.log"

$exclusions = Read-Exclusions -Path $ExclusionsFile
Write-Log "v14.7 BACKUP-WATCH start (DryRun=$DryRun, mode=mirror-overwrite)"
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

Write-Log "v14.7 BACKUP-WATCH end · failed=$anyFailed"

if ($anyFailed) { exit 1 } else { exit 0 }
