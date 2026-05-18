param(
    [int]$MaxWaitSec = 60,
    [int]$PollSec = 3
)

# ensure-qdrant.ps1 - background hook called from the ULTRON-QdrantBoot
# scheduled task (and SessionStart). Goal: when the user logs in, guarantee
# Qdrant is up *eventually*, without blocking. Status to
# ~/.ultron/.tmp/qdrant-health.json for the panel + context_primer.
#
# Strategy (v15.0.2+: Docker eliminado):
#   1. Probe http://localhost:6333/healthz. Si responde, done.
#   2. Si no, lanzar el binario nativo ~/.ultron/qdrant-native/qdrant.exe
#      hidden y esperar healthz (60s).
#   3. Si el binario no existe o no arranca → status native-failed/missing.
#
# Exit codes:
#   0 up             - healthz 200 from someone
#   3 unhealthy      - service answered but not 200
#   6 native-failed  - native binary present but won't start
#   7 native-missing - native binary not installed at all

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
# Phase 3: No native binary installed.
# ========================================================================
Write-State -Status 'native-missing' -Message "Native qdrant.exe not found at $nativeExe. Reinstall with the v15.0.2 setup steps (download v1.18.0 windows zip)." -ElapsedSec 0
exit 7
