# bootstrap.ps1 - ULTRON one-shot installer (v15.4.17+)
#
# Run from anywhere on Windows:
#   iwr -useb https://raw.githubusercontent.com/SkiTemplar/ultron-control-center/main/bootstrap.ps1 | iex
#
# Or download + run:
#   curl -L -o ultron-bootstrap.ps1 https://raw.githubusercontent.com/SkiTemplar/ultron-control-center/main/bootstrap.ps1
#   pwsh -ExecutionPolicy Bypass -File ultron-bootstrap.ps1
#
# What it does (no git clone required):
#   1. Fetches the latest GitHub release of the public repo (SkiTemplar/ultron-control-center).
#   2. Downloads the `ultron-system-<ver>.zip` asset and extracts to ~/.ultron.
#   3. Downloads the `ULTRON Control Center_<ver>_x64-setup.exe` installer and
#      verifies it against the SHA-256 published with the release.
#   4. Runs install.ps1 (which wires skills / agents / hooks / Qdrant).
#   5. Launches the Control Center installer interactively.
#
# Idempotent: re-running upgrades to the latest release. Local edits under
# ~/.ultron-vault and ~/.ultron/plans are preserved (the system ZIP only
# replaces tracked files).

[CmdletBinding()]
param(
    [string]$Repo = "SkiTemplar/ultron-control-center",
    [string]$InstallDir = "$env:USERPROFILE\.ultron",
    [switch]$SkipInstaller,
    [switch]$DryRun,
    # v15.5.14: refuse to extract an unsigned ZIP unless the caller explicitly
    # opts in. Default OFF preserves supply-chain integrity in the (rare) case
    # where the release maintainer forgot to publish the .sha256 sidecar.
    [switch]$AllowUnsignedZip,
    # Same opt-in for the Control Center installer: without its .sha256 sidecar the
    # .exe is not executed unless the caller explicitly accepts it.
    [switch]$AllowUnverifiedInstaller
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step($msg) {
    Write-Host "[ULTRON-BOOT] $msg" -ForegroundColor Cyan
}
function Write-Warn($msg) {
    Write-Host "[ULTRON-BOOT][warn] $msg" -ForegroundColor Yellow
}
function Write-Err($msg) {
    Write-Host "[ULTRON-BOOT][error] $msg" -ForegroundColor Red
}

Write-Step "Repo: $Repo"
Write-Step "Install dir: $InstallDir"

# 1. Resolve latest release
$apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
Write-Step "Fetching latest release manifest from $apiUrl"
try {
    $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "ultron-bootstrap" }
} catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 404) {
        Write-Err "$Repo has no published release (HTTP 404). Use the clone path from INSTALL.md:"
        Write-Err "  git clone https://github.com/$Repo.git `$env:USERPROFILE\.ultron; cd `$env:USERPROFILE\.ultron; .\install.ps1"
    } else {
        Write-Err "Failed to fetch latest release: $_"
    }
    exit 2
}

$tag = $release.tag_name
Write-Step "Latest tag: $tag"

$expectedZip = "ultron-system-$tag.zip"
# Match both legacy (space-separated) and the current tauri-action
# output (dot-separated: "ULTRON.Control.Center_*_x64-setup.exe").
$installerPattern = "^ULTRON[ .]Control[ .]Center_.*_x64-setup\.exe$"

# Strict matching: bind the ZIP name to the tag, require exactly one
# installer match. Wildcards used to accept stale duplicates / spoofed
# assets (codex review v15.4.17).
$systemAsset = $release.assets | Where-Object { $_.name -eq $expectedZip }
$installerCandidates = @($release.assets | Where-Object { $_.name -match $installerPattern })
$installerAsset = if ($installerCandidates.Count -eq 1) { $installerCandidates[0] } else { $null }

if (-not $systemAsset) {
    Write-Err "Release $tag does not include the expected asset '$expectedZip'. Cannot bootstrap."
    exit 3
}
if ($installerCandidates.Count -gt 1) {
    Write-Err "Release $tag has multiple installers matching '$installerPattern'. Refusing to guess."
    exit 3
}
if ($installerCandidates.Count -eq 0 -and -not $SkipInstaller) {
    Write-Warn "Release $tag has no Control Center installer; will install the system layer only."
    Write-Warn "Re-run with -SkipInstaller to suppress this warning, or wait for a fully built release."
}

# 2. Download system ZIP
$tmpDir = Join-Path $env:TEMP "ultron-bootstrap-$tag"
if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
New-Item -ItemType Directory -Path $tmpDir | Out-Null

$zipPath = Join-Path $tmpDir $systemAsset.name
Write-Step "Downloading system ZIP ($([math]::Round($systemAsset.size / 1MB, 1)) MB) -> $zipPath"
if (-not $DryRun) {
    Invoke-WebRequest -Uri $systemAsset.browser_download_url -OutFile $zipPath
}

