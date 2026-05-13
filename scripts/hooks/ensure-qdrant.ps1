param(
    [int]$MaxWaitSec = 60,
    [int]$PollSec = 3
)

# ensure-qdrant.ps1 - background hook called from session-init.
# Goal: when Claude opens a session, guarantee Qdrant is up *eventually*,
# without blocking SessionStart. Writes status to
# ~/.ultron/.tmp/qdrant-health.json for context_primer to read next turn.
#
# Exit codes:
#   0  up                - daemon UP, container running, healthz 200
#   1  daemon-down       - Docker daemon never came up within MaxWaitSec
#   2  container-missing - ultron-qdrant does not exist (setup needed)
#   3  unhealthy         - healthz returned non-200
#   4  unreachable       - healthz network error
#   5  disk-missing      - Docker config points WSL distro to a drive that is not mounted

$tmpDir = "$env:USERPROFILE\.ultron\.tmp"
if (-not (Test-Path $tmpDir)) {
    New-Item -ItemType Directory -Path $tmpDir -Force -ErrorAction SilentlyContinue | Out-Null
}
$out = Join-Path $tmpDir "qdrant-health.json"

function Write-State {
    param(
        [string]$Status,
        [string]$Message,
        [int]$ElapsedSec = 0
    )
    $obj = [ordered]@{
        status      = $Status
        message     = $Message
        elapsed_sec = $ElapsedSec
        timestamp   = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')
    } | ConvertTo-Json
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($out, $obj, $utf8)
}

$elapsed = 0
$daemonUp = $false

# Pre-flight: if Docker is configured to put the WSL distro on a secondary
# drive (e.g. D:\Docker), verify that drive is mounted BEFORE launching Docker.
# Skipping this check is how we lost the engine this morning: D: was unmounted,
# Docker booted, the daemon crashed silently on `mkdir D:\Docker`, and the only
# evidence was a GitHub-issue-style error buried in logs.
try {
    $dockerCfg = "$env:APPDATA\Docker\settings-store.json"
    if (Test-Path $dockerCfg) {
        $cfgObj = Get-Content $dockerCfg -Raw | ConvertFrom-Json
        $wslDir = $cfgObj.CustomWslDistroDir
        if ($wslDir) {
            $driveLetter = (Split-Path -Qualifier $wslDir).TrimEnd(':')
            $driveRoot = $driveLetter + ':\'
            if (-not (Test-Path $driveRoot)) {
                $msg = "Docker config points WSL distro to '" + $wslDir + "' but drive " + $driveRoot + " is not mounted. Mount the drive and re-run."
                Write-State -Status 'disk-missing' -Message $msg -ElapsedSec 0
                exit 5
            }
        }
    }
} catch {
    # Config read failure is non-fatal — proceed to standard flow.
}

# Single attempt to launch Docker Desktop if not running. Spam-launch guard.
$dockerProc = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
if (-not $dockerProc) {
    $exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    if (Test-Path $exe) {
        Start-Process $exe -WindowStyle Hidden -ErrorAction SilentlyContinue
    }
}

while ($elapsed -lt $MaxWaitSec) {
    $null = docker info --format '{{.ServerVersion}}' 2>$null
    if ($LASTEXITCODE -eq 0) {
        $daemonUp = $true
        break
    }
    Start-Sleep -Seconds $PollSec
    $elapsed += $PollSec
}

if (-not $daemonUp) {
    Write-State -Status 'daemon-down' -Message "Docker daemon not ready after ${MaxWaitSec}s" -ElapsedSec $elapsed
    exit 1
}

$state = docker ps -a --filter 'name=^ultron-qdrant$' --format '{{.State}}' 2>$null
if (-not $state) {
    Write-State -Status 'container-missing' -Message 'ultron-qdrant container does not exist - run setup' -ElapsedSec $elapsed
    exit 2
}

if ($state -ne 'running') {
    $null = docker start ultron-qdrant 2>$null
    Start-Sleep -Seconds 3
}

$probeOk = $false
$probeMsg = ''
$probeCode = 0
try {
    $r = Invoke-WebRequest -Uri 'http://localhost:6333/healthz' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    $probeCode = [int]$r.StatusCode
    if ($probeCode -eq 200) {
        $probeOk = $true
    } else {
        $probeMsg = 'healthz returned ' + $probeCode
    }
} catch {
    $probeMsg = 'healthz unreachable: ' + $_.Exception.Message
}

if ($probeOk) {
    Write-State -Status 'up' -Message 'Qdrant healthz OK' -ElapsedSec $elapsed
    exit 0
}
if ($probeCode -gt 0) {
    Write-State -Status 'unhealthy' -Message $probeMsg -ElapsedSec $elapsed
    exit 3
}
Write-State -Status 'unreachable' -Message $probeMsg -ElapsedSec $elapsed
exit 4
