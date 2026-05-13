param(
    [int]$MaxWaitSec = 60,
    [int]$PollSec = 3
)

# ensure-qdrant.ps1 - background hook called from the ULTRON-QdrantBoot
# scheduled task (and SessionStart). Goal: when the user logs in, guarantee
# Qdrant is up *eventually*, without blocking. Status to
# ~/.ultron/.tmp/qdrant-health.json for the panel + context_primer.
#
# v15.0.2 strategy (native-first, Docker fallback):
#   1. Probe http://localhost:6333/healthz directly. If anything is already
#      serving on 6333 (native qdrant.exe, Docker container, whatever) we
#      are done.
#   2. If no one answers and we have a native binary at
#      ~/.ultron/qdrant-native/qdrant.exe → launch it hidden and wait for
#      healthz. This is the primary path now — Docker is not required.
#   3. If native binary missing AND Docker daemon is reachable → fall back
#      to the legacy Docker flow (existing container OR recreate it with
#      the bind-mount).
#   4. If both paths fail, write a status the panel can surface.
#
# Exit codes:
#   0 up                     - healthz 200 from somebody
#   1 daemon-down            - neither native nor Docker can be used
#   2 container-create-failed- Docker available but `docker run` failed
#   3 unhealthy              - service answered but not 200
#   4 unreachable            - service not responding after launch attempt
#   5 disk-missing           - Docker WSL distro on unmounted drive (legacy)
#   6 native-failed          - native binary present but won't start

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

function Test-Healthz {
    param([int]$TimeoutSec = 3)
    try {
        $r = Invoke-WebRequest -Uri 'http://localhost:6333/healthz' -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

# ========================================================================
# Phase 1: probe healthz first. If anyone's already serving, we're done.
# ========================================================================
if (Test-Healthz) {
    Write-State -Status 'up' -Message 'Qdrant healthz OK (already running)' -ElapsedSec 0
    exit 0
}

# ========================================================================
# Phase 2: try native qdrant.exe (primary path post-v15.0.2).
# ========================================================================
$nativeDir = "$env:USERPROFILE\.ultron\qdrant-native"
$nativeExe = Join-Path $nativeDir 'qdrant.exe'
$nativeCfg = 'config\production.yaml'

if (Test-Path $nativeExe) {
    # Kill any lingering qdrant.exe that may be in a bad state.
    $stale = Get-Process -Name 'qdrant' -ErrorAction SilentlyContinue
    if ($stale) {
        $stale | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    $logFile = Join-Path $tmpDir 'qdrant-native.log'
    $errFile = Join-Path $tmpDir 'qdrant-native.err'

    try {
        Start-Process -FilePath $nativeExe `
            -WorkingDirectory $nativeDir `
            -ArgumentList '--config-path', $nativeCfg `
            -RedirectStandardOutput $logFile `
            -RedirectStandardError  $errFile `
            -WindowStyle Hidden -ErrorAction Stop | Out-Null
    } catch {
        Write-State -Status 'native-failed' -Message "Start-Process failed: $($_.Exception.Message)" -ElapsedSec 0
        exit 6
    }

    # Wait up to 60s for the native binary to start serving. The binary
    # itself boots in <1s per its own logs, but Windows + AV scanning + first
    # JIT can stretch first-boot end-to-end visible time. 60s is generous
    # margin; the scheduled task ExecutionTimeLimit is 5min so no risk.
    $elapsed = 0
    while ($elapsed -lt 60) {
        Start-Sleep -Seconds 2
        $elapsed += 2
        if (Test-Healthz -TimeoutSec 2) {
            Write-State -Status 'up' -Message "Qdrant native binary up (${elapsed}s warm-up)" -ElapsedSec $elapsed
            exit 0
        }
    }

    Write-State -Status 'native-failed' -Message "Native qdrant.exe launched but healthz unreachable after ${elapsed}s. See $logFile" -ElapsedSec $elapsed
    exit 6
}

# ========================================================================
# Phase 3: Docker fallback (legacy path).
# ========================================================================

# Pre-flight: Docker WSL distro on a secondary drive that's unmounted?
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
} catch { }

# Try to launch Docker Desktop if not running.
$dockerProc = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
if (-not $dockerProc) {
    $exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    if (Test-Path $exe) {
        Start-Process $exe -WindowStyle Hidden -ErrorAction SilentlyContinue
    }
}

# Wait for daemon.
$elapsed = 0
$daemonUp = $false
while ($elapsed -lt $MaxWaitSec) {
    $null = docker info --format '{{.ServerVersion}}' 2>$null
    if ($LASTEXITCODE -eq 0) {
        # docker info can return exit 0 with body 500. Probe for a real OK.
        $probeOut = docker info --format '{{.ServerVersion}}' 2>&1
        if ($probeOut -notmatch '500') {
            $daemonUp = $true
            break
        }
    }
    Start-Sleep -Seconds $PollSec
    $elapsed += $PollSec
}

if (-not $daemonUp) {
    Write-State -Status 'daemon-down' -Message "Docker daemon not ready after ${MaxWaitSec}s (and no native binary at $nativeExe)" -ElapsedSec $elapsed
    exit 1
}

$state = docker ps -a --filter 'name=^ultron-qdrant$' --format '{{.State}}' 2>$null
if (-not $state) {
    $storageDir = "$env:USERPROFILE\.ultron\qdrant_storage"
    if (-not (Test-Path $storageDir)) {
        New-Item -ItemType Directory -Path $storageDir -Force | Out-Null
    }

    $createOut = docker run -d `
        --name ultron-qdrant `
        --restart unless-stopped `
        -p 6333:6333 -p 6334:6334 `
        -v "${storageDir}:/qdrant/storage" `
        qdrant/qdrant 2>&1
    $createExit = $LASTEXITCODE

    if ($createExit -ne 0) {
        $createMsg = ($createOut | Out-String).Trim()
        Write-State -Status 'container-create-failed' -Message "docker run failed: $createMsg" -ElapsedSec $elapsed
        exit 2
    }

    Start-Sleep -Seconds 4
    $state = 'running'
} elseif ($state -ne 'running') {
    $null = docker start ultron-qdrant 2>$null
    Start-Sleep -Seconds 3
}

if (Test-Healthz -TimeoutSec 5) {
    Write-State -Status 'up' -Message 'Qdrant via Docker container' -ElapsedSec $elapsed
    exit 0
}

Write-State -Status 'unreachable' -Message 'Docker container up but healthz not responding' -ElapsedSec $elapsed
exit 4
