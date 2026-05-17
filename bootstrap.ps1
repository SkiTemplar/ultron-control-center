# bootstrap.ps1 — ULTRON one-shot installer (v15.4.17+)
#
# Run from anywhere on Windows:
#   iwr -useb https://raw.githubusercontent.com/SkiTemplar/ultron/main/bootstrap.ps1 | iex
#
# Or download + run:
#   curl -L -o ultron-bootstrap.ps1 https://raw.githubusercontent.com/SkiTemplar/ultron/main/bootstrap.ps1
#   pwsh -ExecutionPolicy Bypass -File ultron-bootstrap.ps1
#
# What it does (no git clone required):
#   1. Fetches the latest GitHub release for SkiTemplar/ultron.
#   2. Downloads the `ultron-system-<ver>.zip` asset and extracts to ~/.ultron.
#   3. Downloads the `ULTRON Control Center_<ver>_x64-setup.exe` installer.
#   4. Runs install.ps1 (which wires skills / agents / hooks / Qdrant).
#   5. Launches the Control Center installer interactively.
#
# Idempotent: re-running upgrades to the latest release. Local edits under
# ~/.ultron-vault and ~/.ultron/plans are preserved (the system ZIP only
# replaces tracked files).

[CmdletBinding()]
param(
    [string]$Repo = "SkiTemplar/ultron",
    [string]$InstallDir = "$env:USERPROFILE\.ultron",
    [switch]$SkipInstaller,
    [switch]$DryRun
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
    Write-Err "Failed to fetch latest release: $_"
    exit 2
}

$tag = $release.tag_name
Write-Step "Latest tag: $tag"

$systemAsset = $release.assets | Where-Object { $_.name -like "ultron-system-*.zip" } | Select-Object -First 1
$installerAsset = $release.assets | Where-Object { $_.name -like "*setup.exe" } | Select-Object -First 1

if (-not $systemAsset) {
    Write-Err "Release $tag does not include an ultron-system-*.zip asset. Cannot bootstrap."
    exit 3
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
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "install.ps1 exited with $LASTEXITCODE — check the log above."
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
        Write-Step "Launching installer (Windows SmartScreen may warn — click More info -> Run anyway)"
        Start-Process -FilePath $exePath -Wait
    }
}

Write-Host ""
Write-Host "[ULTRON-BOOT] Done. System at $InstallDir" -ForegroundColor Green
Write-Host "[ULTRON-BOOT] If you also installed the Control Center, launch it from the Start menu." -ForegroundColor Green