# 2b. SHA256 verification - review audit v15.4.18: the release publishes
# a .zip.sha256 manifest; without checking it, tag-pinning is theatre. A
# tampered or partial download silently corrupts ~/.ultron. Hard-fail if
# the manifest is present and the hashes diverge.
$shaAsset = $release.assets | Where-Object { $_.name -eq "$expectedZip.sha256" } | Select-Object -First 1
if ($shaAsset -and -not $DryRun) {
    $shaTmp = Join-Path $tmpDir "$expectedZip.sha256"
    Write-Step "Fetching $($shaAsset.name) for integrity check"
    Invoke-WebRequest -Uri $shaAsset.browser_download_url -OutFile $shaTmp
    $expectedSha = (Get-Content $shaTmp -Raw).Trim().Split()[0].ToLower()
    $actualSha = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLower()
    if ($expectedSha -ne $actualSha) {
        Write-Err "SHA256 mismatch - ZIP corrupt or tampered."
        Write-Err "  expected: $expectedSha"
        Write-Err "  actual:   $actualSha"
        exit 5
    }
    Write-Step "SHA256 verified: $actualSha"
} elseif (-not $shaAsset) {
    if ($AllowUnsignedZip) {
        Write-Warn "Release $tag does not include $expectedZip.sha256 - proceeding WITHOUT integrity check (-AllowUnsignedZip)."
    } else {
        Write-Err "Release $tag does not include $expectedZip.sha256 and -AllowUnsignedZip was NOT passed."
        Write-Err "Refusing to extract an unsigned ZIP. Re-run with -AllowUnsignedZip to bypass (NOT recommended)."
        exit 5
    }
}

# 3. Extract over $InstallDir
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
}
Write-Step "Extracting to $InstallDir"
if (-not $DryRun) {
    Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
}

# 4. Run install.ps1
$installScript = Join-Path $InstallDir "install.ps1"
if (-not (Test-Path $installScript)) {
    Write-Err "install.ps1 missing after extract: $installScript"
    exit 4
}

Write-Step "Running install.ps1 (skills + agents + hooks wiring)"
if (-not $DryRun) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript
    $installExit = $LASTEXITCODE
    if ($installExit -ne 0) {
        # Don't silently launch the Control Center installer over a broken
        # base system - surface the failure and stop (codex review v15.4.17).
        Write-Err "install.ps1 exited with code $installExit. Bootstrap aborted."
        Write-Err "Investigate the log above; fix the issue; re-run bootstrap.ps1."
        exit $installExit
    }
}

# 5. Launch Control Center installer
if ($SkipInstaller -or -not $installerAsset) {
    Write-Step "Skipping Control Center installer (--SkipInstaller or no asset)."
} else {
    $exePath = Join-Path $tmpDir $installerAsset.name
    Write-Step "Downloading Control Center installer ($([math]::Round($installerAsset.size / 1MB, 1)) MB)"
    if (-not $DryRun) {
        Invoke-WebRequest -Uri $installerAsset.browser_download_url -OutFile $exePath
        # Same check as the ZIP: never execute an .exe whose hash does not match.
        $exeShaName = "$($installerAsset.name).sha256"
        $exeShaAsset = $release.assets | Where-Object { $_.name -eq $exeShaName } | Select-Object -First 1
        if ($exeShaAsset) {
            $exeShaTmp = Join-Path $tmpDir $exeShaName
            Invoke-WebRequest -Uri $exeShaAsset.browser_download_url -OutFile $exeShaTmp
            $expectedExeSha = (Get-Content $exeShaTmp -Raw).Trim().Split()[0].ToLower()
            $actualExeSha = (Get-FileHash -Algorithm SHA256 -Path $exePath).Hash.ToLower()
            if ($expectedExeSha -ne $actualExeSha) {
                Remove-Item -LiteralPath $exePath -Force -ErrorAction SilentlyContinue
                Write-Err "SHA256 mismatch - installer corrupt or tampered. Not executed."
                Write-Err "  expected: $expectedExeSha"
                Write-Err "  actual:   $actualExeSha"
                exit 5
            }
            Write-Step "Installer SHA256 verified: $actualExeSha"
        } elseif ($AllowUnverifiedInstaller) {
            Write-Warn "Release $tag does not include $exeShaName - running the installer WITHOUT integrity check (-AllowUnverifiedInstaller)."
        } else {
            Write-Err "Release $tag does not include $exeShaName and -AllowUnverifiedInstaller was NOT passed."
            Write-Err "Refusing to run an unverified installer. The system layer is installed; re-run with -SkipInstaller, or -AllowUnverifiedInstaller to bypass (NOT recommended)."
            exit 5
        }
        Write-Step "Launching installer (Windows SmartScreen may warn - click More info -> Run anyway)"
        Start-Process -FilePath $exePath -Wait
    }
}

Write-Host ""
Write-Host "[ULTRON-BOOT] Done. System at $InstallDir" -ForegroundColor Green
Write-Host "[ULTRON-BOOT] If you also installed the Control Center, launch it from the Start menu." -ForegroundColor Green
